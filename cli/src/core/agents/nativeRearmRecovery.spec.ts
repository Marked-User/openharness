import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint, type CreationConfirmationFence } from '../../lib/agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnTarget } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { createNativeRearmProof, type NativeRearmReplacementProof } from '../../engines/kit/nativeRearmProof.js'
import { createNativeRearmRecovery, type NativeRearmRecoveryDeps } from './nativeRearmRecovery.js'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

async function fixture(count = 1, permissionMode?: 'full') {
  const root = mkdtempSync(join(tmpdir(), 'native-rearm-recovery-')); roots.push(root)
  const receipts = new AgentCreationReceipts(join(root, 'receipts'))
  const rows = new Map<string, RegisteredSession>()
  const physical = vi.fn(), held = vi.fn(), events: string[] = []
  for (let n = 0; n < count; n++) {
    const row = { schemaVersion: 3, agentId: `agent-${n}`, engine: 'cursor', sessionId: `conversation-${n}`, registeredAt: 1, boundAt: 2,
      active: true, cwd: '/fixture/project', transcriptPath: null, tmuxPane: `%${n + 1}`,
      primaryRuntimeKey: terminalRouteKey({ backend: 'tmux', paneId: `%${n + 1}` }),
      runtimes: [{ backend: 'tmux', paneId: `%${n + 1}` }], permissionMode: 'ask',
      processIdentity: { pid: 42 + n, executable: '<cursor>', startMarker: 'previous-birth' } } as RegisteredSession
    const target = nativeTurnTarget(row)
    row.nativeControl = { version: 1, cancel: { processKey: null, target, request: {
      requestId: `original-cancel-${n}`, nonce: 'original-cancel-nonce', agentId: row.agentId, conversationId: row.sessionId,
      frontier: { index: -1, digest: null },
    } }, rearm: { requestId: `original-native-rearm-${n}`, agentId: row.agentId, target, operation: 'resume', source: 'live',
      launchToken: `original-native-token-${n}`, ...(permissionMode ? { permissionMode } : {}) } }
    rows.set(row.agentId, row)
    const request = nativeRearmRequest(row.nativeControl)!, fingerprint = creationFingerprint({ kind: 'native-rearm',
      agentId: row.agentId, operation: 'resume', source: 'live', ...(permissionMode ? { permissionMode } : {}) })
    await receipts.runIntent(row.nativeControl.rearm!.requestId, fingerprint, request, { service: 'native', detail: 'Preparing' }, async () => async () => {
      physical()
      receipts.recordNativeRelaunchProcess(row.nativeControl!.rearm!.requestId, { fingerprint, request },
        { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: 100 + n, birth: '123456' }, { verify() {}, current() {} })
      return { state: 'unconfirmed' }
    })
  }
  const row = (n = 0) => rows.get(`agent-${n}`)!
  const retained = (input: RegisteredSession) => {
    const expected = structuredClone(input)
    const verify = () => {
      const current = rows.get(expected.agentId)
      if (!current || nativeTurnTarget(current) !== nativeTurnTarget(expected)
        || creationFingerprint(current.nativeControl ?? null) !== creationFingerprint(expected.nativeControl ?? null)) throw Error('Original row changed')
    }
    verify()
    return { intent: expected.nativeControl, verify, verifyDirectory: () => {} }
  }
  const evidence = (input: RegisteredSession, fence: CreationConfirmationFence): NativeRearmReplacementProof => {
    const n = Number(input.agentId.slice(6)), witness = receipts.readNativeRelaunchProcess(input.nativeControl!.rearm!.requestId, {
      fingerprint: creationFingerprint({ kind: 'native-rearm', agentId: input.agentId, operation: 'resume', source: 'live',
        ...(permissionMode ? { permissionMode } : {}) }), request: nativeRearmRequest(input.nativeControl!)!,
    })
    const current = () => { events.push('native-current'); fence.current() }
    return { key: `original-boot\0cursor\0${100 + n}\0original-birth`, evidence: 'native-image', pane: input.tmuxPane,
      source: { target: nativeTurnTarget(input), controlFingerprint: creationFingerprint(input.nativeControl), requestFingerprint: 'fixture' },
      processIdentity: { pid: 100 + n, executable: '<cursor>', startMarker: 'original-birth' }, current,
      verify() { events.push('native-source'); witness.verify(); fence.verify(); current() },
      verifyExecution() { events.push('native-exec'); witness.verify(); current() },
      verifyConfirmation() { events.push('native-confirm'); witness.verifyConfirmation(); current() },
    }
  }
  type Read = (...args: Parameters<NativeRearmRecoveryDeps['proof']>) => Promise<NativeRearmReplacementProof>
  const bound = vi.fn<Read>(
    async (row, _receipt, fence) => evidence(row, fence))
  const unbound = vi.fn<Read>(async (row, _receipt, fence) => evidence(row, fence))
  const track = (read: Read) => (...args: Parameters<Read>) => {
    const promise = read(...args)
    return Object.assign(promise, { settled: promise.then(() => {}, () => {}) })
  }
  const proof = Object.assign(track(bound), { recover: track(unbound) })
  const commit = vi.fn<NativeRearmRecoveryDeps['registry']['commitNativeReplacement']>((input, native, current) => {
    retained(input).verify(); native.verify(); current()
    events.push('commit')
    const result: RegisteredSession = { ...structuredClone(input), processIdentity: { ...native.processIdentity }, active: true, launch: { state: 'ready' },
      ...(permissionMode ? { permissionMode, bypassPermission: true } : {}),
      nativeControl: { ...input.nativeControl!, rearm: { ...input.nativeControl!.rearm!,
        replacement: { processKey: native.key, sessionId: input.sessionId } } },
    }
    rows.set(input.agentId, result)
    return result
  })
  const read = vi.fn(retained), source = vi.fn(retained), confirm = vi.spyOn(receipts, 'confirmNativeRelaunch')
  const deps: NativeRearmRecoveryDeps = { registry: { byAgent: id => rows.get(id), readNativeControl: read,
    readNativeReplacementSource: source, commitNativeReplacement: commit }, receipts, proof, held }
  const controller = createNativeRearmRecovery(deps)
  return { rows, row, deps, controller, physical, held, events, evidence, unbound, bound, commit, read, source, confirm, receipts }
}

