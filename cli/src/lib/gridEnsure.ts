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
  /** A create failed, but the grid turned out to exist anyway: another machine won the race. */
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

/** How long to wait before each retry of a failed create: one per retry, so two retries. A create that
 *  fails for a reason that can pass — a server low on memory, a restart, a network blip — is asked again
 *  rather than reported at the first refusal. Short, because a person is waiting on the answer. */
export const CREATE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000]

/** The public CLI's line for a control plane that answered 402: `remote/control_plane._raise`, a
 *  contract in that repo (`cli/auth._SESSION_EXPIRED_RE` anchors on the same rendering). */
const REFUSED_402 = 'failed (402): '

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
    return new RegExp(`"error_code"\\s*:\\s*"${FREE_NETWORK_LIMIT_CODE}"`).test(body) ? QUOTA_FALLBACK : null
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

    // The Free plan's limit is the one refusal read for what it says: asking again cannot succeed (it is
    // the owner's plan, or a grid they deleted still counting), so it is shown, never retried.
    const refused = quotaRefusal(said)
    if (refused) return { status: 'refused', message: refused }

    // A create can fail because another machine created it first — grid names are globally unique and
    // the control plane rejects a duplicate. Rather than parse that refusal (grid's own `--json` error
    // envelope documents `code` as null for exactly this class, and its message is prose), ask the
    // question again: sync, look, and believe what is there. Correct however the refusal is encoded.
    await gridExec([REMOTE, 'sync'])
    if (await gridExists(name)) return { status: 'adopted', message: '' }

    if (retry >= CREATE_RETRY_DELAYS_MS.length) return { status: 'failed', message: said.slice(0, 500) }
    await sleep(CREATE_RETRY_DELAYS_MS[retry])
  }
}
