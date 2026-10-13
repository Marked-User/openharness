import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentCreationReceipts } from '../../lib/agentCreationReceipt.js'
import { controlIdentity, type NativeControlRow } from '../../lib/nativeProcessControl.js'
import type { ProcessEvidence } from '../../lib/processEvidence.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { ProcessRow } from '../../lib/tmux.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { createNativeRearmProof, inspectNativeRearmPane, nativeRearmEngine, readNativeRearmPane } from './nativeRearmProof.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../../lib/engineBin.js', () => ({ enginePathOverride: () => undefined }))
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
const bootId = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const token = 'original-replacement-token', id = 'original-replacement-request', target = 'a'.repeat(64)
const owner = 'a'.repeat(16)
beforeEach(() => { clock.now = 0; vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function fixture() {
  const control = { version: 1, cancel: { processKey: 'old-owner', target, request: {
    requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: 'fixture-agent', conversationId: 'fixture-session',
    frontier: { index: -1, digest: null },
  } }, rearm: { requestId: id, agentId: 'fixture-agent', operation: 'restart', launchToken: token, target } }
  const row = { schemaVersion: 3, agentId: 'fixture-agent', engine: 'cursor', active: true, sessionId: 'fixture-session', nativeControl: control,
    tmuxPane: '%1', primaryRuntimeKey: 'tmux:%1', runtimes: [{ backend: 'tmux', paneId: '%1' }],
    processIdentity: { pid: 42, executable: 'cursor-agent', startMarker: 'fixture-birth' } } as RegisteredSession
  const request = { fingerprint: 'b'.repeat(64), request: { kind: 'native-rearm', creationId: id, agentId: row.agentId,
    operation: 'restart', launchToken: token, target } }
  const root: NativeControlRow = { pid: 10, parentPid: 2, birth: '1000', command: 'bash', imagePath: '/bin/bash', argv: ['bash'], fds: [] }
  const engine: NativeControlRow = { pid: 42, parentPid: 10, birth: '4200', command: 'cursor-agent', imagePath: '/fixture/cursor-agent',
    argv: ['cursor-agent'], fds: [] }
  const rows = new Map([[10, root], [42, engine]])
  const witness = { boot: bootId, pid: 42, birth: '4200' }
  const retained = vi.fn(), local = vi.fn(), receiptProof = vi.fn()
  const receipts = { readNativeRelaunchProcess: vi.fn(() => ({ process: { ...witness }, verify: receiptProof })) } satisfies Pick<AgentCreationReceipts, 'readNativeRelaunchProcess'>
  const pane = vi.fn(async () => ({ rootPid: 10, command: 'original-command' }))
  const boot = vi.fn(async () => bootId)
  const probe = vi.fn(async () => ({ parent: 0, children: [], rows: new Map([...rows].map(([pid, row]) => [pid, structuredClone(row)])) }))
  const inspect = vi.fn(async (): Promise<ProcessEvidence> => ({
    parent: { pid: 42, parentPid: 10, executable: 'cursor-agent', args: 'cursor-agent', startMarker: 'fixture-birth',
      imagePath: engine.imagePath, nativeBirth: engine.birth, evidence: controlIdentity(engine), controlIdentity: controlIdentity(engine) },
    children: [], verify: async () => {}, verifyDescriptors: async () => {},
  }))
  const read = createNativeRearmProof({ receipts, owner, pane, boot, inspect, probe })
  const fence = { verify: retained, current: local }
  return { row, request, root, engine, rows, witness, retained, local, receiptProof, receipts, pane, boot, probe, inspect, read,
    fence, run: () => read(row, request, fence) }
}

it('proves only the recorded Cursor incarnation and original direct pane placement', async () => {
  const p = fixture(), proof = await p.run()
  expect(proof).toMatchObject({ key: `${bootId}\0cursor\x0042\x004200`, evidence: controlIdentity(p.engine) })
  expect(p.receipts.readNativeRelaunchProcess).toHaveBeenCalledWith(id, p.request)
  expect(p.probe.mock.calls).toHaveLength(2)
  expect(p.pane.mock.calls).toHaveLength(2)
  expect(p.inspect).toHaveBeenCalledWith(42, expect.any(NativeEvidenceBudget), undefined, p.row.processIdentity)
  expect(p.receiptProof).toHaveBeenCalledOnce()
  proof.verify(); expect(p.receiptProof).toHaveBeenCalledTimes(2)
  p.receiptProof.mockImplementation(() => { throw Error('witness replaced') })
  expect(proof.verify).toThrow('witness replaced')
})

it.each(['same', 'source', 'permission', 'omitted'] as const)('proves replacement only for %s reserved launch options', async change => {
  const p = fixture()
  p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!,
    operation: 'resume', source: 'saved', permissionMode: 'full' } }
  const request: Record<string, unknown> = p.request.request
  Object.assign(request, { operation: 'resume', source: 'saved', permissionMode: 'full' })
  if (change === 'source') request.source = 'live'
  if (change === 'permission') request.permissionMode = 'ask'
  if (change === 'omitted') delete request.permissionMode
  if (change === 'same') expect((await p.run()).key).toContain('cursor')
  else {
    await expect(p.run()).rejects.toThrow('reservation or current binding')
    expect(p.probe).not.toHaveBeenCalled()
    expect(p.receipts.readNativeRelaunchProcess).not.toHaveBeenCalled()
  }
})

