import { readFileSync } from 'node:fs'

/**
 * What a person has open on this computer: the desktop app, or `harness tui`. Each is its own presence.
 * Here, not in core/api.ts: the gateway reads these off its pipe to the core, and it may take only types
 * from the core's API (src/architecture.spec.ts), so that it runs in a process of its own without the core.
 */
export type WindowSurface = 'desktop' | 'tui'
export type LocalWindows = Record<WindowSurface, number>
export const WINDOW_SURFACES: readonly WindowSurface[] = ['desktop', 'tui']

/**
 * What the backend counts a `harness tui` window as (`user_daily_client_presence.surface`): the TUI, or
 * Harness OS on a PC or an Orange Pi, so where a person comes from is told apart. Harness OS is its
 * daemon unit (which sets HARNESS_OS=1, and whose file the OS package ships); the board is the device
 * tree's model or compatible, or Orange Pi's release file.
 */
export type TuiPresence = 'tui' | 'harness-os' | 'harness-os-pi'
export function tuiPresence(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string = readText): TuiPresence {
  if (env.HARNESS_OS !== '1' && !read('/usr/lib/systemd/user/harness-daemon.service')) return 'tui'
  // Orange Pi's own Debian names the SoC in `model` ("sun60iw2"); the board is in `compatible`
  // ("xunlong,orangepi-4-pro") and in /etc/orangepi-release.
  const board = [read('/proc/device-tree/model'), read('/proc/device-tree/compatible'), read('/etc/orangepi-release')].join('\n')
  return /orange\s*-?pi/i.test(board) ? 'harness-os-pi' : 'harness-os'
}
function readText(path: string): string { try { return readFileSync(path, 'utf8') } catch { return '' } }

/** A surface off the core↔gateway pipe: anything but `tui` is the desktop app. */
export const windowSurfaceOf = (value: unknown): WindowSurface => (value === 'tui' ? 'tui' : 'desktop')

/** Window counts off the core↔gateway pipe; anything unreadable is none. */
export const localWindowsOf = (value: unknown): LocalWindows => {
  const counts = (value ?? {}) as Partial<Record<WindowSurface, unknown>>
  const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
  return { desktop: count(counts.desktop), tui: count(counts.tui) }
}

/** The windows attached now, per surface, from the loopback clients: a tool (`harness pair`, MCP) is no window. */
export const countWindows = (clients: number, tools: number, tuis: number): LocalWindows =>
  ({ desktop: clients - tools - tuis, tui: tuis })
