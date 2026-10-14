/** TypeScript mirror of the harness-pty wire protocol (pty/src/protocol.rs). */

export const PTY_PROTOCOL = 1
export const MAX_FRAME = 8 * 1024 * 1024

export enum FrameKind {
  Subscribe = 1,
  Input = 2,
  Paste = 3,
  Resize = 4,
  Snapshot = 5,
  Pause = 6,
  Resume = 7,
  Output = 16,
  SnapshotReply = 17,
  Closed = 18,
  Ack = 19,
}

export type PtyErrorCode =
  | 'no_pane'
  | 'bad_request'
  | 'spawn_failed'
  | 'held_mismatch'
  | 'unsupported'
  | 'internal'

export function encodeFrame(kind: FrameKind, payload: Uint8Array): Buffer {
  if (payload.length > MAX_FRAME) throw new Error('frame too large')
  const out = Buffer.allocUnsafe(5 + payload.length)
  out.writeUInt8(kind, 0)
  out.writeUInt32BE(payload.length, 1)
  out.set(payload, 5)
  return out
}

export interface Frame {
  kind: FrameKind
  payload: Buffer
}

/**
 * Accumulates socket chunks and yields complete frames. A frame whose length
 * exceeds MAX_FRAME (8 MiB) or whose kind is unknown makes `push` throw; the
 * reader is then unusable and the connection must be dropped.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
    const frames: Frame[] = []
    while (this.buf.length >= 5) {
      const kind = this.buf.readUInt8(0)
      const len = this.buf.readUInt32BE(1)
      if (len > MAX_FRAME) throw new Error('frame too large')
      if (FrameKind[kind] === undefined) throw new Error(`unknown frame kind ${kind}`)
      if (this.buf.length < 5 + len) break
      frames.push({ kind: kind as FrameKind, payload: Buffer.from(this.buf.subarray(5, 5 + len)) })
      this.buf = this.buf.subarray(5 + len)
    }
    return frames
  }
}

export type HelloRole = 'control' | 'stream'
export interface HelloLine {
  hello: { token: string; protocol: number; role: HelloRole; clientId: string }
}
export type HelloReply =
  | { hello: { ok: true; instance: string; version: string; pid: number } }
  | { hello: { ok: false; code: string; reason: string } }

export interface PaneInventoryRow {
  pane: string
  /** null once the pane's process has exited (a held, dead pane). */
  rootPid: number | null
  cwd: string
  title: string
  dead: boolean
  /** The `owner` and `label` given at `create`. */
  owner: string
  label: string | null
}
export interface PaneStateInfo {
  dead: boolean
  exitStatus: number | null
  command: string[]
  engineExit: number | null
  heldToken: string | null
}
export interface PaneInfo {
  command: string
  path: string
  /** null once the pane's process has exited. */
  pid: number | null
  tty: string
}

export type PtyOp =
  | { op: 'create'; command: string[]; cwd?: string; env?: Record<string, string>; cols: number; rows: number; owner: string; label?: string; hold: boolean }
  | { op: 'kill'; pane: string; graceMs?: number }
  | { op: 'inventory' }
  | { op: 'titles' }
  | { op: 'paneState'; pane: string }
  | { op: 'paneInfo'; pane: string }
  | { op: 'capture'; pane: string; historyLines?: number; ansi: boolean; visible: boolean }
  | { op: 'write'; pane: string; data: string }
  | { op: 'paste'; pane: string; text: string; bracketed: boolean }
  | { op: 'key'; pane: string; key: string }
  | { op: 'setTitle'; pane: string; title: string }
  | { op: 'holdOpen'; pane: string; token?: string }
  | { op: 'releaseHold'; pane: string }
  | { op: 'respawn'; pane: string; command: string[]; cwd?: string; env?: Record<string, string>; expectedHeldToken?: string }
  | { op: 'jobPids'; pane: string }
  | { op: 'processes' }
  | { op: 'setEngineExit'; pane: string; status: number }

export type PtyRequest = { id: number } & PtyOp

export interface PtyOpReplies {
  create: { pane: string }
  kill: Record<string, never>
  inventory: { panes: PaneInventoryRow[] }
  titles: { titles: Record<string, string> }
  paneState: { state: PaneStateInfo | 'gone' }
  paneInfo: { info: PaneInfo | null }
  capture: { text: string }
  write: Record<string, never>
  paste: Record<string, never>
  key: Record<string, never>
  setTitle: Record<string, never>
  holdOpen: Record<string, never>
  releaseHold: Record<string, never>
  respawn: Record<string, never>
  jobPids: { pids: number[] }
  processes: { rows: unknown[] }
  setEngineExit: Record<string, never>
}

export type PtyResponse =
  | ({ id: number; ok: true } & Record<string, unknown>)
  | { id: number; ok: false; code: PtyErrorCode; reason: string }

export type PtyEvent =
  /** `status` is null when the host could not learn it. */
  | { event: 'exit'; pane: string; status: number | null }
  | { event: 'title'; pane: string; title: string }

/* Stream connection payloads (pty/src/stream.rs). */

/** `FrameKind.Subscribe`. A subscriber that is not read-only resizes the pane to itself. */
export interface StreamSubscribe {
  pane: string
  cols: number
  rows: number
  readOnly: boolean
}
/** `FrameKind.Resize`. */
export interface StreamResize {
  cols: number
  rows: number
}
/**
 * `FrameKind.Snapshot`. `historyLines` defaults to 2000 for `conversation` and 500 otherwise;
 * `none` sends no history.
 */
export interface StreamSnapshotRequest {
  id: number
  history: 'none' | 'plain' | 'conversation'
  historyLines?: number
}
/** `PaneMeta` as the host sends it (snake_case). */
export interface PtyPaneMeta {
  cols: number
  rows: number
  alternate_on: boolean
  cursor_x: number
  cursor_y: number
  cursor_visible: boolean
  mouse_standard: boolean
  mouse_button: boolean
  mouse_all: boolean
  mouse_utf8: boolean
  mouse_sgr: boolean
}
/**
 * `FrameKind.SnapshotReply`. `capture` is `capture-pane -p -e -N` (one line per screen row) and
 * `history` is `capture-pane -p -e -N -S -<n> -E -1`. Output frames with `seq <= seq` that arrive
 * after the reply are already in it; every later output follows it.
 *
 * For `history: 'conversation'` the reply also carries the history as `capture-pane -p -e -J`
 * prints it (`historyJoined`) and whether its last line continues into the screen
 * (`lastContinues`, as read from `capture-pane -p -J -S -1 -E 0`). They are dropped, before any
 * plain history, from a reply that would not fit a frame.
 */
export type StreamSnapshotReply =
  | {
      id: number
      ok: true
      seq: number
      capture: string
      history: string
      historyJoined?: string
      lastContinues?: boolean
      meta: PtyPaneMeta
    }
  | { id: number; ok: false; reason: 'not_subscribed' | 'no_pane' | 'bad_request' }
/**
 * `FrameKind.Ack`, one per Subscribe, Input, Paste and Resize, in order; `for` is the acknowledged
 * frame's kind. A Resize ack's `seq` is the last output drawn at the old size.
 */
export type StreamAck =
  | { for: FrameKind; ok: true; seq?: number }
  | {
      for: FrameKind
      ok: false
      reason: 'not_subscribed' | 'already_subscribed' | 'read_only' | 'no_pane' | 'exited' | 'bad_request'
    }
/** `FrameKind.Closed`; the host ends the connection after it. */
export interface StreamClosed {
  reason: 'exited' | 'killed' | 'overflow'
}