it.each(['engine', 'inactive', 'session', 'process', 'control', 'revoked', 'routes', 'backend', 'pane', 'primary',
  'agent', 'kind', 'id', 'operation', 'target', 'token'] as const)('holds %s reservation changes before reading process evidence', async change => {
  const p = fixture()
  if (change === 'engine') p.row.engine = 'codex'
  if (change === 'inactive') p.row.active = false
  if (change === 'session') p.row.sessionId = ''
  if (change === 'process') p.row.processIdentity = null
  if (change === 'control') delete p.row.nativeControl
  if (change === 'revoked') p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, revoked: true } }
  if (change === 'routes') p.row.runtimes.push({ backend: 'tmux', paneId: '%2' })
  if (change === 'backend') (p.row.runtimes[0] as any).backend = 'unknown'
  if (change === 'pane') p.row.tmuxPane = '%2'
  if (change === 'primary') p.row.primaryRuntimeKey = 'tmux:%2'
  if (change === 'agent') p.row.agentId = 'another-agent'
  if (change === 'kind') p.request.request.kind = 'create'
  if (change === 'id') p.request.request.creationId = 'another-creation-request'
  if (change === 'operation') p.request.request.operation = 'resume'
  if (change === 'target') p.request.request.target = 'c'.repeat(64)
  if (change === 'token') p.request.request.launchToken = 'another-launch-token'
  await expect(p.run()).rejects.toThrow('reservation or current binding')
  expect(p.probe).not.toHaveBeenCalled(); expect(p.receipts.readNativeRelaunchProcess).not.toHaveBeenCalled()
})

it.each(['pid', 'boot', 'birth', 'parent', 'root-missing', 'engine-missing', 'same-pid', 'image', 'launcher', 'unknown'] as const)(
  'holds %s evidence instead of adopting another engine', async change => {
    const p = fixture()
    if (change === 'pid') p.witness.pid = 43
    if (change === 'boot') p.witness.boot = bootId.replace('aaaa', 'bbbb')
    if (change === 'birth') p.witness.birth = '4201'
    if (change === 'parent') p.engine.parentPid = 11
    if (change === 'root-missing') p.rows.delete(10)
    if (change === 'engine-missing') p.rows.delete(42)
    if (change === 'same-pid') p.pane.mockResolvedValue({ rootPid: 42, command: 'original-command' })
    if (change === 'image') p.engine.imagePath = '/bin/bash'
    if (change === 'launcher') p.engine.imagePath = '/fixture/ori'
    if (change === 'unknown') p.engine.imagePath = '/fixture/unknown'
    await expect(p.run()).rejects.toThrow('original native replacement')
  },
)

it.each(['pane-root', 'pane-command', 'root-birth', 'engine-birth', 'engine-image', 'engine-parent', 'root-missing',
  'engine-missing', 'entry-digest', 'inspection', 'receipt', 'control', 'deadline', 'local'] as const)('holds a final %s change before returning authority', async change => {
  const p = fixture(), original = p.probe.getMockImplementation()!
  p.pane.mockImplementation(async () => ({ rootPid: change === 'pane-root' && p.pane.mock.calls.length === 2 ? 11 : 10,
    command: change === 'pane-command' && p.pane.mock.calls.length === 2 ? 'replaced-command' : 'original-command' }))
  if (change === 'inspection') p.inspect.mockImplementation(async () => ({ parent: null, children: [], verify: async () => {}, verifyDescriptors: async () => {} }))
  p.probe.mockImplementation(async () => {
    if (p.probe.mock.calls.length === 2) {
      if (change === 'root-birth') p.root.birth = '1001'
      if (change === 'engine-birth') p.engine.birth = '4201'
      if (change === 'engine-image') p.engine.imagePath = '/fixture/another-engine'
      if (change === 'engine-parent') p.engine.parentPid = 11
      if (change === 'entry-digest') p.engine.directEntryDigest = 'e'.repeat(64)
      if (change === 'root-missing') p.rows.delete(10)
      if (change === 'engine-missing') p.rows.delete(42)
      if (change === 'receipt') p.receiptProof.mockImplementation(() => { throw Error('changed receipt') })
      if (change === 'control') p.retained.mockImplementation(() => { throw Error('changed control') })
      if (change === 'deadline') clock.now = 4000
      if (change === 'local') p.local.mockImplementation(() => { throw Error('revoked') })
    }
    return original()
  })
  await expect(p.run()).rejects.toThrow()
})

