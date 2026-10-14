/** tmux process matching, runtime validation, pane capture, and input injection. */

import { execFile, spawn } from 'child_process'
import { existsSync } from 'node:fs'
import { basename } from 'path'
import { registry, type ProcessIdentity, type RegisteredSession } from './registry.js'
import { ENGINE_EXIT_PANE_OPTION } from './engineExitOption.js'
import { psEnv } from './childLocale.js'
import { neutralizePasteControls } from './pasteText.js'
import { patientDeadline, patientExec } from './patientExec.js'
import { inTmuxRoom } from './tmuxControlGate.js'
import { tmuxFeatures, type TmuxFeatures } from './tmuxVersion.js'
import { processIdentityOf, sameProcessIdentity } from './terminalRuntime.js'
import {
  enrichProcessRows,
  LSTART_MARKER_RE,
  processRows,
  processTreePids,
  selectEngineProcess,
  type ProcessRow,
} from './processTable.js'
export { captureTmuxPane, tmuxCaptureArgs } from './tmuxCapture.js'

// Every tmux and `ps` call here: a held event loop must not turn a timeout into an empty answer
// (patientExec.ts).
const run = patientExec(execFile)

function cleanPaneTitle(title: string): string | null {
  const cleaned = title
    .trim()
    .replace(/^[\s"'`*✳✱✲✴✶✷✸✹✺✻✼✽✾✿❃❉❋•·.-]+/, '')
    .trim()
    .slice(0, 80)
  return cleaned || null
}

/** Current tmux pane titles keyed by pane id. AI CLIs update this with their live session title. */
export function listPaneTitles(): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    run('tmux', ['list-panes', '-a', '-F', '#{pane_id}|#{pane_title}'], { timeout: 2000 }, (err, stdout) => {
      const titles = new Map<string, string>()
      if (err) { resolve(titles); return }
      for (const line of stdout.split('\n')) {
        const separator = line.indexOf('|')
        if (separator < 0) continue
        const pane = line.slice(0, separator)
        if (!/^%\d+$/.test(pane)) continue
        const title = cleanPaneTitle(line.slice(separator + 1))
        if (title) titles.set(pane, title)
      }
      resolve(titles)
    })
  })
}

/**
 * Whether tmux failed because no server is running on its socket: then it has no panes at all, which
 * is an answer, not a tmux that cannot be asked. tmux says it two ways (measured on 3.7c):
 *
 * - "no server running on <socket>": the socket file is there, with nothing listening on it.
 * - "error connecting to <socket> (No such file or directory)": the file is gone. This is what
 *   `kill-server`, a tmux crash and a reboot all leave.
 *
 * Only the first was recognised. After the server died, every pane read as "tmux unavailable", so no
 * agent was ever taken off and the apps showed dead agents as active until a new server happened to
 * start. A fresh machine also published a scary "tmux unavailable" before its first agent
 * (e2e/machine.e2e.ts). The socket file is checked too, so a translated message still counts. Any
 * other failure (a timeout, "Permission denied") still says nothing either way.
 */
export function isNoTmuxServerError(error: string): boolean {
  if (/no server running on\s+\S+/i.test(error)) return true
  const connecting = /error connecting to (.+) \(([^)]*)\)\s*$/im.exec(error)
  if (!connecting) return false
  return /no such file or directory/i.test(connecting[2]) || !existsSync(connecting[1])
}

/** The tmux server the last inventory was read from (`rememberTmuxServer`); null until one was. */
let knownServer: number | null = null

/**
 * Whether `pid` is a running tmux server: never a pid since reused by something else. macOS names it by
 * its executable (`/opt/homebrew/bin/tmux`). Linux names it as tmux names itself, `tmux: server`
 * (`prctl(PR_SET_NAME)` in tmux's compat/setproctitle.c), so a check for `tmux` alone never revived a
 * socket on Linux, where systemd-tmpfiles is the cleaner that removes it. A client (`tmux: client`) is
 * not the server.
 */
