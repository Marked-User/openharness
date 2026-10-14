import type { AgentEngine } from '../engines/types.js'
import type { ProcessIdentity, TerminalBackendName, TerminalRuntimeRef } from './terminalTypes.js'

const SEP = '\u0000'

function assertKeyPart(value: string, field: string): string {
  if (!value || value.includes(SEP)) throw new Error(`invalid ${field}`)
  return value
}

/**
 * The panes [sessions] hold on [backend] (pane id → the row's engine), for that backend's `prepare`. Only
 * its own: pane ids are per backend (`%N` on tmux and on ptyhost alike), and tmux renames the legacy
 * session of any pane it is handed.
 */
export function ownedPanesOf(
  sessions: Iterable<{ engine: AgentEngine; runtimes: readonly TerminalRuntimeRef[] }>,
  backend: TerminalBackendName,
): Map<string, AgentEngine> {
  const owned = new Map<string, AgentEngine>()
  for (const session of sessions) {
    for (const runtime of session.runtimes) if (runtime.backend === backend) owned.set(runtime.paneId, session.engine)
  }
  return owned
}

/** Stable route key. A ptyhost pane id is only unique within its host instance, so the instance is part of it. */
export function terminalRouteKey(runtime: TerminalRuntimeRef): string {
  const pane = assertKeyPart(runtime.paneId, 'pane id')
  return runtime.backend === 'tmux'
    ? `tmux${SEP}${pane}`
    : `ptyhost${SEP}${assertKeyPart(runtime.instance, 'pty host instance')}${SEP}${pane}`
}

/** The backend instance that holds [runtime]: `<backend>:<instance>`, as `TerminalBackend.instanceId`. */
export function terminalInstanceId(runtime: TerminalRuntimeRef): string {
  return runtime.backend === 'tmux' ? 'tmux:default' : `ptyhost:${runtime.instance}`
}

/** Human-readable locator label for status and logs. */
export function terminalRuntimeLabel(runtime: TerminalRuntimeRef): string {
  return runtime.backend === 'tmux' ? `tmux:${runtime.paneId}` : `ptyhost:${runtime.instance}:${runtime.paneId}`
}

/** The runtime a session is reached through first. Rows keep at least one (registry.ts `strictPersistedRow`). */
export function primaryRuntime(session: { readonly runtimes: readonly TerminalRuntimeRef[] }): TerminalRuntimeRef {
  return session.runtimes[0]
}

/** Stable placement key. For tmux the pane id is both the route and the placement identity. */
export function terminalPlacementKey(runtime: TerminalRuntimeRef): string {
  return terminalRouteKey(runtime)
}

function startTicks(identity: ProcessIdentity): number | undefined {
  return Number.isSafeInteger(identity.startTicks) && identity.startTicks! >= 0 ? identity.startTicks : undefined
}

/** Keyed by the start ticks when known: the marker of the same process moves with the wall clock. */
export function processIdentityKey(engine: string, identity: ProcessIdentity): string {
  const ticks = startTicks(identity)
  const start = ticks === undefined ? assertKeyPart(identity.startMarker, 'process start marker') : `t:${ticks}`
  return `${assertKeyPart(engine, 'engine')}${SEP}${identity.pid}${SEP}${start}`
}

/**
 * pid + start time is a process. The start ticks decide when both sides have them (see
 * `ProcessIdentity.startTicks`); otherwise the `ps` marker, as before them — which is also how a row
 * saved before them is matched once, and then saved with them.
 */
export function sameProcessIdentity(a: ProcessIdentity | undefined | null, b: ProcessIdentity | undefined | null): boolean {
  if (!a || !b || a.pid !== b.pid) return false
  const ticksA = startTicks(a)
  const ticksB = startTicks(b)
  return ticksA !== undefined && ticksB !== undefined ? ticksA === ticksB : a.startMarker === b.startMarker
}

/** The identity a row stands for, without the rest of the row. */
export function processIdentityOf(row: ProcessIdentity): ProcessIdentity {
  return {
    pid: row.pid, executable: row.executable, startMarker: row.startMarker,
    ...(row.startTicks !== undefined ? { startTicks: row.startTicks } : {}),
  }
}

export function sameTerminalPlacement(a: TerminalRuntimeRef, b: TerminalRuntimeRef): boolean {
  return terminalPlacementKey(a) === terminalPlacementKey(b)
}

/** Merge observed runtimes into the current set without duplicating a placement. */
export function mergeTerminalRuntimes(
  current: readonly TerminalRuntimeRef[],
  observed: readonly TerminalRuntimeRef[],
): TerminalRuntimeRef[] {
  const merged = new Map<string, TerminalRuntimeRef>()
  for (const runtime of current) merged.set(terminalPlacementKey(runtime), runtime)
  for (const runtime of observed) merged.set(terminalPlacementKey(runtime), runtime)
  return [...merged.values()].sort((a, b) => terminalPlacementKey(a).localeCompare(terminalPlacementKey(b)))
}
