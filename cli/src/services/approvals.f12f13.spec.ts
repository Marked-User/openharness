/** Shield F12 (shared flag from the gateway) and F13 (phone elicitation cannot answer Ildra Ask panes). */
import { describe, expect, it } from 'vitest'
import {
  AskLedger, AskPaneGuard, ApprovalDenied, ILDRA_ASK_MARKER, PhonePairing, ask, ildraAskTitle, isIldraAskQuestion,
  phoneElicitationPress, sharedOriginFromPeers,
  type AskAnswer, type AskRequest, type ApprovalTemplate,
  stampManifest,
} from './approvals.js'
import { randomBytes as aidBytes } from 'node:crypto'
import { fixturePhonePub } from './ildraAsk.testkit.js'
/** DECISIONS ad47477: every answer carries a fresh answerId (32 lowercase hex). */
const aid = (): string => aidBytes(16).toString('hex')

/** Shield pilot review A1: a device (touch) approval is a hold of 1.5 s or more; phone answers ignore it. */
const HOLD = 2000

const T: ApprovalTemplate = { permissions: { ask: ['Send an email'], locked_ask: ['Brakes step'] } }
// Shield pilot review (a): only an explicit send:false keeps a tool out of the send checks.
const kind = { manifest: stampManifest([{ name: 'x', send: false }], 'bridge'), tool: 'x' }
const SHARED_PUB = 'S'.repeat(43) + '='
const OWN_PUB = 'O'.repeat(43) + '='
const isShared = sharedOriginFromPeers([{ machineId: 'm-shared', pub: SHARED_PUB }])
const good = (req: AskRequest, from: AskAnswer['from']): AskAnswer => ({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: HOLD, from })

describe('F12: the shared flag comes from the gateway, not the answer', () => {
  // A plain Ask on the device (touch): locked_ask is phone-only since the pilot review (A1).
  it('lookup from the gateway peers', () => {
    expect(isShared({ machinePub: SHARED_PUB })).toBe(true)
    expect(isShared({ machinePub: OWN_PUB })).toBe(false)
    expect(isShared({})).toBe(false)
  })
  it('answer claiming shared:false from a gateway-shared machine is rejected', async () => {
    const r = await ask(T, 'Send an email', null, (_c, _p, req) => good(req!, { machinePub: SHARED_PUB, shared: false }), { ledger: new AskLedger(), kind, isShared })
    expect(r).toMatchObject({ approved: false, reason: 'shared_machine' })
  })
  it('answer that omits shared from a gateway-shared machine is rejected', async () => {
    const r = await ask(T, 'Send an email', null, (_c, _p, req) => good(req!, { machinePub: SHARED_PUB }), { ledger: new AskLedger(), kind, isShared })
    expect(r.reason).toBe('shared_machine')
  })
  it('own machine passes; a self-declared shared:true still rejects (never clears, only tightens)', async () => {
    expect((await ask(T, 'Send an email', null, (_c, _p, req) => good(req!, { machinePub: OWN_PUB, shared: false }), { ledger: new AskLedger(), kind, isShared })).approved).toBe(true)
    expect((await ask(T, 'Send an email', null, (_c, _p, req) => good(req!, { machinePub: OWN_PUB, shared: true }), { ledger: new AskLedger(), kind, isShared })).reason).toBe('shared_machine')
  })
  it('an answer with no origin is looked up as empty; a non-false lookup result counts as shared', async () => {
    const seen: unknown[] = []
    const r = await ask(T, 'Send an email', null, (_c, _p, req) => ({ id: req!.id, digest8: req!.digest8, answerId: aid(), approved: true, holdMs: HOLD }), { ledger: new AskLedger(), kind, isShared: (o) => { seen.push(o); return false } })
    expect(r.approved).toBe(true)
    expect(seen).toEqual([{}])
    const r2 = await ask(T, 'Send an email', null, (_c, _p, req) => good(req!, {}), { ledger: new AskLedger(), kind, isShared: () => undefined as never })
    expect(r2.reason).toBe('shared_machine')
  })
  it('a throwing gateway lookup fails closed', async () => {
    const r = await ask(T, 'Send an email', null, (_c, _p, req) => good(req!, {}), { ledger: new AskLedger(), kind, isShared: () => { throw new Error('down') } })
    expect(r.reason).toBe('shared_machine')
  })
  it('pairing uses the gateway lookup for begin and offer', () => {
    const p = new PhonePairing({ isShared })
    expect(() => p.begin('touch', { machinePub: SHARED_PUB, shared: false })).toThrow(ApprovalDenied)
    const s = p.begin('touch', { machinePub: OWN_PUB })
    expect(p.offer('ph', fixturePhonePub('pub'), s.code, { machinePub: SHARED_PUB, shared: false })).toEqual({ ok: false, reason: 'shared_machine' })
    expect(p.offer('ph', fixturePhonePub('pub'), p.begin('touch').code, { machinePub: OWN_PUB }).ok).toBe(true)
  })
})

