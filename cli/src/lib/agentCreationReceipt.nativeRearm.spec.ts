import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCreationReceipts, creationFingerprint, type AgentCreationOutcome } from './agentCreationReceipt.js'

const faults = vi.hoisted(() => ({ linked: false, failDirectory: false, beforeLink: undefined as (() => void) | undefined,
  inspect: undefined as ((path: string) => void) | undefined, captureResult: undefined as (() => void) | undefined,
  directorySync: undefined as (() => void) | undefined }))
vi.mock('../engines/kit/nativeHookFiles.js', async original => {
  const actual = await original<typeof import('../engines/kit/nativeHookFiles.js')>()
  return { ...actual, inspectHookFile: (...args: Parameters<typeof actual.inspectHookFile>) => {
    if (args[0].endsWith('.result')) faults.captureResult?.()
    return actual.inspectHookFile(...args)
  } }
})
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, linkSync: (...args: Parameters<typeof actual.linkSync>) => {
    if (/\.(confirmation|process)$/.test(String(args[1]))) { faults.beforeLink?.(); faults.linked = true }
    return actual.linkSync(...args)
  }, fsyncSync: (fd: number) => {
    if (actual.fstatSync(fd).isDirectory()) faults.directorySync?.()
    if (faults.linked && faults.failDirectory && actual.fstatSync(fd).isDirectory()) throw Error('fixture parent sync unavailable')
    actual.fsyncSync(fd)
  }, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
    const value = actual.lstatSync(...args); faults.inspect?.(String(args[0])); return value
  } }
})
const roots: string[] = []
afterEach(() => { faults.linked = false; faults.failDirectory = false; faults.beforeLink = undefined; faults.inspect = undefined; faults.captureResult = undefined; faults.directorySync = undefined
  vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const id = 'native-rearm-request-original'
const request = { kind: 'native-rearm', creationId: id, operation: 'resume', agentId: 'original-agent', launchToken: 'original-launch-token' }
const fingerprint = creationFingerprint({ operation: 'resume', agentId: request.agentId })
const outcome = { state: 'created' as const, agentId: request.agentId, resumed: true }
const held = { service: 'native', detail: 'Waiting for the original replacement.' }
const processOwner = { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: 234, birth: '123456' }
const fence = () => ({ verify: vi.fn(), current: vi.fn() })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-rearm-receipt-'))); roots.push(root)
  const directory = join(root, 'receipts'), receipts = new AgentCreationReceipts(directory)
  const file = (part = '') => join(directory, `${id}.json${part && '.' + part}`)
  const confirm = (authority = fence()) => receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome }, authority)
  return { root, directory, receipts, file, confirm }
}
async function uncertain() {
  const value = fixture(), effect = vi.fn(async () => ({ state: 'unconfirmed' as const }))
  await value.receipts.runIntent(id, fingerprint, request, held, async () => effect)
  return { ...value, effect }
}

it('durably refines only the original native allocation and never hands recovery a dispatch callback', async () => {
  const { directory, receipts, file, confirm, effect } = await uncertain()
  const original = readFileSync(file('result'), 'utf8'), authority = fence()
  expect(confirm(authority)).toEqual(outcome)
  expect(authority.verify).toHaveBeenCalled(); expect(authority.current).toHaveBeenCalled()
  expect(readFileSync(file('result'), 'utf8')).toBe(original)
  const confirmation = readFileSync(file('confirmation'), 'utf8')
  expect(confirm()).toEqual(outcome)
  expect(readFileSync(file('confirmation'), 'utf8')).toBe(confirmation)
  const recovered = new AgentCreationReceipts(directory), prepare = vi.fn()
  expect(recovered.status(id)).toEqual(outcome)
  expect(await recovered.runIntent(id, fingerprint, request, held, prepare)).toEqual(outcome)
  expect(await recovered.run(id, fingerprint, effect)).toEqual(outcome)
  expect(recovered.cancelIntent(id)).toEqual(outcome)
  expect(recovered.pendingIntent(id)).toBeNull(); expect(prepare).not.toHaveBeenCalled(); expect(effect).toHaveBeenCalledOnce()
  expect(receipts.has(id, fingerprint)).toBe(true)
})

