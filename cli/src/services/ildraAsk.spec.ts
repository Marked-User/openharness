/**
 * The daemon's Ildra Ask runtime (Shield F12 and F13 wired into the real input paths): answers arrive as
 * `ildra_ask_answer` requests and take their origin from the connection the gateway authenticated, never
 * from the payload; the pane guard is the one the terminal input path consults.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ILDRA_ASK_REQUESTS } from '../core/api.js'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { enrollBridge, fixturePhonePub } from './ildraAsk.testkit.js'
import { createIldraAsk } from './ildraAsk.js'
import { PhonePairing, stampManifest, type ApprovalTemplate, type AskRequest } from './approvals.js'
import { randomBytes as aidBytes } from 'node:crypto'
/** DECISIONS ad47477: every answer carries a fresh answerId (device firmware: 32 hex from 128 random bits). */
const aid = (): string => aidBytes(16).toString('hex')

const T: ApprovalTemplate = { permissions: { ask: ['Rename a file', 'Send an email'], locked_ask: ['Brakes step'] } }
const OWN = fixturePhonePub('O')
const SHARED = 'S'.repeat(43) + '='
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }

function setup(clients: Record<string, IldraAskClient | null> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ildra-ask-'))
  const sent: { channel: string; req: AskRequest }[] = []
  const core = createIldraAskCore({ clientOf: (connId) => clients[connId] ?? null, isLoopback: (connId) => connId === 'desk' })
  const journalPath = join(d, 'j', 'approvals.json')
  const svc = createIldraAsk({ inputs: core, journalPath, markerPath: join(d, 'm', 'x.installed') })
  svc.bridge = (channel, _prompt, req) => { sent.push({ channel, req }) }
  enrollBridge(core, svc, clients) // Shield R7-1
  // One object for the tests: the core's requests and guard, the service's ask and journal.
  const rt = { requests: core.requests, guard: core.guard, ask: svc.ask, journal: svc.journal, cancel: core.cancel,
    set onSettled(fn: (id: string, ans: Record<string, unknown>) => void) { core.onAnswer = fn } }
  return { rt, sent, core, svc, journalPath }
}
const until = async (f: () => boolean): Promise<void> => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 0)) }
const answerFor = (req: AskRequest, extra: Record<string, unknown> = {}) => ({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 2000, ...extra })

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
  it('ildra.ask.attempt: a short device hold is emitted to the phone and journaled; the Ask stays open for a proper hold', async () => {
    const { rt, sent, svc, journalPath } = setup({ dev: { identity: OWN, role: 'device' } })
    const events: { type: string; body: Record<string, unknown> }[] = []
    svc.events = (type, body) => { events.push({ type, body: { ...body } }) }
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'agent-1', available: ['touch'] })
    await until(() => sent.length === 1)
    const req = sent[0]!.req
    const short = answerFor(req, { holdMs: 900 })
    await rt.requests.ildra_ask_answer(short, { local: false, owner: false, connection: 'dev' })
    await until(() => sent.length === 2)
    expect(events).toEqual([{ type: 'ildra.ask.attempt', body: { id: req.id, answerId: short.answerId, channel: 'touch', reason: 'hold_too_short', holdMs: 900, at: expect.any(Number) } }])
    // Kept in the journal (the activity log reads it from there) and still open: same id and digest8 re-shown.
    const onDisk = JSON.parse(readFileSync(journalPath, 'utf8')) as { ledger: { attempts: unknown[]; open: { id: string }[] } }
    expect(onDisk.ledger.attempts).toEqual([events[0]!.body])
    expect(onDisk.ledger.open.map((r) => r.id)).toEqual([req.id])
    expect(sent[1]!.req).toMatchObject({ id: req.id, digest8: req.digest8 })
    expect(rt.guard.filterInput('agent-1', 'remote')).toBe('block')
    // The same answerId again is a replay and spends the Ask, so the firmware must draw a fresh one per reply.
    await rt.requests.ildra_ask_answer(answerFor(req), { local: false, owner: false, connection: 'dev' })
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
    expect(rt.journal().ledger.attempts()).toHaveLength(1)
  })
  it('F12: a gateway-shared connection never approves, whatever the payload claims about itself', async () => {
    const { rt, sent } = setup({ sh: { identity: SHARED, role: 'web', shared: true } })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'agent-1', available: ['touch'] })
    await Promise.resolve()
    await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req, { from: { machinePub: OWN, shared: false } }), { local: false, owner: true, connection: 'sh' })
    expect(await p).toMatchObject({ approved: false, reason: 'shared_machine' })
  })
  it('F12: the payload cannot pose as another machine (machinePub comes from the connection)', async () => {
    const { rt, sent } = setup({ dev: { identity: OWN, role: 'device' }, web: { identity: SHARED, role: 'web' } })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    const seen: unknown[] = []
    rt.onSettled = (_id, ans) => seen.push({ from: ans.from, via: ans.via })
    await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req, { from: { machinePub: SHARED, shared: true, phoneId: 'p9' }, via: 'phone' }), { local: false, owner: true, connection: 'dev' })
    expect(await p).toMatchObject({ approved: true })
    // R5-1: the device session answers on touch only; a phone id it claims is dropped, and via is the core's.
    expect(seen).toEqual([{ from: { machinePub: OWN }, via: 'touch' }])
  })
  it('an answer with no connection, or from an unknown one, is refused', async () => {
    const { rt, sent } = setup()
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    expect(await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req), { local: false, owner: true })).toEqual({ ok: false, reason: 'no_authority' })
    expect(await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req), { local: false, owner: true, connection: 'ghost' })).toEqual({ ok: false, reason: 'no_authority' })
    rt.cancel(sent[0]!.req.id)
    expect((await p).approved).toBe(false)
  })
  it('R5-1: the loopback desktop (local socket) has no answer authority; observers neither', async () => {
    const { rt, sent, core } = setup({ obs: { identity: OWN, role: 'observer' } })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    expect(await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req), { local: true, owner: true, connection: 'desk' })).toEqual({ ok: false, reason: 'no_authority' })
    expect(await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req), { local: false, owner: false, connection: 'obs' })).toEqual({ ok: false, reason: 'no_authority' })
    core.cancel(sent[0]!.req.id)
    expect(await p).toMatchObject({ approved: false })
  })
  it('R5-1: a web client answering a touch Ask is refused without spending it; the device then answers', async () => {
    const { rt, sent } = setup({ dev: { identity: OWN, role: 'device' }, web: { identity: SHARED, role: 'web' } })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await until(() => sent.length === 1)
    const a = answerFor(sent[0]!.req)
    await rt.requests.ildra_ask_answer(a, { local: false, owner: false, connection: 'web' })
    await until(() => sent.length === 2) // wrong_channel keeps the Ask open; ask() re-shows it
    await rt.requests.ildra_ask_answer(a, { local: false, owner: false, connection: 'web' }) // its own answerId again: still not spent
    await until(() => sent.length === 3)
    await rt.requests.ildra_ask_answer(answerFor(sent[2]!.req), { local: false, owner: false, connection: 'dev' })
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
  })
  it('an answer for no open Ask is refused and never approves; a second answer to the same Ask is refused', async () => {
    const { rt, sent } = setup({ dev: { identity: OWN, role: 'device' } })
    expect(await rt.requests.ildra_ask_answer({ id: 'nope', digest8: '0011aabb', answerId: aid(), approved: true }, { local: false, owner: false, connection: 'dev' })).toEqual({ ok: false, reason: 'unknown_id' })
    const p = rt.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await Promise.resolve()
    const a = answerFor(sent[0]!.req)
    await rt.requests.ildra_ask_answer(a, { local: false, owner: false, connection: 'dev' })
    await p
    // v3.3: an answer nothing waits for is still recorded by the ledger (it never approves): here a reuse, replayed.
    expect(await rt.requests.ildra_ask_answer(a, { local: false, owner: false, connection: 'dev' })).toEqual({ ok: false, reason: 'replayed' })
    // Shield R7 ledger via rule: an in-process answer the core did not stamp settles nothing on the service's ledger.
    expect(rt.journal().ledger.settle({ ...a, from: {} })).toEqual({ ok: false, reason: 'no_authority' })
    expect(await rt.requests.ildra_ask_answer('junk' as never, { local: false, owner: false, connection: 'dev' })).toEqual({ ok: false, reason: 'malformed' })
  })
  it('phone answers need the phone paired in the runtime journal', async () => {
    const { rt, sent } = setup({ ph: { identity: OWN, role: 'web' } })
    const pairing: PhonePairing = rt.journal().pairing
    const { code } = pairing.begin('touch'); pairing.offer('p1', OWN, code); pairing.confirm('p1', 'touch', true)
    const p = rt.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await Promise.resolve()
    expect(sent[0]!.channel).toBe('phone')
    await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req, { from: { phoneId: 'p1' } }), { local: false, owner: true, connection: 'ph' })
    expect(await p).toMatchObject({ approved: true, channel: 'phone' })
  })
  it('R5-1: a phone answer is accepted only from the key the phone paired with (F6 offer phonePub)', async () => {
    // Shield R7-10: the other key is refused (unpaired_phone) without spending or recording anything; the Ask
    // stays open and the paired phone's key then approves it.
    const { rt, sent } = setup({ other: { identity: SHARED, role: 'web' }, ph: { identity: OWN, role: 'web' } })
    const pairing: PhonePairing = rt.journal().pairing
    const { code } = pairing.begin('touch'); pairing.offer('p1', OWN, code); pairing.confirm('p1', 'touch', true)
    expect(pairing.phoneKey('p1')).toBe(OWN)
    const p = rt.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await Promise.resolve()
    const before = JSON.stringify(rt.journal().ledger.toJSON())
    await rt.requests.ildra_ask_answer(answerFor(sent[0]!.req, { from: { phoneId: 'p1' } }), { local: false, owner: true, connection: 'other' })
    // ask() yields a turn after an uncounted refusal, then prompts again (same Ask).
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setImmediate(r))
    expect(JSON.stringify(rt.journal().ledger.toJSON())).toBe(before)
    expect(rt.journal().ledger.attempts()).toEqual([])
    const last = sent[sent.length - 1]!.req
    expect(last.id).toBe(sent[0]!.req.id)
    await rt.requests.ildra_ask_answer(answerFor(last, { from: { phoneId: 'p1' } }), { local: false, owner: true, connection: 'ph' })
    expect(await p).toMatchObject({ approved: true, channel: 'phone', reason: 'approved' })
  })
})
