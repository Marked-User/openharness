import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyEvent, PtyOp } from './ptyHost/protocol.js'
import type { PtyHostClient } from './ptyHost/client.js'
import type { EnsurePtyHostResult } from './ptyHost/launch.js'
import type { PtyRuntimeRef } from './terminalTypes.js'

// validate's branches, not the process table: the same narrow mock tmuxBackendValidate.spec.ts uses.
const lookupPaneEngineProcess = vi.hoisted(() => vi.fn())
vi.mock('./paneEngineProcess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./paneEngineProcess.js')>()),
  lookupPaneEngineProcess,
}))

const { PtyHostBackend } = await import('./ptyHostBackend.js')

type Reply = unknown | ((op: PtyOp) => unknown)

/** A backend over a stub client: [replies] by op name, an `ok {}` for the rest. */
function backendWith(replies: Record<string, Reply>, options: { owner?: string } = {}) {
  const calls: PtyOp[] = []
  const listeners = new Set<(event: PtyEvent) => void>()
  const client = {
    instance: 'p1',
    call: async (op: PtyOp) => {
      calls.push(op)
      const reply = replies[op.op]
      return (typeof reply === 'function' ? reply(op) : reply) ?? { state: 'ok', value: {} }
    },
    onEvent: (listener: (event: PtyEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onClose: () => () => {},
    close() {},
  }
  const backend = new PtyHostBackend({
    home: '/tmp/h',
    launch: async () => ({ client: client as unknown as PtyHostClient }),
    owner: () => options.owner ?? 'me',
  })
  const emit = (event: PtyEvent) => { for (const listener of listeners) listener(event) }
  return { backend, calls, emit }
}

async function ready(replies: Record<string, Reply> = {}, options: { owner?: string } = {}) {
  const made = backendWith(replies, options)
  expect(await made.backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
  return made
}

const PANE: PtyRuntimeRef = { backend: 'ptyhost', instance: 'p1', paneId: '%1' }
const UUID = /^[a-f0-9-]{36}$/

afterEach(() => {
  vi.useRealTimers()
  lookupPaneEngineProcess.mockReset()
})

describe('PtyHostBackend prepare', () => {
  it('takes its instance from the host it reached', async () => {
    const { backend } = await ready()
    expect(backend.name).toBe('ptyhost')
    expect(backend.instanceId).toBe('ptyhost:p1')
    expect(await backend.capabilities()).toEqual({ sessionEnv: true })
  })

  it('says the host is unavailable, with its code', async () => {
    const backend = new PtyHostBackend({ home: '/tmp/h', launch: async () => ({ unavailable: 'harness-pty is not installed', code: 'PTY_HOST_UNAVAILABLE' }) })
    expect(await backend.prepare({ ownedPanes: new Map() }))
      .toEqual({ state: 'unavailable', code: 'PTY_HOST_UNAVAILABLE', reason: 'harness-pty is not installed' })
    expect(await backend.inventory()).toEqual({ state: 'unavailable', reason: 'pty host is unavailable' })
    expect(await backend.create({ command: ['/bin/sh'] })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
  })

  it('reads an incompatible host as unavailable, saying why', async () => {
    const launch = async (): Promise<EnsurePtyHostResult> => ({ incompatible: 'incompatible: wrong token' })
    const backend = new PtyHostBackend({ home: '/tmp/h', launch })
    expect(await backend.prepare({ ownedPanes: new Map() }))
      .toEqual({ state: 'unavailable', code: 'PTY_HOST_UNAVAILABLE', reason: 'incompatible: wrong token' })
  })
})

describe('PtyHostBackend create', () => {
  it('asks for a held 200x50 pane owned by this daemon', async () => {
    const { backend, calls } = await ready({ create: { state: 'ok', value: { pane: '%4' } } })
    const result = await backend.create({ command: ['claude'], cwd: '/w', label: 'harness-claude-1', env: { K: 'v' } })
    expect(result).toEqual({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'ptyhost', instance: 'p1', paneId: '%4' } })
    expect(calls).toEqual([{ op: 'create', command: ['claude'], cwd: '/w', env: { K: 'v' }, cols: 200, rows: 50, owner: 'me', label: 'harness-claude-1', hold: true }])
  })

  it('runs the shell when given no command', async () => {
    const { backend, calls } = await ready({ create: { state: 'ok', value: { pane: '%4' } } })
    await backend.create({})
    const expected = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL || '/bin/sh'
    expect(calls[0]).toMatchObject({ op: 'create', command: [expected] })
  })

  it('sends nothing once the harness has changed', async () => {
    const { backend, calls } = await ready()
    const dispatched = vi.fn()
    expect(await backend.create({ command: ['sh'], current: () => false, onDispatch: dispatched }))
      .toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(calls).toEqual([])
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('passes a host refusal on as it is', async () => {
    const { backend } = await ready({ create: { state: 'failed', dispatch: 'rejected', code: 'spawn_failed', reason: 'no such file' } })
    expect(await backend.create({ command: ['nope'] })).toEqual({ state: 'failed', dispatch: 'rejected', reason: 'no such file' })
  })

  it('records the pane before an exit that overtook its reply is released', async () => {
    // The client holds an exit that came in before the create reply and releases it on setImmediate
    // (client.ts): the create's own continuation must already know the pane by then.
    let emit: (event: PtyEvent) => void = () => {}
    const made = await ready({
      create: () => {
        setImmediate(() => emit({ event: 'exit', pane: '%9', status: 3 }))
        return { state: 'ok', value: { pane: '%9' } }
      },
    })
    emit = made.emit
    const created = await made.backend.create({ command: ['sh', '-c', 'exit 3'] })
    expect(created.state).toBe('succeeded')
    await new Promise((resolve) => setImmediate(resolve))
    expect(made.backend.known({ ...PANE, paneId: '%9' })).toEqual({ hold: true, exited: 3 })
  })
})

describe('PtyHostBackend pane records', () => {
  it('forgets a pane whose process ended once it is no longer held', async () => {
    const { backend, emit } = await ready({ create: { state: 'ok', value: { pane: '%1' } } })
    await backend.create({ command: ['sh'] })
    await backend.releaseHold(PANE)
    expect(backend.known(PANE)).toEqual({ hold: false })
    emit({ event: 'exit', pane: '%1', status: 0 })
    expect(backend.known(PANE)).toBeUndefined()
  })

  it('forgets a held pane that already exited when its hold is released', async () => {
    const { backend, emit, calls } = await ready({ create: { state: 'ok', value: { pane: '%1' } } })
    await backend.create({ command: ['sh'] })
    emit({ event: 'exit', pane: '%1', status: 1 })
    await backend.releaseHold(PANE)
    expect(calls.at(-1)).toEqual({ op: 'releaseHold', pane: '%1' })
    expect(backend.known(PANE)).toBeUndefined()
  })

  it('ignores exits of panes it never made', async () => {
    const { backend, emit } = await ready()
    emit({ event: 'exit', pane: '%7', status: 0 })
    emit({ event: 'title', pane: '%7', title: 't' })
    expect(backend.known({ ...PANE, paneId: '%7' })).toBeUndefined()
  })

  it('a release the harness changed before sends nothing', async () => {
    const { backend, calls } = await ready()
    await backend.releaseHold(PANE, () => false)
    expect(calls).toEqual([])
  })
})

describe('PtyHostBackend kill', () => {
  it('kills with a 2 s grace and forgets the pane', async () => {
    const { backend, calls } = await ready({ create: { state: 'ok', value: { pane: '%1' } } })
    await backend.create({ command: ['sh'] })
    expect(await backend.kill(PANE)).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls.at(-1)).toEqual({ op: 'kill', pane: '%1', graceMs: 2000 })
    expect(backend.known(PANE)).toBeUndefined()
  })

  it('checks the stop is still current right before the call', async () => {
    const { backend, calls } = await ready()
    expect(await backend.kill(PANE, () => false)).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(calls).toEqual([])
  })

  it('a pane the host no longer has is already closed', async () => {
    const { backend } = await ready({ kill: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'no pane %1' } })
    expect(await backend.kill(PANE)).toEqual({ state: 'succeeded', dispatch: 'executed' })
  })

  it('an unanswered kill may have happened', async () => {
    const { backend } = await ready({ kill: { state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' } })
    expect(await backend.kill(PANE)).toEqual({ state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' })
  })
})

describe('PtyHostBackend inventory and titles', () => {
  it('inventory unavailable when the host call fails', async () => {
    const { backend } = backendWith({ inventory: { state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' } })
    await backend.prepare({ ownedPanes: new Map() })
    expect(await backend.inventory()).toEqual({ state: 'unavailable', reason: 'timeout' })
  })

  it('lists this daemon\'s live panes', async () => {
    const row = (pane: string, owner: string, rootPid: number | null) => ({ pane, rootPid, cwd: `/w${pane}`, title: '', dead: rootPid === null, owner, label: null })
    const { backend } = await ready({
      inventory: { state: 'ok', value: { panes: [row('%1', 'me', 11), row('%2', 'other', 12), row('%3', 'me', null)] } },
    })
    expect(await backend.inventory()).toEqual({
      state: 'available',
      roots: [{ runtime: { backend: 'ptyhost', instance: 'p1', paneId: '%1' }, rootPid: 11, cwd: '/w%1' }],
    })
  })

  it('keys titles by route', async () => {
    const { backend } = await ready({ titles: { state: 'ok', value: { titles: { '%1': 'one' } } } })
    const titles = await backend.titles()
    expect(titles).toEqual({ state: 'succeeded', value: new Map([['ptyhost\u0000p1\u0000%1', 'one']]) })
  })

  it('titles fail when the host does not answer', async () => {
    const { backend } = await ready({ titles: { state: 'failed', dispatch: 'not_started', code: 'not_connected', reason: 'closed' } })
    expect(await backend.titles()).toEqual({ state: 'failed', reason: 'closed' })
  })
})

describe('PtyHostBackend reads', () => {
  it('rootProcess says missing for no_pane', async () => {
    const { backend } = backendWith({ paneInfo: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'x' } })
    await backend.prepare({ ownedPanes: new Map() })
    expect(await backend.rootProcess({ backend: 'ptyhost', instance: 'p1', paneId: '%3' })).toBe('missing')
  })

  it('rootProcess names the pid, null when it could not ask', async () => {
    const info = { command: 'sh', path: '/w', pid: 42, tty: '/dev/ttys001' }
    expect(await (await ready({ paneInfo: { state: 'ok', value: { info } } })).backend.rootProcess(PANE)).toBe(42)
    expect(await (await ready({ paneInfo: { state: 'unknown', dispatch: 'possibly_executed', reason: 't' } })).backend.rootProcess(PANE)).toBeNull()
  })

  it('rootProcess of a held pane whose process ended is missing: no process runs there', async () => {
    const info = { command: 'sh', path: '/w', pid: null, tty: '/dev/ttys001' }
    expect(await (await ready({ paneInfo: { state: 'ok', value: { info } } })).backend.rootProcess(PANE)).toBe('missing')
  })

  it('paneInfo passes the host\'s answer on, null otherwise', async () => {
    const info = { command: 'sh', path: '/w', pid: 42, tty: '/dev/ttys001' }
    expect(await (await ready({ paneInfo: { state: 'ok', value: { info } } })).backend.paneInfo(PANE)).toEqual(info)
    expect(await (await ready({ paneInfo: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'x' } })).backend.paneInfo(PANE)).toBeNull()
  })

  it('paneState: gone, unknown, or the pane as tmux would describe it', async () => {
    expect(await (await ready({ paneState: { state: 'ok', value: { state: 'gone' } } })).backend.paneState(PANE)).toBe('gone')
    expect(await (await ready({ paneState: { state: 'unknown', dispatch: 'possibly_executed', reason: 't' } })).backend.paneState(PANE)).toBe('unknown')
    const state = { dead: true, exitStatus: 3, command: ['/usr/local/bin/claude', '--x'], engineExit: 2, heldToken: null }
    expect(await (await ready({ paneState: { state: 'ok', value: { state } } })).backend.paneState(PANE))
      .toEqual({ dead: true, exitStatus: 3, command: 'claude', engineExit: 2 })
  })

  it('reads nothing from a pane of another host instance', async () => {
    const { backend, calls } = await ready()
    const other: PtyRuntimeRef = { ...PANE, instance: 'p2' }
    expect(await backend.paneState(other)).toBe('unknown')
    expect(await backend.rootProcess(other)).toBeNull()
    expect(await backend.typeLiteral(other, 'x')).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(calls).toEqual([])
  })
})

describe('PtyHostBackend capture', () => {
  async function captured(options?: Parameters<InstanceType<typeof PtyHostBackend>['capture']>[1]) {
    const { backend, calls } = await ready({ capture: { state: 'ok', value: { text: 'screen' } } })
    expect(await backend.capture(PANE, options)).toEqual({ state: 'succeeded', value: 'screen' })
    return calls[0]
  }

  it('visible: the screen alone', async () => {
    expect(await captured({ mode: 'visible', ansi: false })).toEqual({ op: 'capture', pane: '%1', visible: true, ansi: false })
  })

  it('recent_unwrapped: history lines, bounded as tmuxCaptureArgs bounds them, ansi unless told not', async () => {
    expect(await captured({ mode: 'recent_unwrapped', historyLines: 50 })).toEqual({ op: 'capture', pane: '%1', visible: false, historyLines: 50, ansi: true })
    expect(await captured({ mode: 'recent_unwrapped', historyLines: 5000, ansi: false })).toMatchObject({ historyLines: 300, ansi: false })
    expect(await captured({ historyLines: 1 })).toMatchObject({ historyLines: 20, visible: false })
    expect(await captured()).toMatchObject({ historyLines: 100, visible: false, ansi: true })
  })

  it('detection: 40 plain lines unless told otherwise', async () => {
    expect(await captured({ mode: 'detection' })).toEqual({ op: 'capture', pane: '%1', visible: false, historyLines: 40, ansi: false })
    expect(await captured({ mode: 'detection', historyLines: 80, ansi: true })).toMatchObject({ historyLines: 80, ansi: true })
  })

  it('a failed capture says why', async () => {
    const { backend } = await ready({ capture: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'no pane %1' } })
    expect(await backend.capture(PANE)).toEqual({ state: 'failed', reason: 'no pane %1' })
  })
})

describe('PtyHostBackend input', () => {
  it('typeLiteral types the text unbracketed, as tmux types it', async () => {
    const { backend, calls } = await ready()
    expect(await backend.typeLiteral(PANE, 'héllo')).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls).toEqual([{ op: 'paste', pane: '%1', text: 'héllo', bracketed: false }])
  })

  it('sendKey sends the tmux name of the key', async () => {
    const { backend, calls } = await ready()
    await backend.sendKey(PANE, 'backtab')
    await backend.sendKey(PANE, 'ctrl-c')
    expect(calls).toEqual([{ op: 'key', pane: '%1', key: 'BTab' }, { op: 'key', pane: '%1', key: 'C-c' }])
  })

  it('submitText withholds Enter when beforeEnter objects', async () => {
    const { backend, calls } = backendWith({})
    await backend.prepare({ ownedPanes: new Map() })
    const result = await backend.submitText({ backend: 'ptyhost', instance: 'p1', paneId: '%1' }, 'hi', { beforeEnter: async () => 'dialog' })
    expect(result).toMatchObject({ state: 'unknown', reason: 'enter_withheld:dialog' })
    expect(calls.some((c) => c.op === 'key')).toBe(false)
  })

  it('submitText pastes bracketed, without trailing newlines, then presses Enter', async () => {
    const { backend, calls } = await ready()
    const beforeEnter = vi.fn(async () => null)
    expect(await backend.submitText(PANE, 'hi\n\n', { beforeEnter })).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls).toEqual([{ op: 'paste', pane: '%1', text: 'hi', bracketed: true }, { op: 'key', pane: '%1', key: 'Enter' }])
    expect(beforeEnter).toHaveBeenCalledOnce()
  })

  it('submitText gives a multi-line paste time to settle before Enter', async () => {
    vi.useFakeTimers()
    const { backend, calls } = await ready()
    const text = 'one\ntwo'
    const sent = backend.submitText(PANE, text)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map((c) => c.op)).toEqual(['paste'])
    await vi.advanceTimersByTimeAsync(399)
    expect(calls.map((c) => c.op)).toEqual(['paste'])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.op)).toEqual(['paste', 'key'])
    expect(await sent).toEqual({ state: 'succeeded', dispatch: 'executed' })
  })

  it('submitText stops before the paste, and before the Enter, once control is revoked', async () => {
    const before = await ready()
    expect(await before.backend.submitText(PANE, 'hi', { allowed: () => false })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(before.calls).toEqual([])
    const after = await ready()
    let allowed = true
    const result = await after.backend.submitText(PANE, 'hi', { allowed: () => allowed, beforeEnter: async () => { allowed = false; return null } })
    expect(result).toMatchObject({ state: 'unknown', reason: 'enter_withheld:terminal control revoked' })
    expect(after.calls.map((c) => c.op)).toEqual(['paste'])
  })

  it('submitText reports a paste the host refused and presses no Enter', async () => {
    const { backend, calls } = await ready({ paste: { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'pane %1 has exited' } })
    expect(await backend.submitText(PANE, 'hi')).toEqual({ state: 'failed', dispatch: 'rejected', reason: 'pane %1 has exited' })
    expect(calls.map((c) => c.op)).toEqual(['paste'])
  })

  it('setTitle sets it on the host; notify needs nothing', async () => {
    const { backend, calls } = await ready()
    expect(await backend.setTitle(PANE, 'x'.repeat(300))).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(await backend.notify(PANE, 'done', 'body')).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls).toEqual([{ op: 'setTitle', pane: '%1', title: 'x'.repeat(200) }])
  })
})

describe('PtyHostBackend hold and respawn', () => {
  it('holdOpen holds the pane under a fresh token that respawn then expects', async () => {
    const { backend, calls } = await ready()
    expect(await backend.holdOpen(PANE)).toEqual({ state: 'succeeded', dispatch: 'executed' })
    const hold = calls[0]
    if (hold.op !== 'holdOpen') throw new Error('expected holdOpen')
    expect(hold.token).toMatch(UUID)
    expect(await backend.respawn(PANE, { command: ['claude'], cwd: '/w', env: { K: 'v' } })).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls[1]).toEqual({ op: 'respawn', pane: '%1', command: ['claude'], cwd: '/w', env: { K: 'v' }, expectedHeldToken: hold.token })
  })

  it('every holdOpen has a token of its own', async () => {
    const { backend, calls } = await ready()
    await backend.holdOpen(PANE)
    await backend.holdOpen(PANE)
    const tokens = calls.map((c) => c.op === 'holdOpen' ? c.token : undefined)
    expect(tokens[0]).not.toBe(tokens[1])
  })

  it('a token the caller holds wins, and a pane held by another is not replaced', async () => {
    const { backend, calls } = await ready({ respawn: { state: 'failed', dispatch: 'rejected', code: 'held_mismatch', reason: 'pane %1 is held by another token' } })
    const token = '0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c'
    expect(await backend.respawn(PANE, { command: ['sh'], expectedHeldToken: token }))
      .toEqual({ state: 'failed', dispatch: 'not_started', reason: 'The waiting pane changed' })
    expect(calls[0]).toEqual({ op: 'respawn', pane: '%1', command: ['sh'], expectedHeldToken: token })
  })

  it('respawn without a hold sends no token, and nothing once the harness changed', async () => {
    const { backend, calls } = await ready()
    await backend.respawn(PANE, { command: ['sh'] })
    expect(calls[0]).toEqual({ op: 'respawn', pane: '%1', command: ['sh'] })
    const dispatched = vi.fn()
    expect(await backend.respawn(PANE, { command: ['sh'], current: () => false, onDispatch: dispatched })).toMatchObject({ dispatch: 'not_started' })
    expect(await backend.holdOpen(PANE, () => false)).toMatchObject({ dispatch: 'not_started' })
    expect(calls).toHaveLength(1)
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('releaseHold drops the token, so a later respawn expects none', async () => {
    const { backend, calls } = await ready()
    await backend.holdOpen(PANE)
    await backend.releaseHold(PANE)
    await backend.respawn(PANE, { command: ['sh'] })
    expect(calls.at(-1)).toEqual({ op: 'respawn', pane: '%1', command: ['sh'] })
  })

  it('isHeld: a dead pane under this token', async () => {
    const token = '0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c'
    const state = (dead: boolean, heldToken: string | null) => ({ state: 'ok', value: { state: { dead, exitStatus: 0, command: ['sh'], engineExit: null, heldToken } } })
    expect(await (await ready({ paneState: state(true, token) })).backend.isHeld(PANE, token)).toBe(true)
    expect(await (await ready({ paneState: state(false, token) })).backend.isHeld(PANE, token)).toBe(false)
    expect(await (await ready({ paneState: state(true, 'other') })).backend.isHeld(PANE, token)).toBe(false)
    expect(await (await ready({ paneState: { state: 'ok', value: { state: 'gone' } } })).backend.isHeld(PANE, token)).toBe(false)
    expect(await (await ready({ paneState: { state: 'unknown', dispatch: 'possibly_executed', reason: 't' } })).backend.isHeld(PANE, token)).toBe('unknown')
  })
})

describe('PtyHostBackend validate', () => {
  const LIVE = { pid: 15160, executable: '/usr/local/bin/claude', startMarker: 'Tue Sep 15 23:10:38 2026' }

  it('alive when the pane runs the recorded process', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: LIVE })
    expect(await backend.validate(PANE, { engine: 'claude', processIdentity: LIVE })).toEqual({ state: 'alive' })
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'alive' })
    expect(lookupPaneEngineProcess).toHaveBeenCalledWith(backend, PANE, 'claude')
  })

  it('replaced when the pane runs another process of the engine', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: LIVE })
    const saved = { ...LIVE, pid: 999, startMarker: 'Mon Sep 14 08:00:00 2026' }
    expect(await backend.validate(PANE, { engine: 'claude', processIdentity: saved }))
      .toEqual({ state: 'gone', reason: 'process changed under ptyhost pane', replaced: true })
  })

  it('takes a marker written before psEnv, which no live process can match', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: LIVE })
    expect(await backend.validate(PANE, { engine: 'claude', processIdentity: { ...LIVE, startMarker: 'K szept. 15 23:10:38 2026' } }))
      .toEqual({ state: 'alive' })
  })

  it('gone and unknown as the lookup says, unknown when it throws', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValueOnce({ ok: false, unknown: false, reason: 'ptyhost:p1:%1 has no pane' })
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'gone', reason: 'ptyhost:p1:%1 has no pane' })
    lookupPaneEngineProcess.mockResolvedValueOnce({ ok: false, unknown: true, reason: 'ptyhost:p1:%1 could not be resolved' })
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'unknown', reason: 'ptyhost:p1:%1 could not be resolved' })
    lookupPaneEngineProcess.mockRejectedValueOnce(new Error('boom'))
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'unknown', reason: 'pty host runtime probe failed' })
  })
})