it.each([undefined, 'full'] as const)('confirms the original dispatch and recovers its confirmed image without launching again (%s)', async permission => {
  const p = await fixture(1, permission), original = structuredClone(p.row()), input = structuredClone(original)
  expect(await p.controller.recover(input)).toEqual({ state: 'created', agentId: original.agentId, resumed: true })
  expect(p.source).toHaveBeenCalledOnce(); expect(p.unbound).toHaveBeenCalledOnce()
  expect(p.row().processIdentity?.pid).toBe(100)
  expect(p.row().permissionMode).toBe(permission ?? 'ask')
  expect(p.row().nativeControl?.cancel).toEqual(original.nativeControl!.cancel)
  expect(p.row().nativeControl?.rearm).toMatchObject(original.nativeControl!.rearm!)
  expect(input).toEqual(original)
  expect(p.events.indexOf('native-source')).toBeLessThan(p.events.indexOf('commit'))
  expect(p.events.lastIndexOf('native-exec')).toBeGreaterThan(p.events.indexOf('commit'))
  expect(await createNativeRearmRecovery(p.deps).recover(p.row())).toEqual({ state: 'created', agentId: original.agentId, resumed: true })
  expect(p.bound).toHaveBeenCalledOnce(); expect(p.commit).toHaveBeenCalledOnce(); expect(p.physical).toHaveBeenCalledOnce()
  expect(p.receipts.status(original.nativeControl!.rearm!.requestId).state).toBe('created')
})

it('recovers a crash between durable replacement and creation confirmation without another commit', async () => {
  const p = await fixture()
  p.confirm.mockImplementationOnce(() => { throw Error('Confirmation unavailable') })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('Confirmation unavailable') } })
  expect(p.row().nativeControl?.rearm?.replacement).toBeDefined()
  expect(await createNativeRearmRecovery(p.deps).recover(p.row())).toMatchObject({ state: 'created', resumed: true })
  expect(p.commit).toHaveBeenCalledOnce(); expect(p.physical).toHaveBeenCalledOnce()
})

it.each(['absent', 'non-cursor', 'unbound', 'no-rearm', 'incomplete', 'saved', 'revoked'])('holds %s reservations without native reads', async kind => {
  const p = await fixture(), row = p.row()
  if (kind === 'absent') delete row.nativeControl
  if (kind === 'non-cursor') row.engine = 'codex'
  if (kind === 'unbound') row.sessionId = ''
  if (kind === 'no-rearm') delete (row.nativeControl as { rearm?: unknown }).rearm
  if (kind === 'incomplete') delete (row.nativeControl!.rearm as { source?: unknown }).source
  if (kind === 'saved') row.nativeControl = { ...row.nativeControl!, rearm: { ...row.nativeControl!.rearm!, source: 'saved' } }
  if (kind === 'revoked') row.nativeControl = { ...row.nativeControl!, rearm: { ...row.nativeControl!.rearm!, revoked: true } }
  expect(await p.controller.recover(row)).toMatchObject({ state: 'pending' })
  expect(p.unbound).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
})

