/**
 * The daemon's Ildra Ask runtime (Shield F12 and F13 wired into the real input paths): answers arrive as
 * `ildra_ask_answer` requests and take their origin from the connection the gateway authenticated, never
 * from the payload; the pane guard is the one the terminal input path consults.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ILDRA_ASK_REQUESTS } from '../core/api.js'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { createIldraAsk } from './ildraAsk.js'
import { PhonePairing, type ApprovalTemplate, type AskRequest } from './approvals.js'

const T: ApprovalTemplate = { permissions: { ask: ['Rename a file', 'Send an email'], locked_ask: ['Brakes step'] } }
const OWN = 'O'.repeat(43) + '='
const SHARED = 'S'.repeat(43) + '='
const kind = { manifest: [{ name: 'fs.rename', send: false, owner: 'bridge' }], tool: 'fs.rename' }

function setup(clients: Record<string, IldraAskClient | null> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ildra-ask-'))
  const sent: { channel: string; req: AskRequest }[] = []
  const core = createIldraAskCore({ clientOf: (connId) => clients[connId] ?? null, isLoopback: (connId) => connId === 'desk' })
  const svc = createIldraAsk({ inputs: core, journalPath: join(d, 'j', 'approvals.json'), markerPath: join(d, 'm', 'x.installed') })
  svc.bridge = (channel, _prompt, req) => { sent.push({ channel, req }) }
  // One object for the tests: the core's requests and guard, the service's ask and journal.
  const rt = { requests: core.requests, guard: core.guard, ask: svc.ask, journal: svc.journal, cancel: core.cancel,
    set onSettled(fn: (id: string, ans: Record<string, unknown>) => void) { core.onAnswer = fn } }
  return { rt, sent, core, svc }
}
const answerFor = (req: AskRequest, extra: Record<string, unknown> = {}) => ({ id: req.id, digest8: req.digest8, approved: true, holdMs: 2000, ...extra })

describe('ildra_ask_answer', () => {
  it('with no bridge set, an Ask is denied without waiting and the pane is not left guarded', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ildra-ask-'))
    const core = createIldraAskCore({ clientOf: () => null, isLoopback: () => false })
    const rt = Object.assign(createIldraAsk({ inputs: core, journalPath: join(d, 'j', 'a.json'), markerPath: join(d, 'm', 'x') }), { guard: core.guard })
    expect(await rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })).toMatchObject({ approved: false, reason: 'malformed' })
    expect(rt.guard.filterInput('a', 'remote')).toBe('pass')
    const shown: string[] = []
    rt.bridge = (c) => { shown.push(c) }
    void rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    expect(shown).toEqual(['touch'])
  })
  it('is a declared request', () => {
    expect(ILDRA_ASK_REQUESTS).toContain('ildra_ask_answer')
    const { rt } = setup()
    expect(Object.keys(rt.requests)).toEqual([...ILDRA_ASK_REQUESTS])
  })
  it('F12 lookup: unknown keys count as shared until the gateway has spoken for them', async () => {
    const { core } = setup({ own: { identity: OWN, role: 'web' }, sh: { identity: SHARED, role: 'web', shared: true } })
    expect(core.isShared({ machinePub: OWN })).toBe(true)
    expect(core.isShared({})).toBe(false)
    await core.requests.ildra_ask_answer({ id: 'x', digest8: '0011aabb' }, { local: false, owner: true, connection: 'own' })
    await core.requests.ildra_ask_answer({ id: 'y', digest8: '0011aabb' }, { local: false, owner: true, connection: 'sh' })
    expect(core.isShared({ machinePub: OWN })).toBe(false)
    expect(core.isShared({ machinePub: SHARED })).toBe(true)
  })
  it('an answer from the paired device connection approves the open Ask; the pane is guarded while it waits', async () => {
    const { rt, sent } = setup({ dev: { identity: OWN, role: 'device' } })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'agent-1', available: ['touch'] })
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(rt.guard.filterInput('agent-1', 'remote')).toBe('block')
    expect(await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req), { local: false, owner: false, connection: 'dev' })).toEqual({ ok: true })
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
    expect(rt.guard.filterInput('agent-1', 'remote')).toBe('pass')
  })
  it('F12: a gateway-shared connection never approves, whatever the payload claims about itself', async () => {
    const { rt, sent } = setup({ sh: { identity: SHARED, role: 'web', shared: true } })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'agent-1', available: ['touch'] })
    await Promise.resolve()
    await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req, { from: { machinePub: OWN, shared: false } }), { local: false, owner: true, connection: 'sh' })
    expect(await p).toMatchObject({ approved: false, reason: 'shared_machine' })
  })
  it('F12: the payload cannot pose as another machine (machinePub comes from the connection)', async () => {
    const { rt, sent } = setup({ own: { identity: OWN, role: 'web' } })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    const seen: unknown[] = []
    rt.onSettled = (_id, ans) => seen.push(ans.from)
    await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req, { from: { machinePub: SHARED, shared: true, phoneId: 'p9' } }), { local: false, owner: true, connection: 'own' })
    expect(await p).toMatchObject({ approved: true })
    expect(seen).toEqual([{ machinePub: OWN, phoneId: 'p9' }])
  })
  it('an answer with no connection, or from an unknown one, is refused', async () => {
    const { rt, sent } = setup()
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    expect(await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req), { local: false, owner: true })).toEqual({ ok: false, reason: 'no_connection' })
    expect(await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req), { local: false, owner: true, connection: 'ghost' })).toEqual({ ok: false, reason: 'no_connection' })
    rt.cancel(sent[0]!.req.id)
    expect((await p).approved).toBe(false)
  })
  it('the loopback desktop answers as this machine', async () => {
    const { rt, sent } = setup()
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req), { local: true, owner: true, connection: 'desk' })
    expect(await p).toMatchObject({ approved: true })
  })
  it('an answer for no open Ask is refused and never approves; a second answer to the same Ask is refused', async () => {
    const { rt, sent } = setup({ dev: { identity: OWN, role: 'device' } })
    expect(await rt.requests.ildra_ask_answer({ id: 'nope', digest8: '0011aabb', approved: true }, { local: false, owner: false, connection: 'dev' })).toEqual({ ok: false, reason: 'unknown_id' })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    const a = answerFor(sent[0]!.req)
    await rt.requests.ildra_ask_answer(a, { local: false, owner: false, connection: 'dev' })
    await p
    expect(await rt.requests.ildra_ask_answer(a, { local: false, owner: false, connection: 'dev' })).toEqual({ ok: false, reason: 'unknown_id' })
    expect(rt.journal().ledger.settle({ ...a, from: {} })).toEqual({ ok: false, reason: 'replayed' })
    expect(await rt.requests.ildra_ask_answer('junk' as never, { local: false, owner: false, connection: 'dev' })).toEqual({ ok: false, reason: 'malformed' })
  })
  it('phone answers need the phone paired in the runtime journal', async () => {
    const { rt, sent } = setup({ ph: { identity: OWN, role: 'web' } })
    const pairing: PhonePairing = rt.journal().pairing
    const { code } = pairing.begin('touch'); pairing.offer('p1', 'pub1', code); pairing.confirm('p1', 'touch', true)
    const p = rt.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await Promise.resolve()
    expect(sent[0]!.channel).toBe('phone')
    await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req, { from: { phoneId: 'p1' } }), { local: false, owner: true, connection: 'ph' })
    expect(await p).toMatchObject({ approved: true, channel: 'phone' })
  })
})
