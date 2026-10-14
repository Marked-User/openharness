/**
 * The user's private harness grid exists.
 *
 * Runs once, right after a successful sign-in hand-off — creating a grid is not something a daemon
 * should do on a timer. Everything here is best-effort by construction: a machine with no `grid`, an
 * old one, or a control plane having a bad minute must leave the harness sign-in itself untouched.
 *
 * **The name is not ours to invent.** It is minted and remembered by the backend, which is the only
 * party holding both inputs (the account's email and id) and the only one that can referee two
 * machines signing in at once. This module is handed the answer. See the plan's Change 7.
 *
 * **Every call is `--remote`.** Local mode is out of scope for the harness, and a one-shot override
 * is cheaper than depending on the mode a user may have switched for their own reasons —
 * `resolve_override` in autonomous-grid strips it from any position.
 */
import { gridExec, gridJson, gridVersion, meetsVersionFloor, GRID_VERSION_FLOOR } from './gridExec.js'

/** What `grid ls --json` answers: one row per grid the sign-in fetched. */
interface GridRow {
  grid?: unknown
  type?: unknown
  id?: unknown
}

/**
 * The network type for a grid that is one person's own machines.
 *
 * ⚠️ The name reads backwards and the mistake is expensive. "public" here means *not keyed to an
 * email domain*, NOT *open to anyone*: a `permissioned-public` grid admits exactly the accounts on
 * its allowlist roster, and `create_network` writes the creator one. The other choice,
 * `permissioned-providers`, is the OPEN-consumer type — it is the only type the denylist governs and
 * the only one billing switches on for. Picking it here would put a stranger's requests on the
 * user's own GPU and start charging for it.
 */
export const HARNESS_GRID_TYPE = 'permissioned-public'

export type EnsureStatus =
  /** The grid was not there and this machine created it. */
  | 'created'
  /** It was already there — the ordinary answer on every machine after the first. */
  | 'existed'
  /** A create failed, but the grid turned out to exist anyway: another machine won the race, or this
   *  create finished on the server after `grid` gave up waiting for it. */
  | 'adopted'
  /** Nothing was attempted. The harness sign-in is unaffected; `message` says why. */
  | 'skipped'
  /** The control plane refused the create for a reason only the person can change — the Free plan's
   *  grid limit. `message` is its own sentence (it says when a new grid becomes possible), and nothing
   *  retries it. */
  | 'refused'
  /** Something was attempted and did not work, after the retries. `message` carries grid's own words. */
  | 'failed'

export interface EnsureResult {
  status: EnsureStatus
  /** Empty when there is nothing a person would need to read. Never contains a credential. */
  message: string
}

const REMOTE = '--remote'

/**
 * The control plane's refusal code for an owner at their Free plan's grid limit — grid-apis
 * `handler.create_managed_network`'s 402, `{"detail": {"error_code": …, "message": …}}`. A wire value,
 * matched as written; the register row says what a rename costs (a refusal retried, then shown raw).
 */
export const FREE_NETWORK_LIMIT_CODE = 'free_network_limit'

/** How long to wait before each retry of a failed create: one per retry, so two retries. A create the
 *  control plane refused for a reason that can pass — a server low on memory, a restart — is asked again
 *  rather than reported at the first refusal. A create it did not answer is never asked again: its waits
 *  only look ([createAnswered]). Short, because a person is waiting on the answer. */
export const CREATE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000]

/** The public CLI's line for a control plane that answered with a refusal: `failed (<status>): <body>`
 *  (`remote/control_plane._raise`, the same contract [REFUSED_402] reads). */
const ANSWERED = /failed \((\d{3})\): /

/** A proxy in front of the control plane that stopped waiting answers these (nginx 504, Cloudflare 524).
 *  They are not the control plane's answer, so the create behind them may still be running. */
const GATEWAY_TIMEOUTS: ReadonlySet<number> = new Set([504, 524])

/**
 * Whether the control plane answered the create whose failed `grid start` printed `output`. Its create
 * route is synchronous and repairs a failed create before it answers, so an answer means that attempt is
 * over, and asking again cannot make a second grid. No answer — `grid`'s own timeout or "cannot reach",
 * this module's bound on `grid`, a gateway timeout, a create that succeeded but could not be saved here —
 * means it may still be running on the server, or done.
 */
function createAnswered(output: string): boolean {
  const status = ANSWERED.exec(output)?.[1]
  return status !== undefined && !GATEWAY_TIMEOUTS.has(Number(status))
}

/** The public CLI's line for a control plane that answered 402: `remote/control_plane._raise`, a
 *  contract in that repo (`cli/auth._SESSION_EXPIRED_RE` anchors on the same rendering). */
const REFUSED_402 = 'failed (402): '

/** The code, found in a body the CLI cut short (it keeps 400 characters of one) — so JSON cannot parse it. */
const QUOTA_CODE_IN_TEXT = new RegExp(`"error_code"\\s*:\\s*"${FREE_NETWORK_LIMIT_CODE}"`)

/** Said when the code is there but the CLI cut the sentence short (it keeps 400 characters of a body). */
const QUOTA_FALLBACK = 'Your Free plan’s grid limit is reached, so no new grid could be created. Upgrade, or try again later.'

/**
 * The control plane's own sentence when `output` — what a failed `grid start` printed — is the Free
 * plan's grid-limit refusal; null for anything else. Only the code decides: a 402 for another reason, or
 * the same code on another status, is not this.
 */
