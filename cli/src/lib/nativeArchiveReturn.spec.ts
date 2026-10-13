import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { creationFingerprint } from './agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnAdmitted, nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import type { NativeArchiveStopProof } from './nativeArchive.js'
import type { NativeRearmReplacementProof } from '../engines/kit/nativeRearmProof.js'

const fault = vi.hoisted(() => ({ registry: '', archive: '', phase: '', fail: '',
  published: undefined as ((phase: string) => void) | undefined, opening: undefined as ((path: string) => void) | undefined, phases: [] as string[], closed: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const paths = new Map<number, string>()
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    fault.opening?.(String(args[0]))
    const fd = actual.openSync(...args); paths.set(fd, String(args[0])); return fd
  }, closeSync: (fd: number) => {
    const path = paths.get(fd) ?? ''; paths.delete(fd); actual.closeSync(fd); fault.closed?.(path)
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    actual.renameSync(...args)
    const path = String(args[1])
    if (path !== fault.registry && path !== fault.archive) return
    const raw = JSON.parse(actual.readFileSync(path, 'utf8'))
    fault.phase = path === fault.archive ? raw.version === 2 ? 'transfer' : raw.version === 3 ? raw.nativeReturn.phase === 'returning' ? 'checkpoint' : 'saved' : 'initial'
      : !raw.length ? 'cleanup' : raw.find((row: RegisteredSession) => row.agentId === 'saved-agent')?.nativeRetirement ? 'retirement'
      : raw.find((row: RegisteredSession) => row.agentId === 'saved-agent')?.nativeControl?.rearm?.replacement ? 'admission' : 'pending'
    fault.phases.push(fault.phase); fault.published?.(fault.phase)
  }, fsyncSync: (fd: number) => {
    if (fault.fail && fault.phase === fault.fail && actual.fstatSync(fd).isDirectory()) throw Error(`fixture ${fault.fail} sync failed`)
    actual.fsyncSync(fd)
  } }
})
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

let root: string, data: string, archive: string, saved: RegisteredSession
let registry: typeof import('./registry.js')['registry'], store: StoppedAgentStore
const control = (row: RegisteredSession): NativeTurnIntent => ({ version: 1, cancel: { processKey: null, target: nativeTurnTarget(row),
  request: { requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: row.agentId,
    conversationId: row.sessionId, frontier: { index: -1, digest: null } } } })
const rows = (): RegisteredSession[] => JSON.parse(readFileSync(fault.registry, 'utf8'))
const diskRow = () => rows().find(row => row.agentId === saved.agentId)!
const fence = { verify: () => {}, current: () => {} }
function proof(): NativeRearmReplacementProof {
  const source = store.readNativeResumeSource(saved), rearm = saved.nativeControl!.rearm!
  const request = { fingerprint: creationFingerprint({ kind: 'native-rearm', agentId: saved.agentId,
    operation: 'resume', source: 'saved', permissionMode: 'full' }), request: nativeRearmRequest(saved.nativeControl!)! }
  return { key: 'fixture-boot\0cursor\0' + 43 + '\0precise-birth', evidence: 'original-exec', pane: '%2',
    processIdentity: { pid: 43, executable: '<cursor>', startMarker: 'replacement-start', startTicks: 43 },
    verify: vi.fn(source.verify), verifyExecution: vi.fn(), verifyConfirmation: vi.fn(), current: vi.fn(),
    source: { target: rearm.target, controlFingerprint: creationFingerprint(saved.nativeControl), requestFingerprint: creationFingerprint(request) } }
}
const commit = (replacement = proof()) => registry.commitNativeSavedReplacement(saved, replacement, store, () => {})
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-archive-return-'))); data = join(root, 'data'); archive = join(data, 'stopped-agents')
  mkdirSync(data, { mode: 0o700 }); writeFileSync(join(data, 'registry.json'), '[]', { mode: 0o600 })
  writeFileSync(join(data, 'engine-homes.json'), '{}', { mode: 0o600 })
  for (const [key, value] of Object.entries({ HOME: root, ADAPTER_DATA_DIR: data, ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CURSOR_HOME: join(root, 'cursor'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') })) vi.stubEnv(key, value)
  vi.resetModules(); ({ registry } = await import('./registry.js'))
  const { StoppedAgentStore } = await import('./stoppedAgents.js'); store = new StoppedAgentStore(archive); registry.load()
  const original: RegisteredSession = { schemaVersion: 2, agentId: 'saved-agent', engine: 'cursor', sessionId: 'saved-session',
    cwd: '/fixture/project', projectDir: '/fixture/project', transcriptPath: null, tmuxPane: '%1', runtimes: [{ backend: 'tmux', paneId: '%1' }],
    primaryRuntimeKey: 'tmux\0%1', registeredAt: 1, boundAt: 2, lastHookAt: 2, lastTranscriptAt: 2, touchedAt: 2, active: false,
    source: 'hook', defaultName: 'Fixture', title: null, model: null, cliVersion: null, processIdentity: { pid: 42, executable: '<cursor>', startMarker: 'prior-start' } }
  store.save({ ...original, schemaVersion: 3, nativeControl: control(original) })
  const cancelled = store.get(original.agentId)!
  saved = store.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: { agentId: cancelled.agentId,
    requestId: 'original-resume-request', launchToken: 'original-launch-token', operation: 'resume', source: 'saved',
    permissionMode: 'full', target: nativeTurnTarget(cancelled) } }, fence)
  fault.registry = join(data, 'registry.json'); fault.archive = join(archive, `${saved.agentId}.json`)
  fault.phase = ''; fault.fail = ''; fault.phases = []; fault.published = undefined; fault.opening = undefined; fault.closed = undefined
})
afterEach(() => {
  fault.registry = fault.archive = fault.phase = fault.fail = ''; fault.published = undefined; fault.opening = undefined; fault.closed = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true })
})