it('keeps a recovered success when the original live publisher later returns uncertainty', async () => {
  const { directory, receipts, confirm, file } = fixture()
  let finish!: (value: AgentCreationOutcome) => void
  const running = receipts.runIntent(id, fingerprint, request, held, async () => () => new Promise(resolve => { finish = resolve }))
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(confirm()).toEqual(outcome)
  finish({ state: 'unconfirmed' })
  await expect(running).resolves.toEqual(outcome)
  expect(fs.existsSync(file('result'))).toBe(false)
  expect(new AgentCreationReceipts(directory).status(id)).toEqual(outcome)
})

it.each(['confirmed', 'corrupt-confirmation', 'missing-claim', 'missing-intent'] as const)(
  'rechecks %s evidence after the reply deadline while the actual effect remains occupied', async kind => {
    vi.useFakeTimers()
    const { receipts, confirm, file } = fixture()
    let finish!: (value: AgentCreationOutcome) => void
    const effect = vi.fn(() => new Promise<AgentCreationOutcome>(resolve => { finish = resolve }))
    const prepare = vi.fn(async () => effect)
    const running = receipts.runIntent(id, fingerprint, request, held, prepare)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(running).resolves.toEqual({ state: 'pending' })
    expect(confirm()).toEqual(outcome)
    if (kind === 'corrupt-confirmation') writeFileSync(file('confirmation'), 'null', { mode: 0o600 })
    if (kind === 'missing-claim') rmSync(file('claim'))
    if (kind === 'missing-intent') rmSync(file())
    try {
      for (const retry of [() => receipts.runIntent(id, fingerprint, request, held, prepare), () => receipts.run(id, fingerprint, effect)]) {
        if (kind === 'confirmed') await expect(retry()).resolves.toEqual(outcome)
        else expect(retry).toThrow('CREATION_STORAGE_FAILED')
      }
      expect(prepare).toHaveBeenCalledOnce(); expect(effect).toHaveBeenCalledOnce()
    } finally { finish({ state: 'unconfirmed' }); await vi.advanceTimersByTimeAsync(0) }
  },
)

it.each(['failed', 'different-success'] as const)('retains a contradictory late %s as a storage hold', async kind => {
  const { directory, receipts, confirm } = fixture()
  let finish!: (value: AgentCreationOutcome) => void
  const running = receipts.runIntent(id, fingerprint, request, held, async () => () => new Promise(resolve => { finish = resolve }))
  const rejected = expect(running).rejects.toThrow('CREATION_STORAGE_FAILED')
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(confirm()).toEqual(outcome)
  finish(kind === 'failed' ? { state: 'failed', error: 'KNOWN_NOT_DISPATCHED' } : { ...outcome, agentId: 'different-agent' })
  await rejected
  expect(() => new AgentCreationReceipts(directory).status(id)).toThrow('CREATION_STORAGE_FAILED')
})

it('does not replace an occupied request with a coherent foreign receipt under the same ID', async () => {
  vi.useFakeTimers()
  const { receipts, file } = fixture(), foreign = fixture()
  let finish!: (value: AgentCreationOutcome) => void
  const effect = vi.fn(() => new Promise<AgentCreationOutcome>(resolve => { finish = resolve }))
  const prepare = vi.fn(async () => effect)
  const running = receipts.runIntent(id, fingerprint, request, held, prepare)
  await vi.advanceTimersByTimeAsync(5_000)
  await expect(running).resolves.toEqual({ state: 'pending' })
  const other = { ...request, agentId: 'foreign-agent' }, otherFingerprint = creationFingerprint(other)
  await foreign.receipts.runIntent(id, otherFingerprint, other, held, async () => async () => ({ ...outcome, agentId: other.agentId }))
  for (const part of ['', 'claim', 'result']) fs.copyFileSync(foreign.file(part), file(part))
  try {
    expect(() => receipts.runIntent(id, fingerprint, request, held, prepare)).toThrow('CREATION_CONFLICT')
    expect(() => receipts.run(id, fingerprint, effect)).toThrow('CREATION_CONFLICT')
    expect(prepare).toHaveBeenCalledOnce(); expect(effect).toHaveBeenCalledOnce()
  } finally { finish({ state: 'unconfirmed' }); await vi.advanceTimersByTimeAsync(0) }
})