export function quotaRefusal(output: string): string | null {
  const line = output.split('\n').find((l) => l.includes(REFUSED_402))
  if (!line) return null
  const body = line.slice(line.indexOf(REFUSED_402) + REFUSED_402.length).trim()
  try {
    const detail = (JSON.parse(body) as { detail?: { error_code?: unknown; message?: unknown } }).detail
    if (detail?.error_code !== FREE_NETWORK_LIMIT_CODE) return null
    return typeof detail.message === 'string' && detail.message.trim() ? detail.message : QUOTA_FALLBACK
  } catch {
    return QUOTA_CODE_IN_TEXT.test(body) ? QUOTA_FALLBACK : null
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function rowNames(rows: GridRow[] | null): string[] {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => (typeof row.grid === 'string' ? row.grid : '')).filter(Boolean)
}

/** Does the account hold a grid by this name, as far as the locally stored registry knows? */
async function gridExists(name: string): Promise<boolean> {
  const { value } = await gridJson<GridRow[]>([REMOTE, 'ls'])
  return rowNames(value).includes(name)
}

/** Pull the account's grids, then look — the same two calls the first look makes, since `grid ls` alone
 *  reads a local registry that only a sync brings up to date. */
async function syncedExists(name: string): Promise<boolean> {
  await gridExec([REMOTE, 'sync'])
  return gridExists(name)
}

const ADOPTED: EnsureResult = { status: 'adopted', message: '' }

/**
 * What a failed create came to, or null when it is safe and worth asking again — after the wait, and only
 * once a last look has not found the grid.
 *
 * ⚠️ Every outcome LOOKS before it is believed: a create can fail and still have made the grid. Another
 * machine of this account may have won the race (the control plane refuses the duplicate name, in prose —
 * and `grid`'s own `--json` envelope documents `code` as null for that class), or this create may have
 * outlasted `grid` and finished on the server. So rather than parse the refusal: sync, look, and believe
 * what is there.
 */
async function afterFailedCreate(
  name: string,
  said: string,
  waits: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<EnsureResult | null> {
  const failed: EnsureResult = { status: 'failed', message: said.slice(0, 500) }

  // The Free plan's limit is the one refusal read for what it says: asking again cannot succeed (it is the
  // owner's plan, or a grid they deleted still counting), so it is shown, never retried — unless the grid
  // is there after all, which is then the very grid the quota counted.
  const refused = quotaRefusal(said)
  if (refused) return (await syncedExists(name)) ? ADOPTED : { status: 'refused', message: refused }

  // ⚠️ A create the control plane did not answer may still be running there, and it registers the grid
  // only at its very end, once the grid's server is up. Asked again, it could make a SECOND grid of the
  // same name (nothing on the control plane serializes two creates), so these waits only look.
  if (!createAnswered(said)) {
    if (await syncedExists(name)) return ADOPTED
    for (const wait of waits) {
      await sleep(wait)
      if (await syncedExists(name)) return ADOPTED
    }
    return failed
  }

  if (!waits.length) return (await syncedExists(name)) ? ADOPTED : failed
  await sleep(waits[0])
  // Right before asking again: a grid made in the wait is used, never created twice.
  return (await syncedExists(name)) ? ADOPTED : null
}

/**
 * Make sure `name` exists as a remote grid, and say what had to happen.
 *
 * @param name the backend-minted grid name; nothing here derives or guesses one.
 */
export async function ensureHarnessGrid(
  name: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<EnsureResult> {
  const sleep = opts.sleep ?? realSleep
  if (!name.trim()) return { status: 'skipped', message: 'No grid name was issued for this account.' }

  // Ask the version once, up front. Every failure below would otherwise have to guess whether it was
  // caused by an old binary, and "update grid" said once is worth more than three different refusals.
  const version = await gridVersion()
  if (!meetsVersionFloor(version)) {
    return {
      status: 'skipped',
      message: version
        ? `This machine's grid is ${version}; ${GRID_VERSION_FLOOR} or newer is needed. Update it and sign in again.`
        : 'No usable `grid` on this machine, so no harness grid was set up.',
    }
  }

  // Pull the account's grids before looking. `grid ls` reads a LOCAL registry and makes no network
  // call, so without this a machine that has not synced since another one created the grid sees
  // nothing and tries to create a second. Failure is not fatal — the create path below re-checks.
  await gridExec([REMOTE, 'sync'])

  if (await gridExists(name)) return { status: 'existed', message: '' }

  for (let retry = 0; ; retry++) {
    const created = await gridExec([REMOTE, 'start', name, '--type', HARNESS_GRID_TYPE])
    if (created.code === 'OK') {
      // ⚠️ Sync AGAIN, after the create. A grid that has just been made has no PER-GRID access token
      // in the local store yet — `grid info --env` answers "has no access token locally. Run `grid
      // login` to refresh your grids", and so does `grid join`. Measured on a real first-time create.
      // Without this the grid exists and is selectable while every use of it fails, which reads as a
      // broken feature rather than a missing refresh.
      await gridExec([REMOTE, 'sync'])
      return { status: 'created', message: '' }
    }
    const said = created.stderr.trim() || created.message
    const outcome = await afterFailedCreate(name, said, CREATE_RETRY_DELAYS_MS.slice(retry), sleep)
    if (outcome) return outcome
  }
}