function visit() {
  const admitted = commit()
  const intent = control(admitted)
  const cancelled = registry.commitNativeControl(admitted, { ...intent,
    cancel: { ...intent.cancel, request: { ...intent.cancel.request, requestId: 'stop-cancel-request' } } }, () => {})
  fault.phases = []; fault.phase = ''
  return cancelled
}
function stopProof(row: RegisteredSession): NativeArchiveStopProof {
  return { source: { target: nativeTurnTarget(row), controlFingerprint: creationFingerprint(row.nativeControl) },
    verifyStopped: vi.fn(), current: vi.fn() }
}
const checkpoint = (row: RegisteredSession) => registry.checkpointNativeArchive(row, store, () => {})
const retire = (row: RegisteredSession, stopped = stopProof(row)) => registry.retireNativeArchive(row, stopped, store, () => {})
const finish = (row: RegisteredSession) => registry.finishNativeArchiveRetirement(row, store, () => {})
async function restart() {
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  store = new StoppedAgentStore(archive); registry = new (registry.constructor as new () => typeof registry)(); registry.load()
}

it('checkpoints before retirement, returns saved ownership, then removes the live route', () => {
  const row = visit(), stopped = stopProof(row), publications: string[] = []
  fault.published = phase => {
    expect(existsSync(join(data, 'registry.json.lock'))).toBe(true)
    expect(existsSync(join(archive, 'registry.json.lock'))).toBe(true)
    publications.push(phase)
    const live = diskRow()
    if (phase !== 'cleanup') expect(live).toBeDefined()
    if (phase === 'checkpoint' || phase === 'retirement') expect(() => store.readNativeControl(store.get(row.agentId)!)).toThrow('live handoff')
    if (phase === 'retirement') expect(stopped.verifyStopped).toHaveBeenCalled()
    if (phase === 'saved' || phase === 'cleanup') expect(store.readNativeControl(store.get(row.agentId)!).intent).toEqual(row.nativeControl)
    if (live) expect(nativeTurnAdmitted(live.nativeControl, { agentId: row.agentId, sessionId: row.sessionId, processKey: 'fixture-boot\0cursor\0' + 43 + '\0precise-birth' })).toBe(false)
  }
  const role = checkpoint(row), retired = retire(row, stopped)
  expect(retired.nativeRetirement).toEqual(role)
  let result!: RegisteredSession
  expect(() => { result = finish(retired) }).not.toThrow()
  expect(publications).toEqual(['checkpoint', 'retirement', 'saved', 'cleanup'])
  expect(role).toMatchObject({ phase: 'returning', sourceTarget: nativeTurnTarget(row) })
  expect(retired).toMatchObject({ nativeRetirement: role, active: false, processIdentity: null, launch: { state: 'held', service: 'native' } })
  expect(registry.byAgent(row.agentId)).toBeUndefined(); expect(rows()).toEqual([])
  expect(result).toMatchObject({ sessionId: row.sessionId, processIdentity: row.processIdentity, nativeControl: row.nativeControl })
  expect(result.nativeArchive).toBeUndefined(); expect(result.nativeRetirement).toBeUndefined()
  expect(store.nativeReturn(row.agentId)).toEqual({ ...role, phase: 'saved' })
})