it.each(['missing', 'unclaimed', 'cancelled', 'legacy', 'failed'] as const)('does not confirm a %s request', async kind => {
  const { receipts, confirm, file } = fixture()
  if (kind === 'legacy') await receipts.run(id, fingerprint, async () => outcome)
  else if (kind === 'cancelled') receipts.cancelIntent(id)
  else if (kind === 'unclaimed') await receipts.runIntent(id, fingerprint, request, held, async () => null)
  else if (kind === 'failed') await receipts.runIntent(id, fingerprint, request, held, async () => async () => ({ state: 'failed', error: 'KNOWN_NOT_DISPATCHED' }))
  expect(confirm).toThrow('CREATION_CONFLICT')
  expect(fs.existsSync(file('confirmation'))).toBe(false)
})

it.each(['kind', 'request', 'fingerprint', 'agent', 'outcome', 'token'] as const)('rejects mismatched %s confirmation authority', async kind => {
  const { receipts, file } = await uncertain()
  const value = { fingerprint, request: { ...request }, outcome: { ...outcome } }
  if (kind === 'kind') value.request.kind = 'model-create'
  if (kind === 'request') value.request.operation = 'restart'
  if (kind === 'fingerprint') value.fingerprint = '0'.repeat(64)
  if (kind === 'agent') value.outcome.agentId = 'different-agent'
  if (kind === 'outcome') Object.assign(value.outcome, { level: 'native' })
  if (kind === 'token') value.request.launchToken = 'short'
  expect(() => receipts.confirmNativeRelaunch(id, value, fence())).toThrow('CREATION_CONFLICT')
  expect(fs.existsSync(file('confirmation'))).toBe(false)
})