it.each(['cancel', 'target', 'removed', 'revoke', 'close', 'deadline'])('revokes a delayed proof after %s', async kind => {
  const p = await fixture(), wait = deferred<void>(), now = vi.spyOn(performance, 'now').mockReturnValue(100)
  p.unbound.mockImplementationOnce(async (row, _receipt, fence) => { const proof = p.evidence(row, fence); await wait.promise; return proof })
  const pending = p.controller.recover(p.row())
  if (kind === 'cancel') p.row().nativeControl = { ...p.row().nativeControl!, rearm: { ...p.row().nativeControl!.rearm!, revoked: true } }
  if (kind === 'target') p.row().tmuxPane = '%99'
  if (kind === 'removed') p.rows.clear()
  if (kind === 'revoke') { p.controller.revoke('missing'); p.controller.revoke('agent-0') }
  if (kind === 'close') p.controller.close()
  if (kind === 'deadline') now.mockReturnValue(5100)
  wait.resolve()
  expect(await pending).toMatchObject({ state: 'pending' })
  expect(p.commit).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
  if (['cancel', 'target', 'removed', 'revoke', 'close'].includes(kind)) expect(p.held).not.toHaveBeenCalled()
})

it('checks the original owner after source verification and before native inspection', async () => {
  const p = await fixture()
  p.source.mockImplementationOnce(input => { p.row().active = false; return { intent: input.nativeControl, verify() {}, verifyDirectory() {} } })
  p.unbound.mockImplementationOnce(async (row, _request, fence) => { fence.verify(); return p.evidence(row, fence) })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.commit).not.toHaveBeenCalled()
})

it.each(['native-source', 'native-exec', 'native-confirm', 'published', 'receipt-current', 'post-receipt'])('retains %s evidence through confirmation', async kind => {
  const p = await fixture()
  p.unbound.mockImplementationOnce(async (row, _request, fence) => {
    const native = p.evidence(row, fence)
    if (kind === 'native-source') return { ...native, verify() { throw Error('Original native source changed') } }
    if (kind === 'native-exec') return { ...native, verifyExecution() { throw Error('Original exec changed') } }
    if (kind === 'native-confirm') return { ...native, verifyConfirmation() { throw Error('Original confirming witness changed') } }
    if (kind === 'receipt-current') {
      const current = native.current
      return { ...native, current() { current(); p.controller.revoke('agent-0') } }
    }
    return native
  })
  if (kind === 'published') p.read.mockImplementationOnce(input => ({ intent: input.nativeControl, verify() { throw Error('Published image changed') }, verifyDirectory() {} }))
  if (kind === 'post-receipt') {
    const confirm = p.receipts.confirmNativeRelaunch.bind(p.receipts)
    p.confirm.mockImplementationOnce((...args) => { const answer = confirm(...args); p.row().active = false; return answer })
  }
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  if (kind === 'native-source') expect(p.commit).not.toHaveBeenCalled()
  if (['native-source', 'native-exec', 'published'].includes(kind)) expect(p.confirm).not.toHaveBeenCalled()
})

it('returns a held reason for non-Error native failures', async () => {
  const p = await fixture(); p.unbound.mockRejectedValueOnce('Native evidence unavailable')
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('Native evidence unavailable') } })
})

