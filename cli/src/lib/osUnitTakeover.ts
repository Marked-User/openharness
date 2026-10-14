/**
 * Harness OS: the agent runtime is harness-daemon.service's (platformDaemon.ts osDaemonUnit). A CLI from
 * before that rule, the one an image ships for its welcome screen, starts a daemon of its own at sign-in,
 * detached, outside the unit. It holds the data folder and the port, so after an update the unit's
 * daemon found them taken and exited, again and again (230 restarts on an Orange Pi, 2026-10-13), the old
 * runtime went on serving, and the update never took effect.
 *
 * Started by the unit, the daemon takes the runtime back first: one serving from outside the unit is
 * stopped (the agents in tmux outlive it, as they outlive `harness stop`), and start-up goes on. A daemon
 * inside the unit, the core of the unit's previous run, is left to refuseServedDataFolder's orphan wait.
 */
import { readFileSync } from 'node:fs'

const UNIT = /\/harness-daemon\.service(\/|$)/m
export const TAKEOVER_WAIT_MS = 30_000
const POLL_MS = 250

export type RuntimeServer = { pid: number, corePid: number } | 'none' | 'unknown'

export interface TakeoverDeps {
  /** Who serves the agent runtime: the data folder's socket, else the port's `/api/status`. */
  who(): Promise<RuntimeServer>
  /** A process's `/proc/<pid>/cgroup`, or null when it cannot be read. */
  cgroupOf(pid: number | 'self'): string | null
  alive(pid: number): boolean
  signal(pid: number, signal: NodeJS.Signals): void
  sleep(ms: number): Promise<void>
  now(): number
  log(line: string): void
}

/** Whether a `/proc/<pid>/cgroup` is harness-daemon.service's. */
export function inUnit(cgroup: string): boolean {
  return UNIT.test(cgroup)
}

/**
 * Stop a daemon serving the runtime from outside harness-daemon.service when this process is the unit's.
 * `none`: nothing to do (not the unit, nothing serving, or the unit's own). `stopped`: one was stopped.
 */
export async function takeRuntimeBack(deps: TakeoverDeps, waitMs = TAKEOVER_WAIT_MS): Promise<'none' | 'stopped'> {
  const own = deps.cgroupOf('self')
  if (own === null || !inUnit(own)) return 'none'
  const server = await deps.who()
  if (typeof server !== 'object') return 'none'
  const theirs = deps.cgroupOf(server.pid)
  // Unreadable is gone, or another user's: either way not ours to stop.
  if (theirs === null || inUnit(theirs)) return 'none'
  const pids = [...new Set([server.pid, server.corePid])]
  deps.log(`[cli] a daemon started outside harness-daemon.service (pid ${server.pid}) serves the agent runtime — stopping it so this one runs`)
  for (const pid of pids) { try { deps.signal(pid, 'SIGTERM') } catch { /* already gone */ } }
  const deadline = deps.now() + waitMs
  while (pids.some((pid) => deps.alive(pid))) {
    if (deps.now() >= deadline) {
      deps.log(`[cli] it did not stop within ${Math.round(waitMs / 1000)}s — ending it`)
      for (const pid of pids) { try { deps.signal(pid, 'SIGKILL') } catch { /* already gone */ } }
      break
    }
    await deps.sleep(POLL_MS)
  }
  return 'stopped'
}

/** Ask a daemon's loopback port who it is, as the OS updater does: every release answers there. */
export async function askRuntimePort(port: string | number, timeoutMs = 1_000): Promise<RuntimeServer> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(timeoutMs) })
    const status = await response.json() as { pid?: unknown, corePid?: unknown }
    const pid = Number(status.pid)
    const corePid = status.corePid === undefined ? pid : Number(status.corePid)
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(corePid) && corePid > 0 ? { pid, corePid } : 'unknown'
  } catch {
    return 'none'
  }
}

export function readCgroup(pid: number | 'self'): string | null {
  try { return readFileSync(`/proc/${pid}/cgroup`, 'utf8') } catch { return null }
}