it.each(['intent', 'claim', 'cancel', 'legacy', 'result', 'confirmation'] as const)('holds changed %s evidence in status, retry, cancel and pending paths', async kind => {
  const { directory, receipts, file, confirm } = await uncertain()
  confirm()
  if (kind === 'intent') rmSync(file())
  if (kind === 'claim') rmSync(file('claim'))
  if (kind === 'cancel') writeFileSync(file(), JSON.stringify({ version: 2, cancelled: true }), { mode: 0o600 })
  if (kind === 'legacy') writeFileSync(file(), JSON.stringify({ version: 1, fingerprint, outcome }), { mode: 0o600 })
  if (kind === 'result') {
    const value = JSON.parse(readFileSync(file('result'), 'utf8')); value.outcome = { state: 'failed', error: 'CONFLICT' }
    writeFileSync(file('result'), JSON.stringify(value), { mode: 0o600 })
  }
  if (kind === 'confirmation') {
    const value = JSON.parse(readFileSync(file('confirmation'), 'utf8')); value.token = 'another-dispatch-token'
    writeFileSync(file('confirmation'), JSON.stringify(value), { mode: 0o600 })
  }
  for (const value of [receipts, new AgentCreationReceipts(directory)]) {
    expect(() => value.status(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => value.has(id, fingerprint)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => value.cancelIntent(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => value.pendingIntent(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => value.runIntent(id, fingerprint, request, held, vi.fn())).toThrow('CREATION_STORAGE_FAILED')
  }
})

it('confirms an identical immutable part after failed parent sync without rewriting it', async () => {
  const { receipts, file, confirm } = await uncertain()
  faults.failDirectory = true
  expect(confirm).toThrow('CREATION_STORAGE_FAILED')
  const bytes = readFileSync(file('confirmation'), 'utf8')
  expect(() => receipts.status(id)).toThrow()
  faults.failDirectory = false
  expect(confirm()).toEqual(outcome)
  expect(readFileSync(file('confirmation'), 'utf8')).toBe(bytes)
})

it('finishes the file proof with local authority before publishing confirmation', async () => {
  const { confirm, file } = await uncertain()
  let revoked = false, calls = 0
  const authority = fence()
  authority.verify.mockImplementation(() => { if (++calls >= 3) faults.inspect = () => { revoked = true } })
  authority.current.mockImplementation(() => { if (revoked) throw Error('original owner revoked') })
  expect(() => confirm(authority)).toThrow()
  expect(faults.linked).toBe(false)
  expect(fs.existsSync(file('confirmation'))).toBe(false)
})

it.each(['failed', 'different-success', 'claim', 'invalid'] as const)('does not adopt a peer %s published while capturing the original result proof', async kind => {
  const { file, confirm } = await uncertain()
  faults.captureResult = () => {
    faults.captureResult = undefined
    const value = JSON.parse(readFileSync(file('result'), 'utf8'))
    if (kind === 'failed') value.outcome = { state: 'failed', error: 'KNOWN_NOT_DISPATCHED' }
    if (kind === 'different-success') value.outcome = { ...outcome, agentId: 'another-agent' }
    if (kind === 'claim') value.token = 'different-dispatch-token'
    writeFileSync(file('result'), kind === 'invalid' ? 'null' : JSON.stringify(value), { mode: 0o600 })
  }
  expect(confirm).toThrow('CREATION_STORAGE_FAILED')
  expect(fs.existsSync(file('confirmation'))).toBe(false)
})

it('preserves the original receipt route when an ancestor is replaced during publication', async () => {
  const { root, directory, confirm } = await uncertain(), moved = `${root}-previous`
  faults.beforeLink = () => {
    renameSync(root, moved); mkdirSync(root, { mode: 0o700 }); renameSync(join(moved, 'receipts'), directory)
  }
  try { expect(confirm).toThrow() }
  finally { rmSync(moved, { recursive: true, force: true }) }
})

it('only the original witness publisher may continue to exec, while recovery gets read-only process proof', async () => {
  const { receipts, directory, file } = await uncertain(), expected = { fingerprint, request }
  expect(receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())).not.toBeNull()
  const bytes = readFileSync(file('process'), 'utf8')
  for (const recovered of [receipts, new AgentCreationReceipts(directory)]) {
    const proof = recovered.readNativeRelaunchProcess(id, expected)
    expect(proof.process).toEqual(processOwner); proof.verify()
    expect(recovered.status(id)).toEqual({ state: 'unconfirmed' })
    expect(recovered.recordNativeRelaunchProcess(id, expected, processOwner, fence())).toBeNull()
    expect(recovered.recordNativeRelaunchProcess(id, expected, { ...processOwner, pid: 235 }, fence())).toBeNull()
  }
  expect(readFileSync(file('process'), 'utf8')).toBe(bytes)
  expect(() => receipts.readNativeRelaunchProcess(id, { fingerprint: 'b'.repeat(64), request })).toThrow('CREATION_CONFLICT')
})

it('confirms its original witnessed execution without treating its own confirmation as foreign storage', async () => {
  const { receipts } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  const original = receipts.readNativeRelaunchProcess(id, { fingerprint, request })
  original.verify()
  let retained: { verify(): void } | undefined
  expect(receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome },
    { verify: original.verifyConfirmation, current() {} }, proof => { retained = proof })).toEqual(outcome)
  expect(original.verify).toThrow()
  expect(retained!.verify).not.toThrow()
  expect(receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome },
    { verify: original.verifyConfirmation, current() {} })).toEqual(outcome)
})

