/**
 * Finding `harness-pty`, finding the host it started (its discovery file), and starting one when
 * there is none. In production harnessd keeps the host running (sub-project B); this is how the
 * daemon gets one without it, in development and tests.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'
import { scrubTerminalContext } from '../terminalEnvironment.js'
import { PtyHostClient, type PtyHostDiscovery } from './client.js'
import { PTY_PROTOCOL } from './protocol.js'

const BINARY = process.platform === 'win32' ? 'harness-pty.exe' : 'harness-pty'
/** How long a host we started has to publish its discovery file. */
const START_WAIT_MS = 5_000
const POLL_MS = 25
/** How long a connection may take to be accepted: as long as `PtyHostClient.connect` gives a hello. */
const CONNECT_TIMEOUT_MS = 5_000

function runnable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  // `1.0` and `1.0.0` are the same version; order them anyway so readdir's order cannot pick.
  return a.length - b.length
}

export interface PtyHostBinaryOptions {
  env?: NodeJS.ProcessEnv
  runtimeDir?: string
  /** The bundle's own directory (`dist/` in a release). */
  besideDir?: string
}

/**
 * The `harness-pty` to start, or null when there is none:
 * 1. `HARNESS_PTY_BIN`, as it is (a wrong override should fail loudly, not fall back);
 * 2. the newest `<runtime>/pty/<version>/harness-pty[.exe]`. Binaries install per version because
 *    Windows cannot overwrite a running .exe (spec §4, host upgrade), and the newest is the one a
 *    new host should run; older ones stay for the hosts still draining on them;
 * 3. beside the bundle, where `build-bundle.mjs` puts it for local Windows testing.
 */
export function ptyHostBinary(options: PtyHostBinaryOptions = {}): string | null {
  const override = (options.env ?? process.env).HARNESS_PTY_BIN?.trim()
  if (override) return override
  const root = path.join(options.runtimeDir ?? env.ADAPTER_RUNTIME_DIR, 'pty')
  let versions: string[] = []
  try {
    versions = readdirSync(root).filter(name => /^\d+(\.\d+)*$/.test(name)).sort(compareVersions).reverse()
  } catch {
    // No managed host installed.
  }
  for (const version of versions) {
    const file = path.join(root, version, BINARY)
    if (runnable(file)) return file
  }
  const beside = path.join(options.besideDir ?? path.dirname(fileURLToPath(import.meta.url)), BINARY)
  return runnable(beside) ? beside : null
}

/** `<home>/run/pty-host-<protocol>.json`, or null when it is missing or not a discovery file. */
export function readDiscovery(home: string, protocol: number): PtyHostDiscovery | null {
  try {
    const value = JSON.parse(readFileSync(path.join(home, 'run', `pty-host-${protocol}.json`), 'utf8'))
    if (
      value && typeof value === 'object'
      && value.protocol === protocol
      && typeof value.instance === 'string'
      && typeof value.endpoint === 'string'
      && typeof value.pid === 'number'
      && typeof value.version === 'string'
      && typeof value.token === 'string'
    ) {
      const { instance, endpoint, pid, version, token } = value
      return { protocol, instance, endpoint, pid, version, token }
    }
  } catch {
    // Missing, or caught mid-way by a reader that is not atomic: the caller looks again.
  }
  return null
}

export type PtyHostUnavailable = { unavailable: string; code: 'PTY_HOST_UNAVAILABLE' }
export type EnsurePtyHostResult = { client: PtyHostClient } | PtyHostUnavailable | { incompatible: string }

export interface EnsurePtyHostOptions {
  /** The binary to start; `null` means there is none. Defaults to `ptyHostBinary()`. */
  binary?: string | null
  /** How long a started host has to publish its discovery file. */
  waitMs?: number
}

const unavailable = (reason: string): PtyHostUnavailable => ({ unavailable: reason, code: 'PTY_HOST_UNAVAILABLE' })

/**
 * The host the discovery file names: a client, `{ incompatible }` when it answers but refuses this
 * daemon, or null when nothing answers there (or there is no file).
 */
