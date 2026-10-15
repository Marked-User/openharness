/**
 * The `ptyhost` terminal backend: panes held by the Harness PTY host (`pty/`, `harness-pty serve`), reached
 * over its control connection (ptyHost/client.ts). It mirrors `TmuxBackend` op for op, so an agent on
 * either backend is created, read, typed into, held and restarted the same way.
 *
 * Its streams (`openStream`) are `PtyHostStream`s (ptyHost/stream.ts), one stream connection each, whose keyframes
 * are tmux's.
 *
 * The connection: when the host ends it (it exited, or dropped this daemon), the backend is unavailable (`inventory`
 * says so, and never lists nothing) and reconnects, through `ensurePtyHost`, after 1 s, then 2 s, 4 s … at most 30 s
 * apart; the delays start again from 1 s only for a connection that had stayed up 30 s. A host with another pid is another host: its predecessor's panes are gone, and `onHostReplaced` says so,
 * so the reconciler sees them absent and the resume path takes over. `dispose` drops the connection alone.
 */
import { env } from '../config/env.js'
import type { AgentEngine } from '../engines/types.js'
import { harnessPaneOwner } from './harnessSessionLabel.js'
import { isHeldStartCommand } from './nativePaneHold.js'
import { lookupPaneEngineProcess } from './paneEngineProcess.js'
import { LSTART_MARKER_RE } from './processTable.js'
import type { PtyHostCallResult, PtyHostClient } from './ptyHost/client.js'
import { ensurePtyHost, type EnsurePtyHostResult } from './ptyHost/launch.js'
import type { PtyEvent } from './ptyHost/protocol.js'
import { PtyHostStream } from './ptyHost/stream.js'
import { submitContent, submitSettleMs } from './submitTiming.js'
import type { TerminalBackend, TerminalBackendPrepared } from './terminalBackend.js'
import { TMUX_KEYS } from './terminalKeys.js'
import { sameProcessIdentity, terminalRouteKey } from './terminalRuntime.js'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionNotStarted,
  terminalActionPossiblyExecuted,
  terminalEnterWithheld,
  type PtyRuntimeRef,
  type RuntimeValidation,
  type SubmitOptions,
  type TerminalActionResult,
  type TerminalBackendCapabilities,
  type TerminalCaptureOptions,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalInventoryResult,
  type TerminalLogicalKey,
  type TerminalPaneInfo,
  type TerminalPaneRead,
  type TerminalProcessExpectation,
  type TerminalReadResult,
  type TerminalRespawnRequest,
  type TerminalStreamHandle,
  type TerminalStreamSink,
  type TerminalStreamSize,
} from './terminalTypes.js'

/** A new pane's size until a viewer resizes it to itself: a wide screen, so an engine's first frame wraps little. */
const CREATE_COLS = 200
const CREATE_ROWS = 50
/** How long a killed pane's process group is given after SIGHUP before the host escalates. */
const KILL_GRACE_MS = 2000
/** The first reconnect after the host connection ended, doubled after each failed one up to the last. */
const RECONNECT_FIRST_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/**
 * How long a connection must have stayed up for its loss to start the delays again from the first: a host that
 * dies soon after each start keeps the growing delay, rather than being restarted every second.
 */
const RECONNECT_STABLE_MS = 30_000

export interface PtyHostBackendOptions {
  /** The host's `--home` (`HARNESS_PTY_DIR`): its discovery file and logs live there. */
  home: string
  /** Reach or start the host (`ensurePtyHost`); a seam for tests. */
  launch?: (home: string) => Promise<EnsurePtyHostResult>
  /** The tag this daemon's panes carry, read at every create and inventory, as `TmuxBackend` reads it. */
  owner?: () => string
}

/**
 * What this backend knows of a pane it made or held. `hold` mirrors the host's: a held pane stays when its
 * process ends (`exited` is then its status), an unheld one is removed by the host, and so forgotten here.
 */
export interface PtyPaneRecord {
  hold: boolean
  /** The exit the host reported for a held pane; absent while its process runs. */
  exited?: number | null
}