function isTmuxProcess(pid: number): Promise<boolean> {
  try { process.kill(pid, 0) } catch { return Promise.resolve(false) }
  return new Promise((resolve) => {
    run('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 2_000, env: psEnv() }, (err, stdout) => {
      const name = basename(String(stdout ?? '').trim())
      resolve(!err && (name === 'tmux' || name === 'tmux: server'))
    })
  })
}

/**
 * Note which server answered, after an inventory read from it. Asked of tmux only while unknown or
 * gone, so a steady daemon spends one `kill(pid, 0)` an inventory on it.
 */
export async function rememberTmuxServer(): Promise<void> {
  if (knownServer !== null) {
    try { process.kill(knownServer, 0); return } catch { knownServer = null }
  }
  await new Promise<void>((resolve) => {
    run('tmux', ['display-message', '-p', '#{pid}'], { timeout: 2_000 }, (err, stdout) => {
      const pid = Number(String(stdout ?? '').trim())
      if (!err && Number.isSafeInteger(pid) && pid > 0) knownServer = pid
      resolve()
    })
  })
}

/**
 * ⚠️ "No server" is also what tmux says when its socket was removed from under a server that still runs
 * every agent: a cleaner of /tmp (systemd-tmpfiles ages entries out after ten days) does that to a
 * daemon that runs for weeks. Taken for a dead server, every live agent read as stopped within 25 s
 * (e2e/tmuxsocket.e2e.ts), and resuming them would have started each engine a second time beside
 * itself. tmux makes its socket again on SIGUSR1 (tmux(1)), so the server last read from is asked to,
 * when it is still a running tmux. True when it was asked: the caller reads again, once.
 */
export async function reviveRemovedTmuxSocket(): Promise<boolean> {
  const pid = knownServer
  if (pid === null || !(await isTmuxProcess(pid))) return false
  try { process.kill(pid, 'SIGUSR1') } catch { return false }
  // tmux makes the socket when it handles the signal, on its next turn of its loop.
  await new Promise((resolve) => setTimeout(resolve, 200))
  console.log(`[terminal] tmux's socket was removed while its server (pid ${pid}) still ran — asked it to make a new one`)
  return true
}

/** Test seam. */
export function forgetTmuxServer(): void { knownServer = null }

/**
 * The pane's root pid; `'missing'` when tmux answered that it has no such pane, or that no server is
 * running (then no pane is); null when tmux could not be asked (a timeout, a socket it cannot reach),
 * which says nothing about the pane. tmux 3.7 answers `display-message -t` for an unknown pane with an
 * empty line and exit 0; older versions say "can't find pane".
 */