async function connectExisting(home: string): Promise<{ client: PtyHostClient } | { incompatible: string } | null> {
  const discovery = readDiscovery(home, PTY_PROTOCOL)
  if (!discovery) return null
  const result = await PtyHostClient.connect(discovery)
  if (result instanceof PtyHostClient) return { client: result }
  if (result === null) return null
  // A host that restarted between our read and our hello has a new token: read the file again.
  const again = readDiscovery(home, PTY_PROTOCOL)
  if (again && (again.token !== discovery.token || again.endpoint !== discovery.endpoint)) {
    const retried = await PtyHostClient.connect(again)
    if (retried instanceof PtyHostClient) return { client: retried }
    if (retried === null) return null
    return { incompatible: retried.incompatible }
  }
  return { incompatible: result.incompatible }
}

/**
 * Whether something accepts a connection at `endpoint` within `timeoutMs` (the hello's own limit); it is closed
 * without a hello. A connection never accepted (a stopped host's full backlog) counts as nothing there, and must not
 * hold the shared start for this home.
 */
export function reachable(endpoint: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(endpoint)
    const finish = (accepted: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(accepted)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** One start per home at a time in this process; concurrent callers share it. */
const starting = new Map<string, Promise<PtyHostUnavailable | null>>()

function startHost(home: string, binary: string | null, waitMs: number): Promise<PtyHostUnavailable | null> {
  const key = path.resolve(home)
  let start = starting.get(key)
  if (!start) {
    start = spawnAndWait(home, binary, waitMs).finally(() => starting.delete(key))
    starting.set(key, start)
  }
  return start
}

/** Start `binary serve --home <home>` and wait for a discovery file naming another pid. */
async function spawnAndWait(home: string, binary: string | null, waitMs: number): Promise<PtyHostUnavailable | null> {
  const before = readDiscovery(home, PTY_PROTOCOL)
  // A caller that found no host may arrive just after another caller's start finished.
  if (before && await reachable(before.endpoint)) return null
  if (!binary) return unavailable('harness-pty is not installed')
  let failed: string | null = null
  let exitedCleanly = false
  try {
    // Detached so the host outlives this daemon: panes must survive a daemon restart, as tmux's
    // do. On Windows the host also breaks away from the daemon's job by re-executing itself.
    // Without the daemon's own tmux identity (`TMUX`, `TMUX_PANE`), which a daemon started from a tmux pane has:
    // every pane the host spawns inherits its environment, and would read as that tmux pane's to a hook or a shell.
    const child = spawn(binary, ['serve', '--home', home], {
      detached: true, windowsHide: true, stdio: 'ignore', env: scrubTerminalContext({ ...process.env }),
    })
    child.once('error', err => { failed ??= `could not start ${binary}: ${err.message}` })
    child.once('exit', (code, signal) => {
      // 0 is a host that found another one already serving this home.
      if (code === 0) exitedCleanly = true
      else failed ??= `${binary} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`
    })
    child.unref()
  } catch (err) {
    return unavailable(`could not start ${binary}: ${(err as Error).message}`)
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    if (failed) return unavailable(failed)
    const now = readDiscovery(home, PTY_PROTOCOL)
    if (now && now.pid !== before?.pid) return null
    if (exitedCleanly && now && await reachable(now.endpoint)) return null
  }
  return unavailable(`harness-pty did not publish its discovery file within ${waitMs} ms`)
}

/**
 * A client of the host serving `home`, starting the host first when nothing answers at the
 * endpoint its discovery file names. `incompatible` is a host that answers and refuses this
 * daemon; starting another would not replace it.
 */
export async function ensurePtyHost(home: string, options: EnsurePtyHostOptions = {}): Promise<EnsurePtyHostResult> {
  const existing = await connectExisting(home)
  if (existing) return existing
  const binary = options.binary !== undefined ? options.binary : ptyHostBinary()
  const failed = await startHost(home, binary, options.waitMs ?? START_WAIT_MS)
  if (failed) return failed
  // The host this start found or made published a discovery file, but nothing answers where it says.
  return (await connectExisting(home)) ?? unavailable('no harness-pty answers at the endpoint its discovery file names')
}