/** The host's answer as a terminal action result: `rejected` and `not_started` keep the host's own reason. */
function actionOf(result: PtyHostCallResult<unknown>): TerminalActionResult {
  if (result.state === 'ok') return TERMINAL_ACTION_SUCCEEDED
  if (result.state === 'failed') return { state: 'failed', dispatch: result.dispatch, reason: result.reason }
  return terminalActionPossiblyExecuted(result.reason)
}

/**
 * What runs in a pane created with no command: the user's shell, as tmux's `default-shell` is. On Windows
 * the command processor until the shell choice of lib/windows/shell.ts lands (Task 20).
 */
function defaultCommand(): string[] {
  if (process.platform === 'win32') return [process.env.ComSpec ?? 'cmd.exe']
  return [process.env.SHELL || '/bin/sh']
}

/** `#{pane_current_command}`'s form of an argv: the program's file name. */
function commandName(argv: readonly string[]): string {
  const first = argv[0] ?? ''
  return first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1)
}

const UNAVAILABLE = 'pty host is unavailable'

export class PtyHostBackend implements TerminalBackend<PtyRuntimeRef> {
  readonly name = 'ptyhost' as const

  private readonly home: string
  private readonly launch: (home: string) => Promise<EnsurePtyHostResult>
  private readonly owner: () => string
  private client: PtyHostClient | null = null
  private instance: string | null = null
  private readonly panes = new Map<string, PtyPaneRecord>()
  /** The current client's event and close subscriptions. */
  private subscriptions: Array<() => void> = []
  /** The pid of the last host reached: a reconnect to another is a host that died and was started again. */
  private hostPid: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = RECONNECT_FIRST_MS
  /** When the current connection was made. */
  private connectedAt = 0
  private disposed = false

  /** Called when a reconnect reached another host than before: every pane of the old one is gone. */
  onHostReplaced?: () => void

  constructor(options: PtyHostBackendOptions) {
    this.home = options.home
    this.launch = options.launch ?? ((home) => ensurePtyHost(home))
    this.owner = options.owner ?? (() => harnessPaneOwner(env.ADAPTER_DATA_DIR))
  }

  /** `ptyhost:<instance>`, the instance being the host's (`p<protocol>`), known once `prepare` reached it. */
  get instanceId(): string {
    return `ptyhost:${this.instance ?? 'unprepared'}`
  }

  async prepare(context: { ownedPanes: ReadonlyMap<string, AgentEngine> }): Promise<TerminalBackendPrepared> {
    void context
    this.disposed = false
    this.cancelReconnect()
    const reached = await this.launch(this.home)
    if ('incompatible' in reached) {
      console.error(`[terminal] ptyhost: unavailable (${reached.incompatible})`)
      return { state: 'unavailable', code: 'PTY_HOST_UNAVAILABLE', reason: reached.incompatible }
    }
    if ('unavailable' in reached) {
      console.error(`[terminal] ptyhost: unavailable (${reached.unavailable})`)
      return { state: 'unavailable', code: reached.code, reason: reached.unavailable }
    }
    this.attach(reached.client)
    console.log(`[terminal] ptyhost: available (${this.instance})`)
    return { state: 'ready' }
  }

  /**
   * Close the connection to the host, as a daemon exiting does: the host and its panes are left running, for the
   * next daemon to reattach. No reconnect follows.
   */
  dispose(): void {
    this.disposed = true
    this.cancelReconnect()
    const client = this.client
    this.detach()
    client?.close()
  }

  /** Make [client] this backend's connection, in place of any other. Whether it is another host than the last. */
  private attach(client: PtyHostClient): boolean {
    const previous = this.client
    this.detach()
    if (previous && previous !== client) previous.close()
    this.client = client
    this.instance = client.instance
    const replaced = this.hostPid !== null && this.hostPid !== client.pid
    this.hostPid = client.pid
    this.connectedAt = Date.now()
    // The panes recorded were the old host's.
    if (replaced) this.panes.clear()
    this.subscriptions.push(client.onEvent((event) => this.onEvent(event)))
    this.subscriptions.push(client.onClose(() => this.onConnectionLost(client)))
    return replaced
  }

  /** Forget the current client: its listeners are removed, and nothing is asked of it any more. */
  private detach(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    this.client = null
  }