function panePidLookup(pane: string, revived = false): Promise<number | 'missing' | null> {
  return new Promise((resolve) => {
    run('tmux', ['display-message', '-p', '-t', pane, '#{pane_pid}'], { timeout: 2000 }, (err, stdout, stderr) => {
      const text = String(stdout ?? '').trim()
      const pid = Number(text)
      if (!err && Number.isSafeInteger(pid) && pid > 0) resolve(pid)
      // A pane tmux does not know is an empty LINE: tmux always ends its answer with a newline, and no
      // bytes at all is an answer that was lost (patientExec.ts), never "no such pane".
      else if (!err && text === '' && String(stdout ?? '') !== '') resolve('missing')
      else if (err && /can't find pane/.test(String(stderr ?? ''))) resolve('missing')
      else if (err && isNoTmuxServerError(String(stderr ?? ''))) {
        // A server whose socket was removed is still running this pane: ask it back, then read again.
        if (revived) { resolve('missing'); return }
        void reviveRemovedTmuxSocket().then((asked) => { if (asked) void panePidLookup(pane, true).then(resolve); else resolve('missing') })
      } else resolve(null)
    })
  })
}

async function panePid(pane: string): Promise<number | null> {
  const found = await panePidLookup(pane)
  return typeof found === 'number' ? found : null
}

/**
 * Resolve the stable CLI process below one tmux pane, ahead of short-lived helper descendants — and say
 * whether a negative answer means "nothing is running there" or "the probe itself failed". Those are not
 * the same fact: `tmux display-message` and `ps` are subprocesses with 2-3s timeouts, and treating a
 * timeout as proof of death evicts a live session.
 */
type PaneProcessLookup =
  | { ok: true; identity: ProcessIdentity }
  | { ok: false; unknown: boolean; reason: string }

export async function lookupPaneEngineProcess(
  pane: string,
  engine: RegisteredSession['engine'],
): Promise<PaneProcessLookup> {
  const rootPid = await panePidLookup(pane)
  // tmux saying it has no such pane is an answer: the pane is gone. The reconciler asks exactly when a
  // pane has dropped out of `tmux list-panes`, and reading that as "could not ask" kept an agent whose
  // pane was killed counted as active for good. A failed call is still no evidence either way.
  if (rootPid === 'missing') return { ok: false, unknown: false, reason: `tmux has no pane ${pane}` }
  if (!rootPid) return { ok: false, unknown: true, reason: `tmux could not resolve pane ${pane}` }
  const rows = await processRows()
  if (!rows) return { ok: false, unknown: true, reason: 'the process table could not be read' }
  const enrichedRows = await enrichProcessRows(rows, processTreePids(rows, [rootPid]))
  const process = selectEngineProcess(enrichedRows, rootPid, engine)
  if (!process) return { ok: false, unknown: false, reason: `no ${engine} process under pane ${pane}` }
  return {
    ok: true,
    identity: processIdentityOf(process),
  }
}

/**
 * The pane's OWN process — whatever is sitting there, engine or not.
 *
 * [resolvePaneEngineProcess] answers "is the engine running here yet", which during an install is
 * deliberately no: the pane is running the user's shell, and the shell is running `npm`. This one
 * answers "what is running here", so an agent can be registered for a pane whose engine has not
 * started — the record the terminal tile attaches to while the install scrolls past.
 *
 * The identity is a placeholder by design, and a SHORT-LIVED one. When the engine finally execs,
 * discovery registers it against the same pane and the registry adopts the record in place — see the
 * `routeAgent` branch in `registry.ts`, which matches on the terminal route precisely while an agent
 * has no engine session bound yet. The agentId therefore survives, and so does the tile.
 */
export async function resolvePaneRootProcess(pane: string): Promise<ProcessIdentity | null> {
  const rootPid = await panePid(pane)
  if (!rootPid) return null
  const rows = await processRows()
  if (!rows) return null
  const row = rows.find((candidate) => candidate.pid === rootPid)
  if (!row) return null
  return processIdentityOf(row)
}

/**
 * Every process under a pane, shallowest first — the answer to "then WHAT was running?".
 *
 * `selectEngineProcess` returning null says only that nothing matched the engine, which is the least
 * useful half of the finding. The processes it walked past are what identify an install layout the
 * matcher does not cover, or a launcher that has not exec'd the engine yet, and reading them off the
 * failing machine is exactly what a person diagnosing a remote New Agent failure cannot do.
 */
export async function tmuxPaneProcessTree(
  pane: string,
  limit = 4,
): Promise<Array<{ executable: string; args: string }>> {
  const rootPid = await panePid(pane)
  if (!rootPid) return []
  const rows = await processRows()
  if (!rows) return []
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.parentPid) ?? []
    list.push(row)
    children.set(row.parentPid, list)
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const found: Array<{ executable: string; args: string }> = []
  const queue = [rootPid]
  // Breadth-first for the same reason `selectEngineProcess` is: the shallowest processes are the
  // launch chain, and a deep child is the least likely to explain the failure.
  while (queue.length && found.length < limit) {
    const pid = queue.shift()!
    const row = byPid.get(pid)
    if (row) found.push({ executable: row.executable, args: row.args })
    for (const child of children.get(pid) ?? []) queue.push(child.pid)
  }
  return found
}