it('requires a checkpoint and exact stopped-process proof before retirement', () => {
  const row = visit()
  expect(() => retire(row)).toThrow('checkpoint')
  checkpoint(row)
  const stopped = stopProof(row)
  stopped.verifyStopped = () => { throw Error('original allocation remains unknown') }
  expect(() => retire(row, stopped)).toThrow('allocation remains unknown')
  expect(diskRow().nativeRetirement).toBeUndefined()
  expect(store.nativeReturn(row.agentId)?.phase).toBe('returning')
  expect(() => retire(row, stopped)).toThrow('fresh stopped-process evidence')
})

it('rechecks stopped-process evidence after retirement publication', () => {
  const row = visit(); checkpoint(row)
  const stopped = stopProof(row)
  stopped.verifyStopped = () => { if (fault.phase === 'retirement') throw Error('stopped evidence was revoked') }
  expect(() => retire(row, stopped)).toThrow('stopped evidence was revoked')
  expect(registry.byAgent(row.agentId)?.nativeRetirement).toBeUndefined()
  expect(store.nativeReturn(row.agentId)?.phase).toBe('returning')
})

it.each(['target', 'controlFingerprint'] as const)('rejects a stopped proof for another %s', field => {
  const row = visit(); checkpoint(row)
  const stopped = { ...stopProof(row), source: { ...stopProof(row).source, [field]: 'a'.repeat(64) } }
  expect(() => retire(row, stopped)).toThrow('different native visit')
  expect(diskRow().nativeRetirement).toBeUndefined()
})

it('a replacement still admitting hooks cannot be checkpointed as stopped', () => {
  const row = commit()
  expect(() => checkpoint(row)).toThrow('cancelled native archive owner')
  expect(store.nativeReturn(row.agentId)).toBeNull()
})

it.each(['checkpoint', 'retirement', 'saved', 'cleanup'])('recovers the original %s after uncertain durability', phase => {
  const row = visit()
  if (phase !== 'checkpoint') checkpoint(row)
  let retired: RegisteredSession | undefined
  if (phase === 'saved' || phase === 'cleanup') retired = retire(row)
  fault.phase = ''; fault.fail = phase
  expect(() => phase === 'checkpoint' ? checkpoint(row) : phase === 'retirement' ? retire(row) : finish(retired!)).toThrow(`fixture ${phase} sync failed`)
  fault.fail = ''; fault.phase = ''
  if (phase === 'checkpoint') checkpoint(row)
  if (!retired) retired = retire(row)
  const result = finish(retired)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(store.readNativeControl(result).intent).toEqual(row.nativeControl)
})

it.each(['checkpoint', 'retirement', 'saved', 'cleanup'])('a new daemon recovers a crash after the %s rename', async phase => {
  const row = visit()
  if (phase !== 'checkpoint') checkpoint(row)
  let retired: RegisteredSession | undefined
  if (phase === 'saved' || phase === 'cleanup') retired = retire(row)
  fault.phase = ''; fault.fail = phase
  expect(() => phase === 'checkpoint' ? checkpoint(row) : phase === 'retirement' ? retire(row) : finish(retired!)).toThrow()
  fault.fail = ''; fault.phase = ''; await restart()
  const current = registry.byAgent(row.agentId)
  if (current) {
    if (!current.nativeRetirement) checkpoint(current)
    finish(current.nativeRetirement ? current : retire(current))
  }
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(store.nativeReturn(row.agentId)?.phase).toBe('saved')
  expect(store.readNativeControl(store.get(row.agentId)!).intent).toEqual(row.nativeControl)
})