  private onConnectionLost(client: PtyHostClient): void {
    if (client !== this.client) return
    this.detach()
    console.error('[terminal] ptyhost: lost the connection to the host; reconnecting')
    if (Date.now() - this.connectedAt >= RECONNECT_STABLE_MS) this.reconnectDelay = RECONNECT_FIRST_MS
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  /** One attempt: the host this home has, started again if it is not running (`ensurePtyHost`). */
  private async reconnect(): Promise<void> {
    let reached: EnsurePtyHostResult
    try {
      reached = await this.launch(this.home)
    } catch (error) {
      reached = { unavailable: (error as Error).message, code: 'PTY_HOST_UNAVAILABLE' }
    }
    if (!('client' in reached)) {
      console.error(`[terminal] ptyhost: reconnect failed (${'incompatible' in reached ? reached.incompatible : reached.unavailable})`)
      this.scheduleReconnect()
      return
    }
    // Disposed meanwhile, or connected again by a `prepare`: this one is not needed.
    if (this.disposed || this.client) {
      reached.client.close()
      return
    }
    const replaced = this.attach(reached.client)
    console.log(`[terminal] ptyhost: reconnected (${this.instance}${replaced ? ', a new host: its panes are gone' : ''})`)
    if (replaced) this.onHostReplaced?.()
  }

  /** What this backend knows of [runtime]'s pane, for the host-death handling and its tests. */
  known(runtime: PtyRuntimeRef): Readonly<PtyPaneRecord> | undefined {
    return runtime.instance === this.instance ? this.panes.get(runtime.paneId) : undefined
  }

  private onEvent(event: PtyEvent): void {
    if (event.event !== 'exit') return
    const record = this.panes.get(event.pane)
    if (!record) return
    if (record.hold) record.exited = event.status
    else this.panes.delete(event.pane)
  }

  /** The client for [runtime], or null when the host is not reached or the pane is another host instance's. */
  private clientFor(runtime: PtyRuntimeRef): PtyHostClient | null {
    return this.client && runtime.instance === this.instance ? this.client : null
  }

  /** Always: the host takes a pane's environment at create, nothing ever puts it in an argv. */
  async capabilities(): Promise<TerminalBackendCapabilities> {
    return { sessionEnv: true }
  }

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResult<PtyRuntimeRef>> {
    const client = this.client
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    if (request.current?.() === false) return terminalActionNotStarted('The harness changed before pane dispatch')
    request.onDispatch?.()
    // Held from the start, as tmux's remain-on-exit at create: an engine that exits at once still leaves
    // its error readable. The agent services release it once the pane is a real agent (`releaseHold`).
    const result = await client.call({
      op: 'create',
      command: request.command?.length ? request.command : defaultCommand(),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env && Object.keys(request.env).length ? { env: request.env } : {}),
      cols: CREATE_COLS,
      rows: CREATE_ROWS,
      owner: this.owner(),
      ...(request.label ? { label: request.label } : {}),
      hold: true,
    })
    if (result.state !== 'ok') return actionOf(result) as TerminalCreateResult<PtyRuntimeRef>
    // Recorded here, before any other await: an exit that overtook this reply is released by the client
    // on the next turn (client.ts), and must find the pane known.
    this.panes.set(result.value.pane, { hold: true })
    return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'ptyhost', instance: client.instance, paneId: result.value.pane } }
  }

  async kill(runtime: PtyRuntimeRef, current?: () => boolean): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    if (current && !current()) return terminalActionNotStarted('The harness changed before pane close')
    const result = await client.call({ op: 'kill', pane: runtime.paneId, graceMs: KILL_GRACE_MS })
    // A pane the host does not have is closed already, as tmux's kill reads an authoritative absence.
    if (result.state === 'ok' || (result.state === 'failed' && result.code === 'no_pane')) {
      this.panes.delete(runtime.paneId)
      return TERMINAL_ACTION_SUCCEEDED
    }
    return actionOf(result)
  }

  async inventory(): Promise<TerminalInventoryResult> {
    if (!this.client) return { state: 'unavailable', reason: UNAVAILABLE }
    const instance = this.client.instance
    const result = await this.client.call({ op: 'inventory' })
    if (result.state !== 'ok') return { state: 'unavailable', reason: result.reason }
    const owner = this.owner()
    return {
      state: 'available',
      // This daemon's panes alone, as tmux's listing (`ownedHere`). A held pane whose process ended is
      // listed with its last pid, as tmux lists a dead pane's: a placement missing from inventory is
      // evicted after a few passes (terminalAgentReconciler.ts), and a failed create or restart must
      // keep its tile and its error on screen.
      roots: result.value.panes
        .filter((pane) => pane.owner === owner && pane.rootPid !== null)
        .map((pane) => ({
          runtime: { backend: 'ptyhost' as const, instance, paneId: pane.pane },
          rootPid: pane.rootPid!,
          cwd: pane.cwd,
        })),
    }
  }

  async titles(): Promise<TerminalReadResult<Map<string, string>>> {
    if (!this.client) return { state: 'failed', reason: UNAVAILABLE }
    const instance = this.client.instance
    const result = await this.client.call({ op: 'titles' })
    if (result.state !== 'ok') return { state: 'failed', reason: result.reason }
    return {
      state: 'succeeded',
      value: new Map(Object.entries(result.value.titles).map(([paneId, title]) => [terminalRouteKey({ backend: 'ptyhost', instance, paneId }), title])),
    }
  }

  /** `TmuxBackend.validate`, over this backend's root process. Windows job membership comes with Task 19. */
  async validate(runtime: PtyRuntimeRef, expected: TerminalProcessExpectation): Promise<RuntimeValidation> {
    try {
      const found = await lookupPaneEngineProcess(this, runtime, expected.engine)
      if (!found.ok) return { state: found.unknown ? 'unknown' : 'gone', reason: found.reason }
      // A saved marker that is not a C-locale `lstart` stamp can never equal one read today (see
      // `TmuxBackend.validate`): the pane still runs a matching engine, take it.
      if (expected.processIdentity && !LSTART_MARKER_RE.test(expected.processIdentity.startMarker)) return { state: 'alive' }
      if (expected.processIdentity && !sameProcessIdentity(expected.processIdentity, found.identity)) {
        return { state: 'gone', reason: 'process changed under ptyhost pane', replaced: true }
      }
      return { state: 'alive' }
    } catch {
      return { state: 'unknown', reason: 'pty host runtime probe failed' }
    }
  }

  /**
   * Exactly as `TmuxBackend.capture` hands the options to `tmuxCaptureArgs`: `visible` is the screen alone,
   * every other mode history bounded to 20–300 lines (100 by default), with colours unless asked for none.
   */
  async capture(runtime: PtyRuntimeRef, options: TerminalCaptureOptions = {}): Promise<TerminalReadResult<string>> {
    const client = this.clientFor(runtime)
    if (!client) return { state: 'failed', reason: UNAVAILABLE }
    const visible = options.mode === 'visible'
    const result = await client.call({
      op: 'capture',
      pane: runtime.paneId,
      visible,
      ...(visible ? {} : { historyLines: Math.max(20, Math.min(300, Math.floor(options.historyLines ?? 100))) }),
      ansi: options.ansi !== false,
    })
    return result.state === 'ok' ? { state: 'succeeded', value: result.value.text } : { state: 'failed', reason: result.reason }
  }

  /** Typed as `tmux paste-buffer` without `-p` types it (sendLiteralToTmux): each newline a carriage return. */
  async typeLiteral(runtime: PtyRuntimeRef, text: string): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    return actionOf(await client.call({ op: 'paste', pane: runtime.paneId, text, bracketed: false }))
  }

  /**
   * `sendToTmux`'s submit: one bracketed paste (the host neutralizes its controls, term/src/paste.rs), the
   * settle a long or multi-line paste needs (submitTiming.ts), then `beforeEnter` and the authority fence,
   * then Enter.
   */
  async submitText(runtime: PtyRuntimeRef, text: string, options?: SubmitOptions): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    const content = submitContent(text)
    const settle = submitSettleMs(content)
    if (options?.allowed && !options.allowed()) return terminalActionNotStarted('terminal control revoked')
    const pasted = await client.call({ op: 'paste', pane: runtime.paneId, text: content, bracketed: true })
    if (pasted.state !== 'ok') return actionOf(pasted)
    if (settle) await new Promise((resolve) => setTimeout(resolve, settle))
    const withheld = options?.beforeEnter ? await options.beforeEnter() : null
    if (withheld) return terminalEnterWithheld(withheld)
    if (options?.allowed && !options.allowed()) return terminalEnterWithheld('terminal control revoked')
    return actionOf(await client.call({ op: 'key', pane: runtime.paneId, key: 'Enter' }))
  }

  async sendKey(runtime: PtyRuntimeRef, key: TerminalLogicalKey): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    return actionOf(await client.call({ op: 'key', pane: runtime.paneId, key: TMUX_KEYS[key] }))
  }

  async setTitle(runtime: PtyRuntimeRef, title: string): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    return actionOf(await client.call({ op: 'setTitle', pane: runtime.paneId, title: title.slice(0, 200) }))
  }

  /** Nothing to do: the host has no status line, and the daemon's own notifications already say it. */
  async notify(runtime: PtyRuntimeRef, title: string, body: string): Promise<TerminalActionResult> {
    void [runtime, title, body]
    return TERMINAL_ACTION_SUCCEEDED
  }

  /** Keep the pane when its process ends, ahead of killing that process for a restart (tmux's remain-on-exit). */
  async holdOpen(runtime: PtyRuntimeRef, current?: () => boolean): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    if (current?.() === false) return terminalActionNotStarted('The harness changed before retaining its pane')
    const result = await client.call({ op: 'holdOpen', pane: runtime.paneId })
    if (result.state === 'ok') {
      const record = this.panes.get(runtime.paneId)
      if (record) record.hold = true
      else this.panes.set(runtime.paneId, { hold: true })
    }
    return actionOf(result)
  }

  /**
   * tmux's `respawn-pane -k`: the host kills a process still running in the pane, then starts [request]'s in
   * the same pane and grid. With `expectedHeldToken`, only over the held shell under that token, checked on
   * the host in the same op (`heldPaneFormat`).
   */
  async respawn(runtime: PtyRuntimeRef, request: TerminalRespawnRequest): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    if (request.expectedHeldToken && !/^[a-f0-9-]{36}$/.test(request.expectedHeldToken)) return terminalActionNotStarted('invalid waiting pane identity')
    if (request.current?.() === false) return terminalActionNotStarted('The harness changed before pane dispatch')
    request.onDispatch?.()
    const result = await client.call({
      op: 'respawn',
      pane: runtime.paneId,
      command: request.command,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env && Object.keys(request.env).length ? { env: request.env } : {}),
      ...(request.expectedHeldToken ? { expectedHeldToken: request.expectedHeldToken } : {}),
      // The host keeps each pane's create env, as tmux keeps its session's: a respawn inherits it, less these.
      ...(request.clearEnv?.length ? { clearEnv: [...request.clearEnv] } : {}),
    })
    if (result.state === 'ok') {
      // The host absorbs the replaced process's exit; the pane runs again.
      const record = this.panes.get(runtime.paneId)
      if (record) delete record.exited
      return TERMINAL_ACTION_SUCCEEDED
    }
    // The host checked the token against the pane and replaced nothing, as tmux's `adoption-mismatch`.
    if (result.state === 'failed' && result.code === 'held_mismatch') return terminalActionNotStarted('The waiting pane changed')
    // Never sent, or no such pane: nothing was killed.
    if (result.state === 'failed' && result.dispatch === 'not_started') return terminalActionNotStarted(result.reason)
    // The old process may be gone though the new one never started (`-k`, as `TmuxBackend.respawn` says).
    return terminalActionPossiblyExecuted(`pty host could not respawn the pane: ${result.reason}`)
  }

  /**
   * Read only: the pane runs the held shell under [token], as tmux's `heldPaneFormat` reads the start
   * command. The respawn repeats the check on the host; this read grants no later write.
   */
  async isHeld(runtime: PtyRuntimeRef, token: string): Promise<boolean | 'unknown'> {
    if (!/^%\d+$/.test(runtime.paneId) || !/^[a-f0-9-]{36}$/.test(token)) return 'unknown'
    const client = this.clientFor(runtime)
    if (!client) return 'unknown'
    const result = await client.call({ op: 'paneState', pane: runtime.paneId })
    if (result.state !== 'ok') return 'unknown'
    const state = result.value.state
    return state !== 'gone' && !state.dead && isHeldStartCommand(state.startCommand, token)
  }

  /**
   * Close the pane only while it is the held shell under [token], dead or alive, as tmux's `heldPaneFormat` reads a
   * remain-on-exit pane: an adoption cancelled, or rolled back. Read, then closed, where tmux does both in one
   * `if-shell`. The gap cannot name another pane: a host never gives a pane id out twice for its home
   * (pty/src/pane_ids.rs). And nothing replaces a held shell here but the daemon's own respawn (the shell has no
   * tmux to replace itself with), which [current] fences.
   */
  async killHeld(runtime: PtyRuntimeRef, token: string, current: () => boolean): Promise<TerminalActionResult> {
    if (!/^%\d+$/.test(runtime.paneId) || !/^[a-f0-9-]{36}$/.test(token)) return terminalActionNotStarted('invalid waiting pane identity')
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    const result = await client.call({ op: 'paneState', pane: runtime.paneId })
    if (result.state !== 'ok') return terminalActionNotStarted(result.reason)
    const state = result.value.state
    // Gone already: closed, as tmux reads an authoritative absence.
    if (state === 'gone') return TERMINAL_ACTION_SUCCEEDED
    if (!isHeldStartCommand(state.startCommand, token)) return terminalActionNotStarted('The waiting pane no longer has this adoption identity')
    if (!current()) return terminalActionNotStarted('Adoption changed before pane close')
    return this.kill(runtime, current)
  }

  async releaseHold(runtime: PtyRuntimeRef, current?: () => boolean): Promise<void> {
    const client = this.clientFor(runtime)
    if (!client || current?.() === false) return
    const result = await client.call({ op: 'releaseHold', pane: runtime.paneId })
    const record = this.panes.get(runtime.paneId)
    if (result.state !== 'ok' || !record) return
    // A pane whose process already ended is removed by the release itself.
    if (record.exited !== undefined) this.panes.delete(runtime.paneId)
    else this.panes.set(runtime.paneId, { hold: false })
  }

  async paneState(runtime: PtyRuntimeRef): Promise<TerminalPaneRead> {
    const client = this.clientFor(runtime)
    if (!client) return 'unknown'
    const result = await client.call({ op: 'paneState', pane: runtime.paneId })
    if (result.state !== 'ok') return 'unknown'
    const state = result.value.state
    if (state === 'gone') return 'gone'
    return { dead: state.dead, exitStatus: state.exitStatus, command: commandName(state.command), engineExit: state.engineExit }
  }

  async paneInfo(runtime: PtyRuntimeRef): Promise<TerminalPaneInfo | null> {
    const client = this.clientFor(runtime)
    if (!client) return null
    const result = await client.call({ op: 'paneInfo', pane: runtime.paneId })
    return result.state === 'ok' ? result.value.info : null
  }

  /**
   * The pane's root pid. `'missing'` for a pane the host does not have, and for a held pane whose process
   * ended: nothing runs there, which every caller reads as tmux's dead pane reads (no engine under it).
   */
  async rootProcess(runtime: PtyRuntimeRef): Promise<number | 'missing' | null> {
    const client = this.clientFor(runtime)
    if (!client) return null
    const result = await client.call({ op: 'paneInfo', pane: runtime.paneId })
    if (result.state === 'failed' && result.code === 'no_pane') return 'missing'
    if (result.state !== 'ok') return null
    return result.value.info.pid ?? 'missing'
  }

  /**
   * A stream on the pane, over a stream connection of its own. As `TmuxBackend.openStream`, `expected` is not
   * checked: a pane whose engine has gone still shows why.
   */
  async openStream(
    runtime: PtyRuntimeRef,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
    readOnly?: boolean,
  ): Promise<TerminalReadResult<TerminalStreamHandle<PtyRuntimeRef>>> {
    void expected
    const client = this.clientFor(runtime)
    if (!client) return { state: 'failed', reason: UNAVAILABLE }
    const connection = await client.openStream()
    if (!connection) return { state: 'failed', reason: 'pty host stream connection is unavailable' }
    return PtyHostStream.open(connection, runtime, size, sink, readOnly === true)
  }
}