/** Boolean form for callers that only need "is it there". */
export async function resolvePaneEngineProcess(
  pane: string,
  engine: RegisteredSession['engine'],
): Promise<ProcessIdentity | null> {
  const found = await lookupPaneEngineProcess(pane, engine)
  return found.ok ? found.identity : null
}

/**
 * The same check, but three-valued and with a reason — the reaper needs both.
 *
 * `unknown` exists because a failed probe is not evidence of death. The reaper already refuses to evict
 * when `tmux list-panes` fails; the per-session probes (`tmux display-message`, `ps`) deserve exactly the
 * same treatment, and did not get it: a live Command Code pane was dropped with "no commandcode process
 * under pane %3" 14s after attaching, while that process was demonstrably running — still alive minutes
 * later, and matched by this very resolver run by hand. The eviction landed 3.6s into a 5s tick, i.e.
 * `ps` had hit its 3s timeout during the load spike of a freshly started daemon warming its pools.
 *
 * The reason string matters just as much. "process for pane %3 gone" read identically whether the user
 * had quit the CLI or the adapter had simply lost sight of it, and telling those apart after the fact
 * means reconstructing a process table that no longer exists.
 */
export type RuntimeCheck =
  | { state: 'alive' }
  | { state: 'gone'; reason: string }
  | { state: 'unknown'; reason: string }

export async function checkSessionRuntime(session: RegisteredSession): Promise<RuntimeCheck> {
  const found = await lookupPaneEngineProcess(session.tmuxPane, session.engine)
  if (!found.ok) return { state: found.unknown ? 'unknown' : 'gone', reason: found.reason }
  const live = found.identity
  const saved = session.processIdentity
  // A persisted identity whose startMarker is not a C-locale lstart stamp was written either by the
  // pre-fix parser (see parseProcessRow), with its fields shifted, or by a `ps` that still inherited the
  // user's LC_TIME (see psEnv). Either way it can NEVER match the corrected ones again. Adopt the
  // corrected identity instead of failing: the pane still has a matching engine process, and failing here
  // would drop a live session for good (Command Code, the only engine affected, does not re-register on
  // its Stop hook). One-time, per session.
  if (saved && !LSTART_MARKER_RE.test(saved.startMarker)) {
    registry.updateProcessIdentity(session.sessionId, live)
    return { state: 'alive' }
  }
  // pid + start time IS the identity of a process, and neither can change under it — that is the whole
  // PID-reuse guard. `executable` is argv-derived and therefore mutable (Command Code rewrites its own
  // argv to `⌘ <session title>` and renames the session mid-life), so it is recorded but not compared:
  // comparing it evicted live panes for renaming themselves.
  if (saved && !sameProcessIdentity(saved, live)) {
    return {
      state: 'gone',
      reason: `process changed under pane ${session.tmuxPane}`
        + ` (was pid ${saved.pid} @ ${saved.startMarker}, now pid ${live.pid} @ ${live.startMarker})`,
    }
  }
  if (!saved) registry.updateProcessIdentity(session.sessionId, live)
  return { state: 'alive' }
}

// Short single-line messages need no settling delay, but still need bracketed-paste boundaries:
// Codex treats Enter immediately after an unbracketed text burst as a pasted newline, not submit.
const INJECT_FASTPATH_MAXLEN = 500
// Base settle time before the submit Enter; grows with length (Claude needs time to ingest a big paste
// and collapse it to `[Pasted text]` before a clean Enter counts as submit rather than paste content).
const INJECT_PASTE_DELAY_BASE_MS = 400
// A NAMED tmux buffer so we never clobber the user's default paste buffer; `-d` deletes it after paste.
let injectBufferSequence = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function tmuxEnter(pane: string): Promise<boolean> {
  return new Promise((resolve) => {
    run('tmux', ['send-keys', '-t', pane, 'Enter'], { timeout: 2000 }, (err) => {
      if (err) console.error(`[tmux] Enter to ${pane} failed:`, err.message)
      resolve(!err)
    })
  })
}