it('Registry absence cannot return live-owned archive control', async () => {
  const row = visit(); checkpoint(row)
  writeFileSync(fault.registry, '[]', { mode: 0o600 }); await restart()
  expect(() => store.readNativeControl(store.get(row.agentId)!)).toThrow('live handoff')
  expect(() => retire(row)).toThrow('owner changed')
  expect(() => finish({ ...row, nativeRetirement: store.nativeReturn(row.agentId)! })).toThrow()
  expect(store.nativeReturn(row.agentId)?.phase).toBe('returning')
})

it('a newer live Cancel invalidates the checkpoint until it is saved again', () => {
  const row = visit(), reserved = registry.commitNativeControl(row, { ...row.nativeControl!, rearm: {
    agentId: row.agentId, requestId: 'next-restart-request', launchToken: 'next-restart-token', source: 'live', operation: 'restart', target: nativeTurnTarget(row),
  } }, () => {})
  const revoked = registry.commitNativeControl(reserved, { ...control(reserved), cancel: { ...control(reserved).cancel,
    request: { ...control(reserved).cancel.request, requestId: 'next-cancel-request' } }, rearm: { ...reserved.nativeControl!.rearm!, revoked: true } }, () => {})
  checkpoint(revoked)
  const newer = registry.commitNativeControl(revoked, { ...revoked.nativeControl!, cancel: { ...revoked.nativeControl!.cancel,
    request: { ...revoked.nativeControl!.cancel.request, requestId: 'newer-cancel-request' } } }, () => {})
  expect(() => retire(revoked)).toThrow('owner changed')
  expect(() => retire(newer)).toThrow('checkpoint')
  checkpoint(newer)
  const result = finish(retire(newer))
  expect(result.nativeControl!.cancel.request.requestId).toBe('newer-cancel-request')
  expect(result.nativeControl!.rearm?.revoked).toBe(true)
})

it('retirement blocks live control; saved edits survive uncertain cleanup without checkpoint replay', () => {
  const row = visit(); checkpoint(row); const retired = retire(row)
  expect(() => registry.commitNativeControl(retired, { ...retired.nativeControl!, rearm: {
    agentId: row.agentId, requestId: 'retired-restart-request', launchToken: 'retired-restart-token', operation: 'restart', source: 'live', target: nativeTurnTarget(retired),
  } }, () => {})).toThrow('transition')
  fault.fail = 'cleanup'; expect(() => finish(retired)).toThrow(); fault.fail = ''; fault.phase = ''
  const prior = store.get(row.agentId)!
  const reserved = store.commitNativeControl(prior, { ...prior.nativeControl!, rearm: {
    agentId: row.agentId, requestId: 'next-resume-request', launchToken: 'next-resume-token', operation: 'resume', source: 'saved', target: nativeTurnTarget(prior),
  } }, fence)
  const cancelled = store.commitNativeControl(reserved, { ...control(reserved), cancel: { ...control(reserved).cancel,
    request: { ...control(reserved).cancel.request, requestId: 'saved-cancel-request' } }, rearm: { ...reserved.nativeControl!.rearm!, revoked: true } }, fence)
  store.patch(row.agentId, { cwd: '/fixture/new-folder' })
  const result = finish(retired)
  expect(result.cwd).toBe('/fixture/new-folder'); expect(result.nativeControl).toEqual(cancelled.nativeControl)
  expect(store.nativeReturn(row.agentId)?.phase).toBe('saved')
})

it.each(['checkpoint', 'retirement', 'saved', 'cleanup'])('rejects an equal-byte substitute for the %s publisher', phase => {
  const row = visit()
  if (phase !== 'checkpoint') checkpoint(row)
  let retired: RegisteredSession | undefined
  if (phase === 'saved' || phase === 'cleanup') retired = retire(row)
  let replaced = false
  fault.published = published => {
    if (published !== phase || replaced) return
    replaced = true
    const file = phase === 'checkpoint' || phase === 'saved' ? fault.archive : fault.registry
    const bytes = readFileSync(file, 'utf8')
    renameSync(file, `${file}.fixture-original`); writeFileSync(file, bytes, { mode: 0o600 })
  }
  expect(() => phase === 'checkpoint' ? checkpoint(row) : phase === 'retirement' ? retire(row) : finish(retired!)).toThrow()
  expect(replaced).toBe(true)
  fault.published = undefined
  expect(() => phase === 'checkpoint' ? checkpoint(row) : phase === 'retirement' ? retire(row) : finish(retired!)).toThrow()
  expect(registry.byAgent(row.agentId)).toBeDefined()
})