it.each(['intent', 'claim', 'result', 'process', 'confirmation'])('retains the original %s inode through the confirmation handoff', async kind => {
  const { receipts, file } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  const original = receipts.readNativeRelaunchProcess(id, { fingerprint, request })
  let retained: { verify(): void } | undefined
  receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome },
    { verify: original.verifyConfirmation, current() {} }, proof => { retained = proof })
  const path = file(kind === 'intent' ? '' : kind), bytes = readFileSync(path)
  renameSync(path, `${path}.previous`); writeFileSync(path, bytes, { mode: 0o600 })
  if (kind !== 'confirmation') expect(original.verifyConfirmation).toThrow()
  expect(retained!.verify).toThrow()
})

it('retains its own actual confirmation inode before directory durability', async () => {
  const { receipts, file } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  const original = receipts.readNativeRelaunchProcess(id, { fingerprint, request })
  faults.linked = false
  faults.directorySync = () => {
    if (!faults.linked) return
    faults.directorySync = undefined
    const path = file('confirmation'), bytes = readFileSync(path)
    renameSync(path, file('previous')); writeFileSync(path, bytes, { mode: 0o600 })
  }
  expect(() => receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome },
    { verify: original.verifyConfirmation, current() {} })).toThrow()
})

it('a failed witness sync cannot become execution authority even for the exact original process', async () => {
  const { receipts, file } = await uncertain(), expected = { fingerprint, request }
  faults.failDirectory = true
  expect(() => receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())).toThrow('CREATION_STORAGE_FAILED')
  const bytes = readFileSync(file('process'), 'utf8')
  expect(receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())).toBeNull()
  expect(() => receipts.readNativeRelaunchProcess(id, expected)).toThrow()
  faults.failDirectory = false
  expect(receipts.readNativeRelaunchProcess(id, expected).process).toEqual(processOwner)
  expect(receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())).toBeNull()
  expect(readFileSync(file('process'), 'utf8')).toBe(bytes)
})

it.each(['boot', 'pid', 'birth', 'extra'] as const)('refuses malformed %s process witnesses', async kind => {
  const { receipts, file } = await uncertain(), owner = { ...processOwner }
  if (kind === 'boot') owner.boot = 'approximate-boot'
  if (kind === 'pid') owner.pid = 1
  if (kind === 'birth') owner.birth = 'rounded time'
  if (kind === 'extra') Object.assign(owner, { argv: [] })
  expect(() => receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, owner, fence())).toThrow('CREATION_CONFLICT')
  expect(fs.existsSync(file('process'))).toBe(false)
})

it.each(['intent', 'claim', 'result', 'process', 'birth', 'version'] as const)('retains a process witness hold after its %s evidence changes', async kind => {
  const { receipts, directory, file } = await uncertain(), expected = { fingerprint, request }
  receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())
  const proof = receipts.readNativeRelaunchProcess(id, expected)
  if (kind === 'intent') rmSync(file())
  if (kind === 'claim') rmSync(file('claim'))
  if (kind === 'result') {
    const value = JSON.parse(readFileSync(file('result'), 'utf8')); value.outcome = { state: 'failed', error: 'NATIVE_REARM_NOT_DISPATCHED' }
    writeFileSync(file('result'), JSON.stringify(value))
  }
  if (kind === 'process') {
    const value = JSON.parse(readFileSync(file('process'), 'utf8')); value.token = 'foreign-claim'
    writeFileSync(file('process'), JSON.stringify(value))
  }
  if (kind === 'birth' || kind === 'version') {
    const value = JSON.parse(readFileSync(file('process'), 'utf8'))
    if (kind === 'birth') value.process.birth = '123457'
    else value.version = 2
    writeFileSync(file('process'), JSON.stringify(value))
  }
  expect(proof.verify).toThrow()
  for (const recovered of [receipts, new AgentCreationReceipts(directory)]) {
    expect(() => recovered.status(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => recovered.cancelIntent(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => recovered.runIntent(id, fingerprint, request, held, vi.fn())).toThrow('CREATION_STORAGE_FAILED')
    expect(() => recovered.readNativeRelaunchProcess(id, expected)).toThrow()
  }
})

it('an orphan process witness prevents a fresh request even after its other parts disappear', async () => {
  const { receipts, directory, file } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  for (const part of ['', 'claim', 'result']) rmSync(file(part))
  const recovered = new AgentCreationReceipts(directory)
  expect(() => recovered.status(id)).toThrow('CREATION_STORAGE_FAILED')
  expect(() => recovered.runIntent(id, fingerprint, request, held, vi.fn())).toThrow('CREATION_STORAGE_FAILED')
  expect(fs.existsSync(file())).toBe(false)
  expect(() => recovered.run(id, fingerprint, vi.fn())).toThrow('CREATION_STORAGE_FAILED')
  expect(fs.existsSync(file())).toBe(false)
})

it('never adopts a replacement of its own process witness during publication sync', async () => {
  const { receipts, file } = await uncertain()
  faults.directorySync = () => {
    if (!faults.linked) return
    faults.directorySync = undefined
    const bytes = readFileSync(file('process'))
    renameSync(file('process'), file('previous'))
    writeFileSync(file('process'), bytes, { mode: 0o600 })
  }
  expect(() => receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())).toThrow()
  expect(readFileSync(file('process'), 'utf8')).toBe(readFileSync(file('previous'), 'utf8'))
  expect(receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())).toBeNull()
})