/**
 * How long a buffer may take to load before the paste is given up. A tmux client waits as long as its
 * server does not answer, and this one runs in the gate's notify room (tmuxControlGate.ts): unbounded, it
 * held every terminal open, session made or killed, and terminal closed behind it for as long. The other
 * tmux commands here get 2 s; this one also carries the text over stdin.
 */
export const LOAD_BUFFER_TIMEOUT_MS = 5_000

/** Stage text in a NAMED tmux buffer via stdin (avoids arg-length limits + the user's default buffer). */
function tmuxLoadBuffer(name: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let cancel = (): void => {}
    const settle = (loaded: boolean): void => {
      if (settled) return
      settled = true
      cancel()
      resolve(loaded)
    }
    const c = spawn('tmux', ['load-buffer', '-b', name, '-'])
    // Answered without waiting for its pipes to close: a client killed here may leave one open behind it.
    cancel = patientDeadline(LOAD_BUFFER_TIMEOUT_MS, () => {
      c.kill('SIGKILL')
      settle(false)
    })
    c.on('error', () => settle(false))
    c.on('close', (code) => settle(code === 0))
    c.stdin.on('error', () => { /* EPIPE if tmux died first — 'close' still resolves false */ })
    c.stdin.end(content)
  })
}

/**
 * Session-scoped (no `-g`) so this never touches tmux mouse behavior outside sessions this app
 * created — `-t` resolves a pane id up to its session's option table. Without this, scrolling over a
 * program in the alternate screen buffer (Claude Code's own TUI, most chat CLIs) is forwarded to
 * that program as raw wheel/arrow-key bytes instead of being caught by tmux, which mostly has no
 * binding for it — scrolling silently does nothing. Idempotent and best-effort: safe to call on
 * every discovery scan, including for a pane whose mouse option is already on.
 */
export function setPaneMouseOn(pane: string): Promise<void> {
  return new Promise((resolve) => {
    run('tmux', ['set-option', '-t', pane, 'mouse', 'on'], { timeout: 2_000 }, () => resolve())
  })
}

/**
 * Where an option Harness keeps for one of its panes lives: on the pane, where tmux has pane options
 * (3.0), so it goes with the pane into any window the person moves it to and touches nothing else
 * there; on the window before that, which is the agent's own for as long as the person leaves it be.
 * A window option on a pane the person had joined into a window of their own changed their panes too,
 * and a `-p` on tmux 2.x is a usage error that, chained into `new-session`, failed every agent create
 * (PR #789's review). Never `-g`: the daemon shares the person's tmux server.
 */
export function paneOptionScope(features: Pick<TmuxFeatures, 'paneOptions'>): '-p' | '-w' {
  return features.paneOptions ? '-p' : '-w'
}

/**
 * The tmux command that gives one pane [style] (see `hostTheme.ts`), aimed at [pane] or, without one,
 * at the pane a command list just made. The pane's own `window-style` from tmux 3.0; before that
 * `select-pane -P`, the style tmux 2.x kept for each pane. Never the window's: an agent pane the
 * person had moved into a window of their own repainted their shells there in Harness's colours on
 * every scan (PR #789's review, e2e/tmuxmoves.e2e.ts).
 */
export function paneStyleArgs(features: Pick<TmuxFeatures, 'paneOptions'>, style: string, pane?: string): string[] {
  const target = pane ? ['-t', pane] : []
  return features.paneOptions
    ? ['set-option', '-p', ...target, 'window-style', style]
    : ['select-pane', ...target, '-P', style]
}