it('ordinary mutation cannot reopen or alter a retired route in memory', () => {
  const row = visit(); checkpoint(row); const retired = retire(row), before = structuredClone(retired)
  expect(registry.revalidateBinding(row.agentId)).toBeNull()
  expect(registry.setActive(row.agentId, true)).toBe(false)
  expect(registry.updateRuntimes(row.agentId, [{ backend: 'tmux', paneId: '%9' }])).toBe(false)
  expect(registry.setLaunch(row.agentId, { state: 'ready' })).toBeNull()
  expect(registry.setCwd(row.agentId, '/fixture/another')).toBe(false)
  expect(registry.updateProcessIdentity(row.agentId, row.processIdentity!)).toBe(false)
  expect(registry.clearProcessIdentity(row.agentId)).toBe(false)
  expect(registry.setBypassPermission(row.agentId, false)).toBe(false)
  expect(registry.setPermissionMode(row.agentId, 'plan')).toBe(false)
  expect(registry.setClosePlan(row.agentId, null)).toBeNull()
  expect(registry.register({ engine: 'cursor', sessionId: row.sessionId, tmuxPane: row.tmuxPane, cwd: row.cwd ?? undefined })).toBeNull()
  expect(registry.byAgent(row.agentId)).toEqual(before)
  expect(finish(retired).sessionId).toBe(row.sessionId)
})

it('a cold load keeps the exact retired checkpoint without transcript repair', async () => {
  const row = visit(); checkpoint(row); const retired = retire(row)
  await restart()
  expect(registry.byAgent(row.agentId)).toEqual(retired)
  expect(finish(registry.byAgent(row.agentId)!).sessionId).toBe(row.sessionId)
})

it.each(['same-route', 'same-id', 'other-engine'] as const)('discovery cannot reopen a loaded retirement through %s', async change => {
  const row = visit(); checkpoint(row); const retired = retire(row)
  await restart()
  const before = structuredClone(registry.byAgent(row.agentId)!)
  expect(registry.openProcessAgent({ agentId: row.agentId, engine: change === 'other-engine' ? 'codex' : 'cursor',
    tmuxPane: change === 'same-id' ? '%9' : row.tmuxPane,
    processIdentity: { pid: 99, executable: '<cursor>', startMarker: 'different-start' } })).toBeNull()
  expect(registry.byAgent(row.agentId)).toEqual(before)
  expect(registry.byPaneEngine(row.tmuxPane, 'cursor')).toEqual(before)
  expect(finish(retired).sessionId).toBe(row.sessionId)
})

it.each(['retirement', 'cleanup'])('the final %s guard rechecks ownership after the caller fence', phase => {
  const row = visit(); checkpoint(row)
  const retired = phase === 'cleanup' ? retire(row) : undefined
  let closes = 0, armed = false, changed = false
  fault.closed = path => { if (path === data && fault.phase === phase && ++closes === 2) armed = true }
  const current = () => {
    if (armed && !changed) {
      changed = true
      registry.byAgent(row.agentId)!.cwd = '/fixture/new-owner'
    }
  }
  expect(() => phase === 'retirement' ? registry.retireNativeArchive(row, stopProof(row), store, current)
    : registry.finishNativeArchiveRetirement(retired!, store, current)).toThrow('owner changed')
  expect(changed).toBe(true)
  expect(registry.byAgent(row.agentId)?.cwd).toBe('/fixture/new-owner')
  expect(() => registry.readNativeControl(registry.byAgent(row.agentId)!)).toThrow()
})

