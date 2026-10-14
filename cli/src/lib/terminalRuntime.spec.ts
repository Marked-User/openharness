import { describe, expect, it } from 'vitest'
import {
  mergeTerminalRuntimes,
  ownedPanesOf,
  processIdentityKey,
  processIdentityOf,
  sameProcessIdentity,
  terminalPlacementKey,
  terminalRouteKey,
} from './terminalRuntime.js'
import type { TmuxRuntimeRef } from './terminalTypes.js'

const tmux: TmuxRuntimeRef = { backend: 'tmux', paneId: '%3' }
describe('terminal runtime identity', () => {
  it('hands a backend only the panes on it, each with its row\'s engine', () => {
    // A ptyhost pane has a `%N` id too: handed to tmux, it could rename a legacy session that is not its.
    const ptyhost = { backend: 'ptyhost', instance: 'p1', paneId: '%7' } as unknown as TmuxRuntimeRef
    const sessions = [
      { engine: 'claude' as const, runtimes: [tmux, ptyhost] },
      { engine: 'codex' as const, runtimes: [{ backend: 'tmux' as const, paneId: '%8' }] },
      { engine: 'opencode' as const, runtimes: [{ ...ptyhost, paneId: '%9' }] },
    ]
    expect([...ownedPanesOf(sessions, 'tmux')]).toEqual([['%3', 'claude'], ['%8', 'codex']])
  })

  it('merges observed runtimes without duplicating a placement', () => {
    const other: TmuxRuntimeRef = { backend: 'tmux', paneId: '%4' }
    expect(terminalPlacementKey(tmux)).toBe(terminalRouteKey(tmux))
    expect(mergeTerminalRuntimes([tmux], [other, { ...tmux }])).toEqual([tmux, other])
  })

  it('keys process identity without treating argv-derived executable as authoritative', () => {
    const before = { pid: 42, executable: 'node', startMarker: 'Sat Aug 15 10:00:00 2026' }
    const renamed = { ...before, executable: 'agent title' }
    expect(sameProcessIdentity(before, renamed)).toBe(true)
    expect(processIdentityKey('claude', before)).toBe(processIdentityKey('claude', renamed))
  })

  it('judges a process by its start ticks when both sides have them, else by its ps marker', () => {
    const saved = { pid: 42, executable: 'node', startMarker: 'Wed Oct  7 09:48:11 2026', startTicks: 26385008 }
    // The same process after the clock was stepped: lstart moved, the ticks did not.
    const stepped = { ...saved, startMarker: 'Thu Oct  8 00:46:03 2026' }
    expect(sameProcessIdentity(saved, stepped)).toBe(true)
    expect(processIdentityKey('codex', saved)).toBe(processIdentityKey('codex', stepped))
    expect(sameProcessIdentity(saved, { ...saved, startTicks: 26385009 })).toBe(false)
    expect(sameProcessIdentity(saved, { ...saved, pid: 43 })).toBe(false)
    const { startTicks: _, ...legacy } = saved
    expect(sameProcessIdentity(legacy, saved)).toBe(true)
    expect(sameProcessIdentity(legacy, stepped)).toBe(false)
    expect(sameProcessIdentity(undefined, saved)).toBe(false)
    expect(processIdentityKey('codex', legacy)).not.toBe(processIdentityKey('codex', saved))
    expect(processIdentityOf({ ...stepped, parentPid: 1, args: 'codex' } as typeof stepped)).toEqual(stepped)
    expect(processIdentityOf(legacy)).toEqual(legacy)
  })

  it('rejects separator injection into stable keys', () => {
    expect(() => terminalRouteKey({ backend: 'tmux', paneId: '%1\u0000other' })).toThrow('invalid tmux pane id')
  })
})
