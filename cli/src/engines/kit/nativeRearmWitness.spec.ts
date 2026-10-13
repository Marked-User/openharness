import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint } from '../../lib/agentCreationReceipt.js'
import type { NativeControlRow } from '../../lib/nativeProcessControlProbe.js'
import { nativeRearmRequest, nativeTurnTarget, type NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { NativeLaunch } from '../nativeLaunch.js'
import { inspectNativeRearmWitness, prepareNativeRearmWitness, writeNativeRearmWitness, type NativeRearmWitnessRequest } from './nativeRearmWitness.js'
import { executableSnapshot, nativeVersionProbe } from './nativeVersion.js'
import { nativeLaunchProof } from './nativeLaunchGuard.js'
import { inspectHookFile, type HookPreparationProof } from './nativeHookFiles.js'
import { NativePaths } from './nativePaths.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'

const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
vi.mock('./nativeHookBoot.js', () => ({ kernelBootId: async () => 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' }))
let root: string
const id = 'original-native-rearm-request', agentId = 'fixture-agent', token = 'original-native-launch-token'
const row = (pid: number, parentPid: number): NativeControlRow => ({ pid, parentPid, birth: String(pid * 100),
  command: pid === 42 ? 'sh' : 'node', imagePath: pid === 42 ? realpathSync(process.platform === 'darwin' ? '/bin/bash' : '/bin/sh') : '/fixture/node', argv: ['fixture'], fds: [] })
beforeEach(() => { clock.now = 0; root = realpathSync(mkdtempSync(join(tmpdir(), 'rearm-writer-'))) })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
async function fixture(source: 'live' | 'saved' = 'live', options?: Pick<NonNullable<NativeTurnIntent['rearm']>, 'permissionMode'>) {
  const engine = join(root, 'engine'), settings = join(root, 'settings')
  writeFileSync(engine, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); writeFileSync(settings, 'original hooks', { mode: 0o600 })
  const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 100 }, () => engine))!
  const paths = new NativePaths(new NativeEvidenceBudget()); paths.resolveSync(settings)
  const retained = inspectHookFile(settings)
  const hook: HookPreparationProof = { files: [{ file: settings, target: settings, stamp: retained.stamp, facts: paths.snapshot() }],
    current: () => { try { retained.verify(); return true } catch { return false } } }
  const launch: NativeLaunch = { token, executable, opencodeMajor: null, environment: {}, proofs: [hook],
    current: () => true, ready: () => true, prepareHooks: async () => true, permission: async () => 'supported' }
  const session = { schemaVersion: 3, agentId, registeredAt: 1, engine: 'cursor', sessionId: 'fixture-session', boundAt: 2, active: source === 'live',
    processIdentity: { pid: 41, executable: '/fixture/cursor', startMarker: 'fixture-birth' }, runtimes: [{ backend: 'tmux', paneId: '%1' }],
    primaryRuntimeKey: 'tmux:%1', tmuxPane: '%1', cwd: '/fixture/project', transcriptPath: null } as RegisteredSession
  const target = nativeTurnTarget(session)
  const control: NativeTurnIntent = { version: 1 as const, cancel: { processKey: null, target, request: {
    requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId, conversationId: 'fixture-session', frontier: { index: -1, digest: null },
  } }, rearm: { requestId: id, agentId, operation: source === 'live' ? 'restart' as const : 'resume' as const, launchToken: token, target,
    ...(options ? { source, ...options } : {}) } }
  const request = nativeRearmRequest(control) ?? { kind: 'native-rearm', creationId: id, operation: control.rearm!.operation, agentId, launchToken: token, target }
  const input: NativeRearmWitnessRequest = { version: 1, dataDir: root, source, id, fingerprint: creationFingerprint(request), request, control,
    dependencies: nativeLaunchProof(launch) }
  const receipts = new AgentCreationReceipts(join(root, 'agent-creations'))
  await receipts.runIntent(id, input.fingerprint, request, { service: 'native', detail: 'fixture' }, async () => async () => ({ state: 'unconfirmed' }))
  const saved = { ...session, nativeControl: control }
  if (source === 'saved') mkdirSync(join(root, 'stopped-agents'), { mode: 0o700 })
  const file = source === 'live' ? join(root, 'registry.json') : join(root, 'stopped-agents', `${agentId}.json`)
  writeFileSync(file, JSON.stringify(source === 'live' ? [saved] : { version: 1, session: saved }), { mode: 0o600 })
  const processes = new Map([[43, row(43, 42)], [42, row(42, 10)]])
  const probe = vi.fn(async (pids: readonly number[]) => ({ parent: 0, children: [],
    rows: new Map(pids.flatMap(pid => processes.has(pid) ? [[pid, structuredClone(processes.get(pid)!)] as const] : [])) }))
  const write = () => writeNativeRearmWitness(JSON.stringify(input), '42', { selfPid: 43, probe })
  const witness = join(root, 'agent-creations', `${id}.json.process`)
  return { input, receipts, processes, probe, write, file, witness, engine, settings, launch }
}

it.each(['live', 'saved'] as const)('hands only the original %s reservation and exact parent incarnation an exec permit', async source => {
  const p = await fixture(source)
  expect(await p.write()).toBe(true)
  expect(p.probe.mock.calls.map(([pids]) => pids)).toEqual([[43, 42], [43, 42]])
  const proof = p.receipts.readNativeRelaunchProcess(id, p.input)
  expect(proof.process).toEqual({ boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: 42, birth: '4200' }); proof.verify()
  expect(await p.write()).toBe(false)
  expect(p.probe).toHaveBeenCalledTimes(3)
})

it.each([undefined, 'ask', 'auto', 'plan', 'full'] as const)('retains a saved permission override %s without rewriting original control before exec', async permissionMode => {
  const p = await fixture('saved', permissionMode === undefined ? {} : { permissionMode })
  const original = readFileSync(p.file, 'utf8')
  expect(await p.write()).toBe(true)
  expect(readFileSync(p.file, 'utf8')).toBe(original)
  expect(p.input.request).toEqual(nativeRearmRequest(p.input.control))
})

it.each(['source', 'outer-source', 'permission', 'omission', 'saved-mode', 'saved-bypass'] as const)('holds a %s change to the original reserved launch options', async change => {
  const p = await fixture('saved', { permissionMode: 'full' })
  p.input.request = { ...p.input.request }
  if (change === 'source') p.input.request.source = 'live'
  if (change === 'outer-source') p.input.source = 'live'
  if (change === 'permission') p.input.request.permissionMode = 'ask'
  if (change === 'omission') delete p.input.request.permissionMode
  if (change === 'saved-mode' || change === 'saved-bypass') {
    const value = JSON.parse(readFileSync(p.file, 'utf8'))
    if (change === 'saved-mode') value.session.permissionMode = 'full'
    else value.session.bypassPermission = true
    writeFileSync(p.file, JSON.stringify(value), { mode: 0o600 })
  }
  await expect(p.write()).rejects.toThrow()
  expect(p.probe).not.toHaveBeenCalled()
  expect(existsSync(p.witness)).toBe(false)
})

it.each(['reparent', 'child', 'parent', 'image', 'missing', 'control', 'witness', 'deadline', 'executable', 'settings'] as const)(
  'holds %s changes during the final paired proof after publication', async change => {
    const p = await fixture(), original = p.probe.getMockImplementation()!
    p.probe.mockImplementation(async pids => {
      if (p.probe.mock.calls.length === 2) {
        if (change === 'reparent') p.processes.get(43)!.parentPid = 1
        if (change === 'child') p.processes.get(43)!.birth = '9999'
        if (change === 'parent') p.processes.get(42)!.birth = '9999'
        if (change === 'image') p.processes.get(42)!.imagePath = '/fixture/replacement'
        if (change === 'missing') p.processes.delete(42)
        if (change === 'control') writeFileSync(p.file, '[]')
        if (change === 'executable') writeFileSync(p.engine, '#!/bin/sh\nexit 1\n')
        if (change === 'settings') writeFileSync(p.settings, 'changed hooks')
        if (change === 'deadline') clock.now = 4000
        if (change === 'witness') {
          const bytes = readFileSync(p.witness)
          renameSync(p.witness, `${p.witness}.previous`); writeFileSync(p.witness, bytes, { mode: 0o600 })
        }
      }
      return original(pids)
    })
    await expect(p.write()).rejects.toThrow()
    expect(existsSync(p.witness)).toBe(true)
  },
)

it.each(['reparent', 'image', 'missing'] as const)('does not publish for an initially %s parent shell', async change => {
  const p = await fixture()
  if (change === 'reparent') p.processes.get(43)!.parentPid = 1
  if (change === 'image') p.processes.get(42)!.imagePath = '/fixture/cursor-agent'
  if (change === 'missing') p.processes.delete(42)
  await expect(p.write()).rejects.toThrow('original')
  expect(existsSync(p.witness)).toBe(false)
})

it.each(['revoked', 'different', 'duplicate', 'engine', 'pane', 'process', 'binding'] as const)('holds %s persisted control before probing or writing', async change => {
  const p = await fixture(), saved = JSON.parse(readFileSync(p.file, 'utf8'))
  if (change === 'revoked') saved[0].nativeControl.rearm.revoked = true
  if (change === 'different') saved[0].nativeControl.rearm.launchToken = 'different-launch-token'
  if (change === 'duplicate') saved.push(structuredClone(saved[0]))
  if (change === 'engine') saved[0].engine = 'codex'
  if (change === 'pane') saved[0].runtimes[0].paneId = '%2'
  if (change === 'process') saved[0].processIdentity.pid = 999
  if (change === 'binding') saved[0].sessionId = 'successor-session'
  writeFileSync(p.file, JSON.stringify(saved))
  await expect(p.write()).rejects.toThrow('saved reservation changed')
  expect(p.probe).not.toHaveBeenCalled(); expect(existsSync(p.witness)).toBe(false)
})

it('requires the explicit writer capability and captures immutable arguments as prepared dependencies', async () => {
  const p = await fixture(), artifact = join(root, 'notify.mjs'), module = pathToFileURL(join(root, 'cli.js')).href
  const header = '#!/usr/bin/env node\n// harness-native-hook-protocol:1\n// harness-native-hook-darwin:1\n'
  writeFileSync(artifact, header + '// old client\n', { mode: 0o600 })
  const retained: HookPreparationProof[] = [...p.launch.proofs]
  const launch: NativeLaunch = { ...p.launch, get proofs() { return retained },
    current: () => retained.every(proof => proof.current()), retain: proof => {
    retained.push(proof); return true
  } }
  expect(() => prepareNativeRearmWitness(launch, p.input, '/fixture/node', module)).toThrow('required relaunch witness')
  writeFileSync(artifact, header + '// harness-native-rearm-witness:1\n')
  const command = prepareNativeRearmWitness(launch, p.input, '/fixture/node', module)
  expect(command).toEqual(launch.rearmWitness); expect(Object.isFrozen(command)).toBe(true)
  expect(JSON.parse(command.request).dependencies.files.some((file: { target: string }) => file.target === artifact)).toBe(true)
  p.input.request.launchToken = 'later-mutation'
  expect(JSON.parse(command.request).request.launchToken).toBe(token)
  writeFileSync(artifact, header)
  expect(launch.current()).toBe(false)
})

it.each(['json', 'large', 'version', 'path', 'target', 'revoked', 'replacement', 'source', 'source-array', 'extra'] as const)('refuses %s writer input before any effect', async problem => {
  const p = await fixture(), input = structuredClone(p.input) as any
  if (problem === 'version') input.version = 2
  if (problem === 'path') input.dataDir = 'relative'
  if (problem === 'target') input.request.target = 'b'.repeat(64)
  if (problem === 'revoked') input.control.rearm.revoked = true
  if (problem === 'replacement') input.control.rearm.replacement = { processKey: 'replacement', sessionId: 'fixture-session' }
  if (problem === 'source') input.source = 'unknown'
  if (problem === 'source-array') input.source = ['live']
  if (problem === 'extra') input.extra = true
  expect(() => inspectNativeRearmWitness(problem === 'json' ? '{' : problem === 'large' ? ' '.repeat(129 * 1024) : JSON.stringify(input))).toThrow()
})