/**
 * The colours tmux reports to a program in the pane that asks (`OSC 10;?`/`OSC 11;?`) — see
 * `hostTheme.ts` for why a TUI's palette depends on it. Pane-scoped (`paneStyleArgs`), never the
 * window's and never `-g`: the daemon shares the user's default tmux server and must not restyle
 * panes it did not create. Best-effort and idempotent, like [setPaneMouseOn].
 */
export async function setPaneStyle(pane: string, style: string): Promise<boolean> {
  const features = await tmuxFeatures()
  return new Promise((resolve) => {
    run('tmux', paneStyleArgs(features, style, pane), { timeout: 2_000 }, (error) => resolve(!error))
  })
}

/** What tmux knows about a pane right now. See `agentCreateDiagnosis.ts` for why this is read. */
export { ENGINE_EXIT_PANE_OPTION }

export interface TmuxPaneState {
  dead: boolean
  /** Exit status once the process is gone; null while it is still running. */
  exitStatus: number | null
  command: string
  /** The engine's exit status once its launch wrapper handed the pane to a shell; null before. */
  engineExit: number | null
}

/**
 * What tmux said about a pane: its state, `'gone'`, or `'unknown'`.
 *
 * `'gone'` when tmux does not know the pane, or no server is running: the process exited and took its
 * window (and, for a one-pane session, the session) with it. `'unknown'` when tmux could not be asked
 * (a timeout, a socket it may not use), which says nothing about the pane, and a caller acts on
 * `'gone'` only. The two used to be one null. A core whose event loop was held for a few seconds wakes
 * to every timer that came due before it reads the answers that arrived meanwhile, so a call in flight
 * times out with its answer sitting unread, and the null read as "gone" failed restored agents,
 * relaunched a resumed engine fresh over its conversation, and stopped a new agent's watcher
 * (e2e/stall.e2e.ts).
 */
export type TmuxPaneRead = TmuxPaneState | 'gone' | 'unknown'

/** Pane liveness plus, for a pane kept alive by `remain-on-exit`, how its process ended (see TmuxPaneRead). */
export function tmuxPaneState(pane: string): Promise<TmuxPaneRead> {
  return readPaneState(pane, false)
}