it('keeps all four actual read slots after bounded replies, and releases only a settled original read', async () => {
  const p = await fixture(5), waits = Array.from({ length: 4 }, () => deferred<void>())
  vi.useFakeTimers()
  p.unbound.mockImplementation(async (row, _request, fence) => {
    const native = p.evidence(row, fence), n = Number(row.agentId.slice(6))
    if (n < waits.length) await waits[n].promise
    return native
  })
  const input = structuredClone(p.row()), pending = [p.controller.recover(input), ...[1, 2, 3].map(n => p.controller.recover(p.row(n)))]
  input.agentId = 'changed-by-caller'
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('occupied') } })
  expect(await p.controller.recover(p.row(4))).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('occupied') } })
  await vi.advanceTimersByTimeAsync(5000)
  expect((await Promise.all(pending)).map(status => status.state)).toEqual(['pending', 'pending', 'pending', 'pending'])
  expect(await p.controller.recover(p.row(4))).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('occupied') } })
  const publishedHolds = p.held.mock.calls.length
  waits[0].resolve(); await flush()
  expect(p.held.mock.calls.length).toBe(publishedHolds)
  expect(await p.controller.recover(p.row(4))).toMatchObject({ state: 'created' })
  expect(p.unbound).toHaveBeenCalledTimes(5); expect(p.commit).toHaveBeenCalledOnce()
  p.controller.close()
  waits.slice(1).forEach(wait => wait.resolve()); await flush()
  expect(p.commit).toHaveBeenCalledOnce()
})

it('does not admit new recovery or publish holds after shutdown', async () => {
  const p = await fixture(); p.controller.close()
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.held).not.toHaveBeenCalled(); expect(p.unbound).not.toHaveBeenCalled()
})

it('retains four real reader observations after their own earlier reply deadline', async () => {
  const p = await fixture(5), waits = Array.from({ length: 5 }, () => deferred<void>())
  const probe = vi.fn(async () => { const n = probe.mock.calls.length - 1; await waits[n].promise; throw Error('Expired native read') })
  const inspect = vi.fn(async () => { throw Error('No native process may be inspected after the expired probe') })
  const proof = createNativeRearmProof({ receipts: p.receipts, owner: 'a'.repeat(16),
    boot: async () => 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    pane: async () => ({ rootPid: 10, command: 'original-command' }), probe, inspect })
  const controller = createNativeRearmRecovery({ ...p.deps, proof })
  vi.useFakeTimers()
  const pending = [0, 1, 2, 3].map(n => controller.recover(p.row(n)))
  try {
    await flush(); expect(probe).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(3001)
    expect((await Promise.all(pending)).every(status => status.state === 'pending')).toBe(true)
    const refused = controller.recover(p.row(4)); pending.push(refused); await flush()
    expect(probe).toHaveBeenCalledTimes(4)
    expect(await refused).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('occupied') } })
    waits[0].resolve(); await flush()
    const fifth = controller.recover(p.row(4)); pending.push(fifth); await flush()
    expect(probe).toHaveBeenCalledTimes(5)
    controller.close()
    waits.slice(1).forEach(wait => wait.resolve()); await flush()
    expect(await fifth).toMatchObject({ state: 'pending' })
    expect(inspect).not.toHaveBeenCalled(); expect(p.commit).not.toHaveBeenCalled()
  } finally {
    controller.close(); waits.forEach(wait => wait.resolve())
    await vi.runOnlyPendingTimersAsync(); await Promise.all(pending)
  }
})

it('does not let a revoked read publish a hold when its reply timer expires', async () => {
  const p = await fixture(), wait = deferred<void>()
  p.unbound.mockImplementationOnce(async (row, _receipt, fence) => { const proof = p.evidence(row, fence); await wait.promise; return proof })
  vi.useFakeTimers()
  const pending = p.controller.recover(p.row())
  p.controller.revoke('agent-0')
  await vi.advanceTimersByTimeAsync(5000)
  expect(await pending).toMatchObject({ state: 'pending' })
  expect(p.held).not.toHaveBeenCalled()
  wait.resolve(); await flush()
  expect(p.held).not.toHaveBeenCalled(); expect(p.commit).not.toHaveBeenCalled()
})

it('requires the exact confirmation publisher to retain its final proof', async () => {
  const p = await fixture()
  p.confirm.mockReturnValueOnce({ state: 'created', agentId: 'agent-0', resumed: true })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('confirmation proof is unavailable') } })
})

it.each(['native-failure', 'timeout'])('settles %s even when the held notification throws', async kind => {
  const p = await fixture(), wait = deferred<void>()
  p.held.mockImplementation(() => { throw Error('Presentation failed') })
  p.unbound.mockImplementationOnce(async () => { if (kind === 'timeout') await wait.promise; throw Error('Read failed') })
  vi.useFakeTimers()
  const pending = p.controller.recover(p.row())
  if (kind === 'timeout') await vi.advanceTimersByTimeAsync(5000)
  expect(await pending).toMatchObject({ state: 'pending', held: { service: 'native' } })
  expect(p.held).toHaveBeenCalledOnce()
  wait.resolve(); await flush()
  expect(p.commit).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
})
