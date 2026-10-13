import { expect, it } from 'vitest'
import { nativeRearmRequest, nativeTurnAdmitted, nativeTurnTarget, nativeTurnTransition, parseNativeTurnIntent, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'

const cancel = () => ({ processKey: 'boot\0cursor\0original', target: 'a'.repeat(64), request: {
  requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: 'agent', conversationId: 'session', frontier: { index: -1, digest: null },
} })
const intent = (): NativeTurnIntent => ({ version: 1, cancel: cancel() })
const rearm = () => ({ requestId: 'explicit-rearm-request', agentId: 'agent', operation: 'restart' as const, target: 'b'.repeat(64), launchToken: 'original-launch-token' })
const replacement = () => ({ processKey: 'boot\0cursor\0replacement', sessionId: 'session' })
const targetRow = () => ({ agentId: 'agent', registeredAt: 1, engine: 'cursor', sessionId: 'session', boundAt: 2, active: true,
  processIdentity: { pid: 42, executable: '<cursor>', startMarker: 'birth' }, runtimes: [{ backend: 'tmux', paneId: '%1' }],
  primaryRuntimeKey: 'tmux:%1', tmuxPane: '%1', cwd: '/fixture/project', transcriptPath: null } as RegisteredSession)

it('copies an immutable cancellation and admits only its explicitly confirmed replacement', () => {
  const original = intent(), saved = parseNativeTurnIntent(original)!
  expect(saved).toEqual(original)
  expect(Object.isFrozen(saved.cancel.request.frontier)).toBe(true)
  expect(Object.isFrozen(saved.cancel.request)).toBe(true)
  expect(Object.isFrozen(saved.cancel)).toBe(true)
  expect(Object.isFrozen(saved)).toBe(true)
  expect(saved.cancel).not.toBe(original.cancel)
  const owner = { agentId: 'agent', sessionId: 'session', processKey: cancel().processKey }
  expect(nativeTurnAdmitted(undefined, owner)).toBe(true)
  expect(nativeTurnAdmitted(saved, owner)).toBe(false)
  expect(nativeTurnAdmitted(saved, { ...owner, processKey: replacement().processKey })).toBe(false)
  const reserved = parseNativeTurnIntent({ ...saved, rearm: rearm() })!
  expect(nativeTurnAdmitted(reserved, { ...owner, ...replacement() })).toBe(false)
  const confirmed = parseNativeTurnIntent({ ...reserved, rearm: { ...rearm(), replacement: replacement() } })!
  expect(Object.isFrozen(confirmed.rearm)).toBe(true)
  expect(Object.isFrozen(confirmed.rearm!.replacement)).toBe(true)
  expect(nativeTurnAdmitted(confirmed, { ...owner, ...replacement() })).toBe(true)
  for (const key of ['agentId', 'sessionId', 'processKey']) {
    expect(nativeTurnAdmitted(confirmed, { ...owner, ...replacement(), [key]: 'different' })).toBe(false)
  }
  expect(parseNativeTurnIntent({ ...reserved, rearm: { ...rearm(), operation: 'resume' } })).not.toBeNull()
})

it.each([
  null, undefined, [], {}, { ...intent(), version: 2 }, { ...intent(), extra: true }, { ...intent(), rearm: undefined },
  ...[null, [], {}, { ...cancel(), extra: true }, { ...cancel(), request: {} },
    ...[undefined, '', 7, 'x'.repeat(513)].map(processKey => ({ ...cancel(), processKey })),
    ...[undefined, 'not-a-digest'].map(target => ({ ...cancel(), target })),
  ].map(cancel => ({ version: 1, cancel })),
  ...[null, [], {}, { ...rearm(), extra: true }, { ...rearm(), operation: 'automatic-restore' },
    { ...rearm(), requestId: 7 }, { ...rearm(), requestId: 'short' }, { ...rearm(), target: 'short' }, { ...rearm(), launchToken: 'short' },
    { ...rearm(), revoked: false }, { ...rearm(), revoked: undefined },
    { ...rearm(), source: 'unknown' }, { ...rearm(), source: undefined },
    { ...rearm(), source: 'saved', permissionMode: undefined }, { ...rearm(), source: 'saved', permissionMode: 'full' },
    { ...rearm(), operation: 'resume', permissionMode: 'full' },
    { ...rearm(), operation: 'resume', source: 'saved', permissionMode: 'unknown' },
    { ...rearm(), operation: 'resume', source: 'saved', permissionMode: null },
    ...[undefined, '', 'x'.repeat(201), 'bad\nagent'].map(agentId => ({ ...rearm(), agentId })),
    ...[null, [], {}, { ...replacement(), extra: true }, { ...replacement(), processKey: cancel().processKey },
      { ...replacement(), processKey: '' }, { ...replacement(), sessionId: '' },
    ].map(replacement => ({ ...rearm(), replacement })),
  ].map(rearm => ({ ...intent(), rearm })),
])('refuses unknown or incomplete durable control data %#', value => {
  expect(parseNativeTurnIntent(value)).toBeNull()
})

it('retains cancellation provenance when a conversation is archived under another agent ID', () => {
  const archived = parseNativeTurnIntent({ ...intent(), rearm: { ...rearm(), agentId: 'archive', replacement: replacement() } })!
  expect(archived.cancel.request.agentId).toBe('agent')
  expect(nativeTurnAdmitted(archived, { agentId: 'agent', ...replacement() })).toBe(false)
  expect(nativeTurnAdmitted(archived, { agentId: 'archive', ...replacement() })).toBe(true)
})

it('retains a hold without inventing native owner or frontier evidence', () => {
  const unknown = parseNativeTurnIntent({ ...intent(), cancel: { ...cancel(), processKey: null } })!
  expect(unknown.cancel.processKey).toBeNull()
  expect(nativeTurnAdmitted(unknown, { agentId: 'agent', sessionId: 'session', processKey: 'discovered-later' })).toBe(false)
  expect(parseNativeTurnIntent({ ...unknown, cancel: { ...unknown.cancel, request: {
    ...unknown.cancel.request, frontier: { index: 0, digest: 'b'.repeat(64) },
  } } })).toBeNull()
})

it('retains an unbound Cancel only without physical interrupt authority', () => {
  const unbound = { ...intent(), cancel: { ...cancel(), processKey: null,
    request: { ...cancel().request, conversationId: '' } } }
  expect(parseNativeTurnIntent(unbound)).toEqual(unbound)
  expect(parseNativeTurnIntent({ ...unbound, cancel: { ...unbound.cancel, processKey: 'discovered-later' } })).toBeNull()
  const row = { ...targetRow(), sessionId: '', boundAt: null }
  expect(nativeTurnTransition(row, { ...unbound, cancel: { ...unbound.cancel, target: nativeTurnTarget(row) } })).toBe(true)
})

it('a new Cancel permanently revokes a pending rearm without adopting its future process', () => {
  const row = targetRow(), reserved = { ...intent(), rearm: rearm() }
  row.nativeControl = reserved
  const revoked: NativeTurnIntent = { version: 1, cancel: { ...cancel(), processKey: null, target: nativeTurnTarget(row),
    request: { ...cancel().request, requestId: 'cancel-prepared-resume' } }, rearm: { ...reserved.rearm, revoked: true } }
  expect(parseNativeTurnIntent(revoked)).toEqual(revoked)
  expect(nativeTurnTransition(row, revoked)).toBe(true)
  expect(nativeTurnTransition(row, { version: 1, cancel: revoked.cancel })).toBe(false)
  expect(nativeTurnTransition(row, { ...revoked, cancel: { ...revoked.cancel, processKey: 'future-replacement' } })).toBe(false)
  expect(nativeTurnTransition(row, { ...revoked, cancel: { ...revoked.cancel, processKey: cancel().processKey } })).toBe(false)
  row.nativeControl = revoked
  expect(nativeTurnTransition(row, { ...reserved, rearm: { ...rearm(), replacement: replacement() } })).toBe(false)
  expect(nativeTurnTransition(row, reserved)).toBe(false)
  expect(nativeTurnTransition(row, revoked)).toBe(true)
  const observed = { ...revoked, rearm: { ...revoked.rearm!, replacement: replacement() } }
  expect(nativeTurnTransition(row, observed)).toBe(true)
  expect(nativeTurnAdmitted(observed, { agentId: row.agentId, ...replacement() })).toBe(false)
  expect(nativeTurnTransition(row, { version: 1, cancel: revoked.cancel })).toBe(true)
})

it('binds a durable target to the original process, conversation and routes, independent of key order or holds', () => {
  const row = targetRow()
  const target = nativeTurnTarget(row)
  expect(nativeTurnTarget({ ...row, processIdentity: { startMarker: 'birth', executable: '<cursor>', pid: 42 },
    runtimes: [{ paneId: '%1', backend: 'tmux' }], codexHome: null, hermesHome: null, bypassPermission: false,
    evidenceRevision: 10, identityHold: 'Waiting.' })).toBe(target)
  for (const altered of [
    { agentId: 'other' }, { registeredAt: 3 }, { engine: 'codex' }, { sessionId: 'other' }, { boundAt: 4 }, { active: false },
    { processIdentity: null }, { processIdentity: { ...row.processIdentity!, startTicks: 5 } },
    { runtimes: [{ backend: 'tmux', paneId: '%2' }] }, { primaryRuntimeKey: 'tmux:%2' }, { tmuxPane: undefined },
    { cwd: '/fixture/other' }, { transcriptPath: '/fixture/transcript' }, { codexHome: '/fixture/codex' }, { hermesHome: '/fixture/hermes' },
    { permissionMode: 'ask' }, { bypassPermission: true },
  ]) expect(nativeTurnTarget({ ...row, ...altered } as RegisteredSession)).not.toBe(target)
})

it.each([undefined, 'ask', 'auto', 'plan', 'full'] as const)('reconstructs the immutable reserved request with permission override %s', permissionMode => {
  const row = targetRow(), control = intent()
  row.nativeControl = control
  const next: NativeTurnIntent = { ...control, rearm: { ...rearm(), operation: 'resume', source: 'saved', target: nativeTurnTarget(row),
    ...(permissionMode === undefined ? {} : { permissionMode }) } }
  expect(parseNativeTurnIntent(next)).toEqual(next)
  expect(nativeTurnTransition(row, next)).toBe(true)
  row.nativeControl = next
  const request = nativeRearmRequest(next)!
  expect(Object.isFrozen(request)).toBe(true)
  expect(request).toEqual({ kind: 'native-rearm', creationId: next.rearm!.requestId, agentId: row.agentId,
    operation: 'resume', source: 'saved', target: nativeTurnTarget(row), launchToken: next.rearm!.launchToken,
    ...(permissionMode === undefined ? {} : { permissionMode }) })
  for (const change of [{ source: 'live' as const }, { source: undefined },
    { permissionMode: permissionMode === 'full' ? 'ask' as const : 'full' as const }]) {
    expect(nativeTurnTransition(row, { ...next, rearm: { ...next.rearm!, ...change } })).toBe(false)
  }
  const revoked: NativeTurnIntent = { version: 1, cancel: { ...control.cancel, target: nativeTurnTarget(row), processKey: null,
    request: { ...control.cancel.request, requestId: 'later-cancel-request' } }, rearm: { ...next.rearm!, revoked: true } }
  expect(nativeTurnTransition(row, revoked)).toBe(true)
  expect(nativeRearmRequest(revoked)).toEqual(request)
  row.nativeControl = revoked
  expect(nativeTurnTransition(row, next)).toBe(false)
})

it('does not reconstruct missing or incomplete reservation metadata from present-day defaults', () => {
  expect(nativeRearmRequest(intent())).toBeNull()
  expect(nativeRearmRequest({ ...intent(), rearm: rearm() })).toBeNull()
  expect(nativeRearmRequest({ ...intent(), version: 2 } as unknown as NativeTurnIntent)).toBeNull()
  expect(nativeRearmRequest({ ...intent(), rearm: { ...rearm(), source: 'live' } })).toMatchObject({ source: 'live', operation: 'restart' })
})

it('requires Cancel, original reservation and exact confirmation in order', () => {
  const row = targetRow(), cancelled: NativeTurnIntent = { ...intent(), cancel: { ...cancel(), target: nativeTurnTarget(row) } }
  const reserved: NativeTurnIntent = { ...cancelled, rearm: { ...rearm(), target: nativeTurnTarget(row) } }
  const confirmed: NativeTurnIntent = { ...reserved, rearm: { ...reserved.rearm!, replacement: replacement() } }
  expect(nativeTurnTransition(row, cancelled)).toBe(true)
  expect(nativeTurnTransition(row, reserved)).toBe(false)
  expect(nativeTurnTransition(row, confirmed)).toBe(false)
  for (const change of [{ target: 'c'.repeat(64) }, { request: { ...cancel().request, agentId: 'other' } },
    { request: { ...cancel().request, conversationId: 'other' } }]) {
    expect(nativeTurnTransition(row, { ...cancelled, cancel: { ...cancelled.cancel, ...change } })).toBe(false)
  }
  row.nativeControl = cancelled
  expect(nativeTurnTransition(row, cancelled)).toBe(true)
  expect(nativeTurnTransition(row, reserved)).toBe(true)
  expect(nativeTurnTransition(row, confirmed)).toBe(false)
  for (const change of [{ agentId: 'other' }, { target: 'c'.repeat(64) }]) {
    expect(nativeTurnTransition(row, { ...reserved, rearm: { ...reserved.rearm!, ...change } })).toBe(false)
  }
  const anotherCancel: NativeTurnIntent = { ...cancelled, cancel: { ...cancelled.cancel, request: { ...cancelled.cancel.request, nonce: 'another-cancel-nonce' } } }
  expect(nativeTurnTransition(row, anotherCancel)).toBe(false)
  row.nativeControl = reserved
  expect(nativeTurnTransition(row, reserved)).toBe(true)
  expect(nativeTurnTransition(row, cancelled)).toBe(false)
  expect(nativeTurnTransition(row, confirmed)).toBe(true)
  for (const change of [{ requestId: 'replacement-request' }, { agentId: 'other' }, { operation: 'resume' as const },
    { target: 'c'.repeat(64) }, { launchToken: 'replacement-token' }]) {
    expect(nativeTurnTransition(row, { ...confirmed, rearm: { ...confirmed.rearm!, ...change } })).toBe(false)
  }
  expect(nativeTurnTransition(row, { ...confirmed, rearm: { ...confirmed.rearm!, replacement: { ...replacement(), sessionId: 'other' } } })).toBe(false)
  row.agentId = 'different-agent'
  expect(nativeTurnTransition(row, confirmed)).toBe(false)
  row.agentId = 'agent'; row.nativeControl = confirmed
  expect(nativeTurnTransition(row, confirmed)).toBe(true)
  expect(nativeTurnTransition(row, reserved)).toBe(false)
  expect(nativeTurnTransition(row, { ...confirmed, rearm: { ...confirmed.rearm!, replacement: { ...replacement(), processKey: 'different' } } })).toBe(false)
  expect(nativeTurnTransition(row, anotherCancel)).toBe(false)
  expect(nativeTurnTransition(row, { ...anotherCancel, cancel: { ...anotherCancel.cancel, processKey: replacement().processKey } })).toBe(false)
  const fresh = { ...anotherCancel, cancel: { ...anotherCancel.cancel, request: { ...anotherCancel.cancel.request, requestId: 'a-new-cancel-request' } } }
  expect(nativeTurnTransition(row, { ...fresh, cancel: { ...fresh.cancel, processKey: replacement().processKey } })).toBe(true)
  expect(nativeTurnTransition(row, { ...fresh, cancel: { ...fresh.cancel, processKey: 'another-process' } })).toBe(false)
  expect(nativeTurnTransition(row, { ...fresh, cancel: { ...fresh.cancel, processKey: null } })).toBe(true)
  expect(nativeTurnTransition(row, { ...anotherCancel, rearm: rearm() })).toBe(false)
})