describe('F13: phone elicitation handler routed through the Ask gate', () => {
  const pairing = new PhonePairing()
  const s = pairing.begin('touch'); pairing.offer('p1', fixturePhonePub('pub1'), s.code); pairing.confirm('p1', 'touch', true)
  const base = () => ({ ledger: new AskLedger(), pairing, manifest: stampManifest([{ name: 'db.query', send: false }], 'bridge'), available: ['phone'], guard: new AskPaneGuard() })
  const el = { paneId: 'pane-1', server: 'db', message: 'Drop table users?', tool: 'db.query' }
  it('marker helpers', () => {
    expect(ildraAskTitle({ digest8: 'abcd1234' }, 'ASK: x')).toBe(`${ILDRA_ASK_MARKER}abcd1234] ASK: x`)
    expect(isIldraAskQuestion('[Ildra Ask abcd1234] ASK: x')).toBe(true)
    expect(isIldraAskQuestion('Drop table?')).toBe(false)
    expect(isIldraAskQuestion(null)).toBe(false)
  })
  it('a plain MCP dialog: press Accept only on an approved bound answer', async () => {
    expect(await phoneElicitationPress(T, el, null, (_c, _p, req) => good(req!, { phoneId: 'p1' }), base())).toEqual({ key: '1' })
  })
  it('a bare tap, a denial, or a gate error presses Decline', async () => {
    expect((await phoneElicitationPress(T, el, null, () => true, base())).key).toBe('2')
    expect((await phoneElicitationPress(T, el, null, (_c, _p, req) => ({ ...good(req!, { phoneId: 'p1' }), approved: false }), base())).key).toBe('2')
    expect(await phoneElicitationPress(T, el, null, () => true, { ...base(), ledger: undefined })).toMatchObject({ key: '2', reason: expect.stringMatching(/ledger/) })
  })
  it('never presses on an Ildra Ask pane (open in the guard or marked in the dialog)', async () => {
    let called = 0
    const o = base()
    o.guard.open('pane-1', 'req-1')
    expect(await phoneElicitationPress(T, el, null, () => { called++; return true }, o)).toEqual({ key: null, reason: 'ildra_ask_pane' })
    expect(await phoneElicitationPress(T, { ...el, paneId: 'pane-2', message: '[Ildra Ask 00ff00ff] ASK: Send an email' }, null, () => { called++; return true }, base())).toEqual({ key: null, reason: 'ildra_ask_pane' })
    expect(called).toBe(0)
  })
  it('remote keystrokes to a pane with an open Ildra Ask are blocked; local pass; close reopens', () => {
    const g = new AskPaneGuard()
    expect(g.filterInput('p', 'remote')).toBe('pass')
    g.open('p', 'r1')
    expect(g.requestFor('p')).toBe('r1')
    expect(g.filterInput('p', 'remote')).toBe('block')
    expect(g.filterInput('p', 'local')).toBe('pass')
    expect(g.filterInput('other', 'remote')).toBe('pass')
    g.close('p')
    expect(g.requestFor('p')).toBeNull()
    expect(g.filterInput('p', 'remote')).toBe('pass')
  })
})