function readPaneState(pane: string, revived: boolean): Promise<TmuxPaneRead> {
  return new Promise((resolve) => {
    const format = `#{pane_dead}|#{pane_dead_status}|#{${ENGINE_EXIT_PANE_OPTION}}|#{pane_current_command}`
    run('tmux', ['display-message', '-p', '-t', pane, format], { timeout: 2_000 }, (err, stdout, stderr) => {
      if (err) {
        const said = String(stderr ?? '')
        if (/can't find pane/.test(said)) { resolve('gone'); return }
        if (!isNoTmuxServerError(said)) { resolve('unknown'); return }
        // A server whose socket was removed is still running this pane: ask it back, then read again.
        if (revived) { resolve('gone'); return }
        void reviveRemovedTmuxSocket().then((asked) => {
          if (asked) void readPaneState(pane, true).then(resolve)
          else resolve('gone')
        })
        return
      }
      const fields = String(stdout ?? '').trim().split('|')
      // Not the four fields asked for (no bytes at all is an answer that was lost): nothing to go on.
      if (fields.length < 4) { resolve('unknown'); return }
      // tmux 3.7 answers a pane it does not know with the four fields empty and exit 0; a pane it knows
      // is dead or not, 1 or 0. Older versions say "can't find pane", above.
      if (fields[0] === '') { resolve('gone'); return }
      const status = Number(fields[1])
      const engineExit = Number(fields[2])
      resolve({
        dead: fields[0] === '1',
        exitStatus: fields[1] !== '' && Number.isSafeInteger(status) ? status : null,
        engineExit: fields[2] !== '' && Number.isSafeInteger(engineExit) ? engineExit : null,
        // A command name cannot contain `|`, but rejoining costs nothing and keeps a surprising
        // one from silently truncating the field.
        command: fields.slice(3).join('|'),
      })
    })
  })
}

/** What a pane is running and where, as tmux knows it (terminal clients' #{pane_current_*}). */
export interface TmuxPaneInfo { command: string; path: string; pid: number | null; tty: string }

/**
 * The foreground command, live working directory, pid and tty of a pane — tmux's
 * `#{pane_current_command}` and `#{pane_current_path}`, which a terminal client (hn) shows and a
 * vim-tmux-navigator style check asks. Null when tmux does not know the pane.
 */
export function tmuxPaneInfo(pane: string, socket?: string): Promise<TmuxPaneInfo | null> {
  return new Promise((resolve) => {
    // A path can hold any character but a newline; the command, pid and tty cannot hold one either.
    const format = '#{pane_current_command}\n#{pane_pid}\n#{pane_tty}\n#{pane_current_path}'
    // `socket` names a server outright (tests pass their own); without it, the daemon's server.
    const args = [...(socket ? ['-S', socket] : []), 'display-message', '-p', '-t', pane, format]
    run('tmux', args, { timeout: 2_000 }, (err, stdout) => {
      if (err) { resolve(null); return }
      const [command = '', pid = '', tty = '', ...path] = stdout.replace(/\n$/, '').split('\n')
      const n = Number(pid)
      // tmux 3.5 answers a pane it does not know with empty fields rather than an error.
      if (pid === '' || !Number.isSafeInteger(n)) { resolve(null); return }
      resolve({ command, path: path.join('\n'), pid: n, tty })
    })
  })
}

/**
 * Hand a pane back to tmux's default disposal after `create()` asked tmux to keep it when dead.
 *
 * Called as soon as a created pane becomes a real agent: from then on it must vanish when its engine
 * exits, exactly like a pane the user started themselves, rather than lingering as a dead pane.
 */
export async function clearPaneRemainOnExit(pane: string, current?: () => boolean): Promise<void> {
  // The pane's own option where tmux has one (`paneOptionScope`): restarting an agent the person had
  // moved into a window of their own must not switch remain-on-exit off for their panes there.
  const scope = paneOptionScope(await tmuxFeatures())
  if (current?.() === false) return
  return new Promise((resolve) => {
    run('tmux', ['set-option', scope, '-t', pane, 'remain-on-exit', 'off'], { timeout: 2_000 }, () => resolve())
  })
}

function tmuxDeleteBuffer(name: string): Promise<void> {
  return new Promise((resolve) => {
    run('tmux', ['delete-buffer', '-b', name], { timeout: 2_000 }, () => resolve())
  })
}

/** Paste text from a uniquely named stdin-loaded buffer so its bytes never enter argv or errors. A
 *  bracketed paste carries text and nothing else (pasteText.ts), not even its own end marker; an
 *  unbracketed one is typing, and is typed as it was given.
 *
 *  A buffer set and deleted is a notification to every control client, which on a tmux before 3.7
 *  crashed the server while one was attaching: the paste waits for none to be (tmuxControlGate.ts). */
function tmuxPasteText(pane: string, content: string, bracketed: boolean, allowed?: () => boolean): Promise<boolean> {
  return inTmuxRoom('notify', () => pasteThroughBuffer(pane, content, bracketed, allowed))
}

async function pasteThroughBuffer(pane: string, content: string, bracketed: boolean, allowed?: () => boolean): Promise<boolean> {
  if (allowed && !allowed()) return false
  const bufferName = `machinemsg-${process.pid}-${++injectBufferSequence}`
  if (!(await tmuxLoadBuffer(bufferName, bracketed ? neutralizePasteControls(content) : content))) {
    await tmuxDeleteBuffer(bufferName)
    console.error(`[tmux] load-buffer for ${pane} failed`)
    return false
  }
  if (allowed && !allowed()) { await tmuxDeleteBuffer(bufferName); return false }
  const args = ['paste-buffer', '-t', pane, '-b', bufferName]
  if (bracketed) args.push('-p')
  args.push('-d')
  const pasted = await new Promise<boolean>((resolve) => {
    run('tmux', args, { timeout: 2_000 }, (err) => {
      if (err) console.error(`[tmux] paste-buffer to ${pane} failed:`, err.message)
      resolve(!err)
    })
  })
  if (!pasted) await tmuxDeleteBuffer(bufferName)
  return pasted
}

/**
 * Type a message into a tmux pane and submit it — the web-chat/device → terminal injection point.
 *
 * All text is loaded into a uniquely named tmux buffer over stdin so prompt bytes never enter argv,
 * environment, logs, or child-process error strings. Every message is bracketed-pasted as one unit
 * (`paste-buffer -p`) so the terminal can distinguish the paste from the separate submit Enter.
 * Short single-line input is submitted immediately after that explicit paste boundary.
 *
 * Long/multiline input is allowed to settle before Enter. (Verified: reliably submits up to ~28 KB.)
 *
 * `beforeEnter` is asked once the text is in, right before the Enter: a reason it gives keeps the Enter
 * from being pressed, and comes back as `{ withheld }`, the text left typed. An engine can open a dialog
 * in that gap, mid-turn, and the Enter would answer it.
 */
export function sendToTmux(pane: string, text: string, beforeEnter?: () => Promise<string | null>, allowed?: () => boolean): Promise<boolean | { withheld: string }> {
  const content = text.replace(/[\r\n]+$/, '') // strip trailing newlines so the submit Enter isn't doubled
  return (async () => {
    const needsSettle = content.length > INJECT_FASTPATH_MAXLEN || /[\r\n]/.test(content)
    if (!(await tmuxPasteText(pane, content, true, allowed))) return false
    if (needsSettle) await sleep(Math.min(1500, INJECT_PASTE_DELAY_BASE_MS + Math.floor(content.length / 60)))
    const withheld = beforeEnter ? await beforeEnter() : null
    if (withheld) return { withheld }
    if (allowed && !allowed()) return { withheld: 'terminal control revoked' }
    return tmuxEnter(pane)
  })()
}

/** Send a control key (e.g. 'C-c' to interrupt) to a pane. */
/**
 * Type text into a pane WITHOUT submitting it. Needed by filter boxes that act on every keystroke: pi's
 * settings list opens a row as soon as the filter narrows to one, so the Enter `sendToTmux` appends would
 * land on the row that just opened and pick whatever was already highlighted.
 */
export function sendLiteralToTmux(pane: string, text: string): Promise<boolean> {
  return tmuxPasteText(pane, text, false)
}

/**
 * Dump a live terminal stream's clipboard paste into a pane as ONE bracketed paste, no submit.
 *
 * The desktop app's raw keyboard/paste path used to run a large clipboard paste through the same
 * byte-oriented pipeline as ordinary typing (`TerminalStreamHandle.writeRaw`), which chunks at
 * `INPUT_CHUNK_BYTES` to stay under tmux's `send-keys -H` command-line length — and each chunk landed
 * in the pane far enough apart that the engine's own paste-detector (readline/Ink) registered it as a
 * separate paste, producing dozens of `[Pasted text #N]` markers for what was one clipboard paste.
 * `tmuxPasteText`'s stdin-loaded buffer has no such length limit, so it is the same single-shot
 * mechanism `sendToTmux` already uses for composer messages — just without the trailing Enter, since a
 * paste into a live terminal must not auto-submit.
 */
export function pasteRawIntoTmux(pane: string, text: string): Promise<boolean> {
  return tmuxPasteText(pane, text, true)
}

export function sendKeyToTmux(pane: string, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    run('tmux', ['send-keys', '-t', pane, key], { timeout: 2000 }, (err) => resolve(!err))
  })
}