it('retains copied inputs and actual read capacity until stalled reads settle', async () => {
  const p = fixture()
  // One shared unresolved observation keeps all eight actual operations alive.
  let resolve!: (value: string) => void
  const gate = new Promise<string>(done => { resolve = done })
  p.boot.mockReturnValue(gate)
  const pending = Array.from({ length: 8 }, () => p.run())
  p.row.processIdentity!.pid = 999; p.request.request.launchToken = 'mutated-caller-token'
  await expect(p.run()).rejects.toThrow('slots are occupied')
  resolve(bootId)
  expect((await Promise.all(pending)).every(proof => proof.key === `${bootId}\0cursor\x0042\x004200`)).toBe(true)
  p.row.processIdentity!.pid = 42; p.request.request.launchToken = token
  expect((await p.run()).key).toContain('cursor')
})

it.each(['boot', 'pane', 'probe', 'inspect'] as const)('bounds a stalled %s reply without freeing its actual read slots', async dependency => {
  vi.useFakeTimers()
  const p = fixture(), original = p[dependency].getMockImplementation()!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  p[dependency].mockImplementation((async (...args: unknown[]) => { await gate; return Reflect.apply(original, undefined, args) }) as never)
  const answers: string[] = []
  const pending = Array.from({ length: 8 }, () => p.run().then(() => 'unexpected authority', error => error.message)
    .then(answer => { answers.push(answer); return answer }))
  await vi.advanceTimersByTimeAsync(3000)
  expect(answers).toEqual(Array(8).fill(expect.stringContaining('evidence deadline expired')))
  await Promise.all(pending)
  let overflow: string | undefined
  const extra = p.run().then(() => { overflow = 'unexpected authority' }, error => { overflow = error.message })
  await vi.advanceTimersByTimeAsync(0)
  expect(overflow).toContain('slots are occupied')
  await extra
  release(); await vi.advanceTimersByTimeAsync(0)
  if (dependency === 'boot') expect(p.pane).not.toHaveBeenCalled()
  if (dependency === 'pane') expect(p.probe).not.toHaveBeenCalled()
  if (dependency === 'probe') expect(p.inspect).not.toHaveBeenCalled()
  p[dependency].mockImplementation(original as never)
  expect((await p.run()).key).toContain('cursor')
})

it('captures original fence callbacks across waits and in the returned proof', async () => {
  const p = fixture(), original = p.boot.getMockImplementation()!
  p.boot.mockImplementation(async () => {
    p.fence.verify = vi.fn(); p.fence.current = vi.fn()
    return original()
  })
  const proof = await p.run()
  expect(p.fence.verify).not.toHaveBeenCalled(); expect(p.fence.current).not.toHaveBeenCalled()
  p.retained.mockImplementation(() => { throw Error('original authority revoked') })
  expect(proof.verify).toThrow('original authority revoked')
})

it('does not reserve an actual read slot when synchronous setup exhausts the deadline', async () => {
  const p = fixture(), late = { verify: p.retained, get current() { clock.now = 4000; return p.local } }
  await expect(p.read(p.row, p.request, late)).rejects.toThrow('deadline')
  expect(p.boot).not.toHaveBeenCalled()
  clock.now = 0
  let release!: (boot: string) => void
  p.boot.mockReturnValue(new Promise<string>(resolve => { release = resolve }))
  const active = Array.from({ length: 8 }, () => p.run().catch(() => undefined))
  expect(p.boot).toHaveBeenCalledTimes(8)
  release(bootId)
  expect((await Promise.all(active)).every(Boolean)).toBe(true)
})