it.each(['checkpoint', 'saved'])('retains the %s publisher through its first subsequent inspection', phase => {
  const row = visit()
  let retired: RegisteredSession | undefined
  if (phase === 'saved') { checkpoint(row); retired = retire(row) }
  const target = store as unknown as { inspectReturnSource(input: RegisteredSession): unknown }
  const inspect = target.inspectReturnSource.bind(store)
  let changed = false
  vi.spyOn(target, 'inspectReturnSource').mockImplementation(input => {
    if (fault.phase === phase && !changed) {
      changed = true
      const other = fault.archive + '.fixture-copy'
      writeFileSync(other, readFileSync(fault.archive), { mode: 0o600 }); renameSync(other, fault.archive)
    }
    return inspect(input)
  })
  expect(() => phase === 'checkpoint' ? checkpoint(row) : finish(retired!)).toThrow()
  expect(changed).toBe(true)
  expect(registry.byAgent(row.agentId)).toBeDefined()
})

it('retirement cleanup cannot confirm an uncertain saved Cancel on its behalf', () => {
  const row = visit(); checkpoint(row); const retired = retire(row)
  fault.fail = 'cleanup'; expect(() => finish(retired)).toThrow(); fault.fail = ''; fault.phase = ''
  const prior = store.get(row.agentId)!, next: NativeTurnIntent = { ...prior.nativeControl!, rearm: {
    agentId: row.agentId, requestId: 'next-resume-request', launchToken: 'next-resume-token', operation: 'resume', source: 'saved', target: nativeTurnTarget(prior),
  } }
  fault.fail = 'saved'; expect(() => store.commitNativeControl(prior, next, fence)).toThrow(); fault.fail = ''; fault.phase = ''
  expect(() => finish(retired)).toThrow('original saved native control publication')
  store.commitNativeControl(prior, next, fence)
  expect(finish(retired).nativeControl).toEqual(next)
})

it('returns two successive visits without letting the first visit change the second', () => {
  const first = visit(); checkpoint(first); const retiredFirst = retire(first), finishedFirst = finish(retiredFirst)
  const firstRole = store.nativeReturn(first.agentId)!
  saved = store.commitNativeControl(finishedFirst, { ...finishedFirst.nativeControl!, rearm: {
    agentId: first.agentId, requestId: 'successor-resume-request', launchToken: 'successor-launch-token',
    operation: 'resume', source: 'saved', permissionMode: 'full', target: nativeTurnTarget(finishedFirst),
  } }, fence)
  const replacement = { ...proof(), pane: '%3', key: 'fixture-boot\0cursor\0' + 48 + '\0successor-birth',
    processIdentity: { pid: 48, executable: '<cursor>', startMarker: 'successor-start', startTicks: 48 } }
  const admitted = commit(replacement)
  expect(admitted.nativeArchive).not.toEqual(firstRole.link)
  expect(store.nativeReturn(first.agentId)).toBeNull()
  const before = readFileSync(fault.registry, 'utf8'), savedBefore = readFileSync(fault.archive, 'utf8')
  expect(() => checkpoint(first)).toThrow('owner changed')
  expect(() => retire(first)).toThrow('owner changed')
  expect(() => finish(retiredFirst)).toThrow('owner changed')
  expect(() => store.withNativeReturn(retiredFirst, archive => archive.complete(firstRole,
    { verifyBefore: () => {}, verifyAfter: () => {}, current: () => {} }))).toThrow('visit changed')
  expect(() => registry.commitNativeControl(retiredFirst, retiredFirst.nativeControl!, () => {})).toThrow('transition')
  expect(readFileSync(fault.registry, 'utf8')).toBe(before)
  expect(readFileSync(fault.archive, 'utf8')).toBe(savedBefore)
  const intent = control(admitted)
  const second = registry.commitNativeControl(admitted, { ...intent, cancel: { ...intent.cancel,
    request: { ...intent.cancel.request, requestId: 'successor-cancel-request' } } }, () => {})
  checkpoint(second)
  const final = finish(retire(second))
  expect(final.nativeControl!.cancel.request.requestId).toBe('successor-cancel-request')
  expect(final.processIdentity).toEqual(replacement.processIdentity)
  expect(store.nativeReturn(first.agentId)?.link).toEqual(admitted.nativeArchive)
  expect(store.readNativeControl(final).intent).toEqual(second.nativeControl)
  expect(rows()).toEqual([])
})
