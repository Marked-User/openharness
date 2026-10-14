import type { AgentEngine } from '../engines/types.js'
import type {
  SubmitOptions,
  TerminalActionResult,
  TerminalBackendCapabilities,
  TerminalBackendName,
  TerminalCaptureOptions,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalInventoryResult,
  TerminalLogicalKey,
  TerminalPaneInfo,
  TerminalPaneRead,
  TerminalProcessExpectation,
  TerminalReadResult,
  TerminalRespawnRequest,
  TerminalRuntimeRef,
  TerminalStreamHandle,
  TerminalStreamSink,
  TerminalStreamSize,
  RuntimeValidation,
} from './terminalTypes.js'

/** What `prepare` says: ready, or why not with the error code a create/restore/resume then answers. */
export type TerminalBackendPrepared = { state: 'ready' } | { state: 'unavailable'; reason: string; code: string }

/** Backend-specific terminal I/O. Process ownership and registry reconciliation deliberately live above it. */
export interface TerminalBackend<Ref extends TerminalRuntimeRef = TerminalRuntimeRef> {
  readonly name: TerminalBackendName
  readonly instanceId: string

  /** Ready the backend at daemon start. A failure is a state: the daemon keeps running without it.
   *  [ownedPanes] is the registry's panes (pane id → engine), for a backend that adopts what it finds. */
  prepare(context: { ownedPanes: ReadonlyMap<string, AgentEngine> }): Promise<TerminalBackendPrepared>
  /** What this backend can do for a new pane, asked before a launch that needs it. */
  capabilities(): Promise<TerminalBackendCapabilities>

  create(request: TerminalCreateRequest): Promise<TerminalCreateResult<Ref>>
  /** Recheck the original Stop permission after backend waits, at command dispatch. */
  kill(runtime: Ref, current?: () => boolean): Promise<TerminalActionResult>
  inventory(): Promise<TerminalInventoryResult>
  /** Current user-visible titles keyed by backend-scoped terminal route key. */
  titles(): Promise<TerminalReadResult<Map<string, string>>>
  validate(runtime: Ref, expected: TerminalProcessExpectation): Promise<RuntimeValidation>
  capture(runtime: Ref, options?: TerminalCaptureOptions): Promise<TerminalReadResult<string>>
  typeLiteral(runtime: Ref, text: string): Promise<TerminalActionResult>
  submitText(runtime: Ref, text: string, options?: SubmitOptions): Promise<TerminalActionResult>
  sendKey(runtime: Ref, key: TerminalLogicalKey): Promise<TerminalActionResult>
  setTitle(runtime: Ref, title: string): Promise<TerminalActionResult>
  notify(runtime: Ref, title: string, body: string): Promise<TerminalActionResult>

  /** Hand a pane back to the backend's default disposal after `create()` kept it when dead. Rechecks
   *  [current] after its own waits, before the command. */
  releaseHold(runtime: Ref, current?: () => boolean): Promise<void>
  /** Pane liveness plus, for a held pane, how its process ended. */
  paneState(runtime: Ref): Promise<TerminalPaneRead>
  /** The pane's foreground command, working directory, pid and tty; null when the pane is unknown. */
  paneInfo(runtime: Ref): Promise<TerminalPaneInfo | null>
  /** The pane's own root process, 'missing' when the backend says the pane does not exist, null when it could not ask. */
  rootProcess(runtime: Ref): Promise<number | 'missing' | null>

  /** Byte streaming is optional per backend. */
  openStream?(
    runtime: Ref,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
    readOnly?: boolean,
  ): Promise<TerminalReadResult<TerminalStreamHandle<Ref>>>

  /** Restart's two primitives. Optional per backend — only tmux (a real multiplexer pane) supports an
   *  in-place process swap; a backend without them makes restart report RESTART_UNSUPPORTED_BACKEND. */
  /** Re-arm a pane's "keep it when the process dies" behavior ahead of killing that process. */
  holdOpen?(runtime: Ref): Promise<TerminalActionResult>
  /** Replace the process occupying an existing pane/session in place, preserving its identity. */
  respawn?(runtime: Ref, request: TerminalRespawnRequest): Promise<TerminalActionResult>
}