it('keeps the original publication proof when the writer reproves its parent after durability', async () => {
  const { receipts, file } = await uncertain()
  const permit = receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())!
  permit.verify()
  const bytes = readFileSync(file('process'))
  renameSync(file('process'), file('previous')); writeFileSync(file('process'), bytes, { mode: 0o600 })
  expect(permit.verify).toThrow()
  expect(receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())).toBeNull()
})

it.each(['remove', 'replace', 'corrupt'] as const)('holds a %s process witness during confirmation sync', async kind => {
  const { receipts, file, confirm } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  faults.linked = false
  faults.directorySync = () => {
    if (!faults.linked) return
    faults.directorySync = undefined
    const bytes = readFileSync(file('process'))
    renameSync(file('process'), file('previous'))
    if (kind !== 'remove') writeFileSync(file('process'), kind === 'replace' ? bytes : 'null', { mode: 0o600 })
  }
  expect(confirm).toThrow()
})

it.each(['status', 'cancel', 'run'] as const)('retains the process witness through confirmed %s durability checks', async operation => {
  const { receipts, file, confirm } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  confirm()
  faults.directorySync = () => {
    faults.directorySync = undefined
    const bytes = readFileSync(file('process'))
    renameSync(file('process'), file('previous'))
    writeFileSync(file('process'), bytes, { mode: 0o600 })
  }
  const call = operation === 'status' ? () => receipts.status(id) : operation === 'cancel' ? () => receipts.cancelIntent(id)
    : () => receipts.runIntent(id, fingerprint, request, held, vi.fn())
  expect(call).toThrow()
})

it.each(['remove', 'change', 'insert'] as const)('a later %s cannot change which process a success confirmed', async kind => {
  const { receipts, directory, file, confirm } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  const original = readFileSync(file('process'), 'utf8')
  if (kind === 'insert') rmSync(file('process'))
  confirm()
  if (kind === 'remove') rmSync(file('process'))
  else {
    const value = JSON.parse(original)
    if (kind === 'change') {
      value.process.pid++
      value.checksum = creationFingerprint({ fingerprint: value.fingerprint, token: value.token, process: value.process })
    }
    writeFileSync(file('process'), JSON.stringify(value), { mode: 0o600 })
  }
  expect(() => new AgentCreationReceipts(directory).status(id)).toThrow('CREATION_STORAGE_FAILED')
})

it('checks local revocation after the final file proof before the pre-exec witness publication', async () => {
  const { receipts, file } = await uncertain(), authority = fence()
  let revoked = false
  authority.verify.mockImplementation(() => { faults.inspect = () => { revoked = true } })
  authority.current.mockImplementation(() => { if (revoked) throw Error('original launch revoked') })
  expect(() => receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, authority)).toThrow()
  expect(faults.linked).toBe(false); expect(fs.existsSync(file('process'))).toBe(false)
})