const paneText = (command = `/usr/bin/env HARNESS_NATIVE_LAUNCH_TOKEN=${token} /bin/sh -c fixture`) => `%1\n10\n0\n${command}\n`
it('accepts only the complete live pane and exact original argv prefix', () => {
  const proof = inspectNativeRearmPane(paneText(), '%1', token)
  expect(proof.rootPid).toBe(10); expect(proof.command).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.isFrozen(proof)).toBe(true)
})
it('accepts only this daemon\'s one older-tmux owner wrapper', () => {
  const command = `/usr/bin/env HARNESS_DAEMON=${owner} /usr/bin/env HARNESS_NATIVE_LAUNCH_TOKEN=${token} /bin/sh -c fixture`
  expect(() => inspectNativeRearmPane(paneText(command), '%1', token, owner)).not.toThrow()
  expect(inspectNativeRearmPane(paneText(command), '%1', token, owner).rootPid).toBe(10)
  expect(() => inspectNativeRearmPane(paneText(command), '%1', token, 'b'.repeat(16))).toThrow()
  expect(() => inspectNativeRearmPane(paneText(command), '%1', token)).toThrow()
  expect(() => inspectNativeRearmPane(paneText(`/usr/bin/env HARNESS_DAEMON=${owner} ${command}`), '%1', token, owner)).toThrow()
})
it.each([
  '', '%1\n10\n0\n', paneText().trimEnd(), paneText().replace('%1', '%2'), paneText().replace('\n10\n', '\n0\n'),
  paneText().replace('\n10\n', '\n2147483648\n'), paneText().replace('\n0\n', '\n1\n'), paneText().replace(token, token + 'more'),
  paneText(`/bin/sh -c 'echo HARNESS_NATIVE_LAUNCH_TOKEN=${token} '`), paneText() + '\0', 'x'.repeat(512 * 1024 + 1),
])('rejects incomplete, dead or borrowed pane evidence %#', text => {
  expect(() => inspectNativeRearmPane(text, '%1', token)).toThrow()
})

it.each(['direct', 'declared', 'package', 'missing-digest', 'wrong-digest', 'unrelated-main', 'display-only', 'ori', 'shell'] as const)(
  'requires a positive executed entry for the %s process', kind => {
    const p = fixture(), vendor = '/fixture/cursor-agent/versions/1/index.js', script = '/fixture/declared.js'
    const observed = { args: `node ${vendor}`, nativeArgv: undefined } as unknown as ProcessRow
    if (kind !== 'direct' && kind !== 'ori' && kind !== 'shell') {
      p.engine.imagePath = '/fixture/node'; delete p.engine.argv
      p.engine.directEntryDigest = createHash('sha256').update(kind === 'declared' ? script : vendor).digest('hex')
    }
    if (kind === 'missing-digest') delete p.engine.directEntryDigest
    if (kind === 'wrong-digest') p.engine.directEntryDigest = 'f'.repeat(64)
    if (kind === 'unrelated-main') p.engine.directEntryDigest = createHash('sha256').update('/fixture/unrelated.js').digest('hex')
    if (kind === 'display-only') { delete p.engine.directEntryDigest; observed.args = `ori cursor ${vendor}` }
    if (kind === 'ori') p.engine.imagePath = '/fixture/ori'
    if (kind === 'shell') p.engine.imagePath = '/bin/bash'
    expect(nativeRearmEngine(p.engine, observed, kind === 'declared' ? script : undefined))
      .toBe(['direct', 'declared', 'package'].includes(kind))
  },
)

it('does not let a configured launcher or interpreter claim its still-waiting process', () => {
  const p = fixture(), observed = { args: '/fixture/cursor-agent' } as ProcessRow
  for (const path of ['/bin/bash', '/fixture/ori', '/fixture/node']) {
    p.engine.imagePath = path
    expect(nativeRearmEngine(p.engine, observed, path)).toBe(false)
  }
})

it('digest-checks complete vendor candidates containing spaces without trusting display boundaries', () => {
  const p = fixture(), entry = '/fixture/home with spaces/cursor-agent/versions/version with spaces/index.js'
  p.engine.imagePath = '/fixture/node'; delete p.engine.argv
  p.engine.directEntryDigest = createHash('sha256').update(entry).digest('hex')
  expect(nativeRearmEngine(p.engine, { args: `/fixture/agent ${entry} --resume session` } as ProcessRow)).toBe(true)
  p.engine.directEntryDigest = createHash('sha256').update('/fixture/unrelated.js').digest('hex')
  expect(nativeRearmEngine(p.engine, { args: `/fixture/agent ${entry} --resume session` } as ProcessRow)).toBe(false)
})
it.each(['invalid', 'error', 'stderr', 'utf8', 'deadline', 'valid'] as const)('keeps the tmux %s result bounded and explicit', async scenario => {
  vi.mocked(execFile).mockImplementation((_file, _argv, _options, callback) => {
    if (scenario === 'deadline') clock.now = 4000
    ;(callback as Function)(scenario === 'error' ? Error('unavailable') : null,
      scenario === 'utf8' ? Buffer.from([255]) : Buffer.from(paneText()), Buffer.from(scenario === 'stderr' ? 'uncertain' : ''))
    return {} as never
  })
  const run = () => readNativeRearmPane(scenario === 'invalid' ? 'bad' : '%1', token, new NativeEvidenceBudget())
  if (scenario === 'valid') {
    expect((await run()).rootPid).toBe(10)
    expect(vi.mocked(execFile).mock.calls[0][2]).toMatchObject({ timeout: 3000, maxBuffer: 512 * 1024, killSignal: 'SIGKILL' })
  } else await expect(run()).rejects.toThrow()
  if (scenario === 'invalid') expect(execFile).not.toHaveBeenCalled()
})
