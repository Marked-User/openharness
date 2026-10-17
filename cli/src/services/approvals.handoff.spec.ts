/** dr eggbot's eng/reference/HANDOFF-TO-BUILD.md acceptance tests and the 2026-10-15 decisions. */
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, MONEY_ASK_EXPIRY_MS, OTHER_ASK_EXPIRY_MS, PhonePairing,
  answerMcpElicitation, applyOverride, ask, askExpired, askExpiryMs, resolve,
  type AskAnswer, type AskRequest, type ApprovalTemplate, type AskOptions,
  stampManifest,
} from './approvals.js'
import { randomBytes as aidBytes } from 'node:crypto'
/** DECISIONS ad47477: every answer carries a fresh answerId (32 lowercase hex). */
const aid = (): string => aidBytes(16).toString('hex')

/** Shield pilot review A1: a device (touch) approval is a hold of 1.5 s or more; phone answers ignore it. */
const HOLD = 2000

/** Pair through the full F6 flow: device touch, phone offers code + key, device touch confirms the match. */
function complete(p: PhonePairing, id: string, code: string, origin?: { shared?: boolean }): boolean {
  const o = p.offer(id, `pub-${id}`, code, origin)
  return o.ok && p.confirm(id, 'touch', true)
}

const BK: ApprovalTemplate = { permissions: { auto: ['Read the ledger'], ask: ['Send an invoice'], never: ['Move money out'] } }
const RG: ApprovalTemplate = { permissions: { locked_ask: ['Brakes step'] } }
const MIN = 60_000
const HOUR = 60 * MIN
const MIC = { speaking: () => {} }

function clock(t = 1_000_000) {
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
const good = (req: AskRequest, extra: Partial<AskAnswer> = {}): AskAnswer =>
  ({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: HOLD, transcript: req.challenge ? `ok ${req.challenge}` : undefined, from: { phoneId: 'p1' }, ...extra })
// Shield pilot review (a): only an explicit send:false keeps a tool out of the send checks.
// locked_ask and money Asks are phone-only (pilot review A1), so the default has phone p1 paired.
const prod = (o: Partial<AskOptions> = {}): AskOptions => ({ ledger: new AskLedger(), kind: { manifest: stampManifest([{ name: 'x', send: false }], 'bridge'), tool: 'x' }, pairing: pairedP1(), ...o })
function pairedP1(): PhonePairing {
  const p = new PhonePairing()
  complete(p, 'p1', p.begin('touch').code)
  return p
}

describe('expiry: money 1 h, others 24 h', () => {
  it('constants and helpers match the reference', () => {
    expect(MONEY_ASK_EXPIRY_MS).toBe(HOUR)
    expect(OTHER_ASK_EXPIRY_MS).toBe(24 * HOUR)
    expect(askExpiryMs(0)).toBe(HOUR)
    expect(askExpiryMs()).toBe(24 * HOUR)
    expect(askExpiryMs(null)).toBe(24 * HOUR)
    expect(askExpired(0, HOUR - 1, 100)).toBe(false)
    expect(askExpired(0, HOUR, 100)).toBe(true)
    expect(askExpired(0, 24 * HOUR - 1)).toBe(false)
    expect(askExpired(0, 24 * HOUR)).toBe(true)
  })
  it('money Ask: answer at 59 min works, at 60 min does not', () => {
    const c = clock()
    const l = new AskLedger({ now: c.now })
    const paired = { isPaired: (id: string) => id === 'p1' }
    const a = l.open({ action: 'Pay', tier: 'ask', channel: 'phone', amountMinor: 100 })
    expect(a.expiresAt - a.openedAt).toBe(HOUR)
    expect(a.amountMinor).toBe(100)
    c.advance(59 * MIN)
    expect(l.settle(good(a), paired)).toEqual({ ok: true })
    const b = l.open({ action: 'Pay', tier: 'ask', channel: 'phone', amountMinor: 100 })
    c.advance(60 * MIN)
    expect(l.settle(good(b), paired)).toEqual({ ok: false, reason: 'expired' })
  })
  it('non-money Ask works at 23 h 59 min, not at 24 h', () => {
    const c = clock()
    const l = new AskLedger({ now: c.now })
    const a = l.open({ action: 'Send', tier: 'ask', channel: 'touch' })
    expect(a.amountMinor).toBeUndefined()
    c.advance(24 * HOUR - MIN)
    expect(l.settle(good(a))).toEqual({ ok: true })
    const b = l.open({ action: 'Send', tier: 'ask', channel: 'touch' })
    c.advance(24 * HOUR)
    expect(l.settle(good(b))).toEqual({ ok: false, reason: 'expired' })
  })
  it('expired Ask tells the agent the person did not approve', async () => {
    const c = clock()
    const l = new AskLedger({ now: c.now })
    const r = await ask(RG, 'Brakes step', null, (_c, _p, req) => { c.advance(24 * HOUR); return good(req!) }, prod({ ledger: l }))
    expect(r).toMatchObject({ approved: false, reason: 'expired' })
  })
})

describe('production is the default', () => {
  it('no ledger or no manifest is refused before prompting', async () => {
    const calls: unknown[] = []
    await expect(ask(BK, 'Send an invoice', null, (c) => calls.push(c))).rejects.toThrow(/ledger/)
    await expect(ask(BK, 'Send an invoice', null, (c) => calls.push(c), { ledger: new AskLedger() })).rejects.toThrow(/manifest/)
    expect(calls).toEqual([])
  })
  it('the F2 verifier passed to ask() is called and can reject', async () => {
    const seen: string[] = []
    const verifier = (req: AskRequest, ans: AskAnswer) => { seen.push(req.id); return ans.signature === 'sig' }
    const r1 = await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), prod({ verifier }))
    expect(r1).toMatchObject({ approved: false, reason: 'verifier_rejected' })
    const r2 = await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!, { signature: 'sig' }), prod({ verifier }))
    expect(r2).toMatchObject({ approved: true })
    expect(seen).toHaveLength(2)
  })
  it('both ledger and ask verifiers must pass', async () => {
    const l = new AskLedger({ verifier: () => true })
    const r = await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), prod({ ledger: l, verifier: () => false }))
    expect(r.reason).toBe('verifier_rejected')
  })
  it('the outcome carries the request', async () => {
    const r = await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), prod())
    expect(r.request?.id).toMatch(/-/)
  })
  it('non-true answers are not approved', async () => {
    for (const a of [null, 'yes', 1, true]) {
      expect((await ask(RG, 'Brakes step', null, () => a, prod())).approved).toBe(false)
    }
    for (const approved of ['true', 1] as never[]) {
      expect((await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!, { approved }), prod())).approved).toBe(false)
    }
    await expect(ask(RG, 'Brakes step', null, () => { throw new Error('boom') }, prod())).rejects.toThrow('boom')
  })
})

describe('F4 mandatory manifests', () => {
  const manifest = stampManifest([{ name: 'ledger.read', readOnly: true, send: false }, { name: 'invoice.send' }], 'bridge')
  const k = (tool: string, m: typeof manifest | null = manifest) => ({ manifest: m, tool })
  // Unlisted and send-capable tools (pilot review a) carry send details and a window so the tier is what is tested.
  const send = { send: { recipient: 'dana@example.com', message: 'Hi' }, window: new ApprovalWindow(), agentId: 'a' }
  const run = (action: string, o: Partial<AskOptions>) => ask(BK, action, null, (_c, _p, req) => good(req!), prod({ available: ['touch'], ...send, ...o }))
  // A trusted read-only tool with no send: the only way to Auto (Shield R7-4: a send is never Auto).
  const read = (action: string, o: Partial<AskOptions>) => ask(BK, action, null, (_c, _p, req) => good(req!), prod({ available: ['touch'], ...o }))
  it('tool not in the manifest is a write, so Ask', async () => {
    expect((await run('unlisted', { kind: k('nope') })).tier).toBe('ask')
  })
  it('read-only tool with isWrite true is still a write', async () => {
    expect((await run('unlisted', { kind: k('ledger.read'), isWrite: true })).tier).toBe('ask')
    expect((await read('unlisted', { kind: k('ledger.read') })).tier).toBe('auto')
    expect((await run('unlisted', { kind: k('ledger.read') })).tier).toBe('ask') // R7-4: with send details it is a send
  })
  it('tool not read-only with isWrite false is a write', async () => {
    expect((await run('unlisted', { kind: k('invoice.send'), isWrite: false })).tier).toBe('ask')
  })
  it('null manifest is a write; missing kind fails', async () => {
    expect((await run('unlisted', { kind: k('ledger.read', null) })).tier).toBe('ask')
    await expect(ask(BK, 'unlisted', null, () => true, { ledger: new AskLedger() })).rejects.toThrow(ApprovalDenied)
  })
  it('listed template items keep their tier whatever the manifest says', async () => {
    expect((await run('Send an invoice', { kind: k('ledger.read') })).tier).toBe('ask')
    expect((await read('Read the ledger', { kind: k('ledger.read') })).tier).toBe('auto')
    expect((await run('Read the ledger', { kind: k('invoice.send') })).tier).toBe('ask') // R7-4: a send is never Auto, even on an auto item
    await expect(run('Move money out', { kind: k('ledger.read') })).rejects.toThrow(ApprovalDenied)
  })
})

describe('F5 required for money and send', () => {
  it('money or send Ask without a window is refused', async () => {
    const calls: unknown[] = []
    await expect(ask(BK, 'Send an invoice', null, (c) => calls.push(c), prod({ amountMinor: 100 }))).rejects.toThrow(/window/)
    await expect(ask(BK, 'Send an invoice', null, (c) => calls.push(c), prod({ isSend: true, send: { recipient: 'r', message: 'm' } }))).rejects.toThrow(/window/)
    await expect(ask(BK, 'Send an invoice', null, (c) => calls.push(c), prod({ send: { recipient: 'r', message: 'm' } }))).rejects.toThrow(/window/)
    await expect(ask(BK, 'Send an invoice', null, (c) => calls.push(c), prod({ amountMinor: 100, window: new ApprovalWindow() }))).rejects.toThrow(/agentId/)
    expect(calls).toEqual([])
  })
  it('ten $45 approvals: all on the phone (money is phone-only since the pilot review); the prompt shows the total', async () => {
    const w = new ApprovalWindow()
    const prompts: string[] = []
    const o = prod({ window: w, agentId: 'a', amountMinor: 4500, mic: MIC, available: ['voice', 'touch', 'phone'] })
    const chans: (string | null)[] = []
    for (let i = 0; i < 10; i++) chans.push((await ask(BK, 'Send an invoice', null, (_c, p, req) => { prompts.push(p); return good(req!) }, o)).channel)
    expect(chans.every((c) => c === 'phone')).toBe(true)
    // With only voice and touch available, a money Ask fails closed rather than using the device.
    expect((await ask(BK, 'Send an invoice', null, (_c, _p, req) => good(req!), { ...o, available: ['voice', 'touch'] })).channel).toBeNull()
    expect(prompts[9]).toContain('(running total today: 10 actions, $450.00)')
  })
  it('the 21st send cannot use voice', async () => {
    const w = new ApprovalWindow()
    const o = prod({ window: w, agentId: 'a', mic: MIC, available: ['voice', 'touch'], isSend: true, send: { recipient: 'r', message: 'hi' } })
    const chans: (string | null)[] = []
    for (let i = 0; i < 21; i++) chans.push((await ask(BK, 'Send an invoice', null, (_c, _p, req) => good(req!), o)).channel)
    expect(chans.slice(0, 20).every((c) => c === 'voice')).toBe(true)
    expect(chans[20]).toBe('touch')
  })
})

describe('F6 and #1358 shared machines', () => {
  it('an answer from a shared machine never approves', async () => {
    const r = await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!, { from: { shared: true } }), prod())
    expect(r).toMatchObject({ approved: false, reason: 'shared_machine' })
  })
  it('a shared machine cannot start or complete pairing; each attempt is logged', () => {
    const p = new PhonePairing()
    expect(() => p.begin('touch', { shared: true })).toThrow(ApprovalDenied)
    const { code } = p.begin('touch')
    expect(complete(p, 'p9', code, { shared: true })).toBe(false)
    expect(p.isPaired()).toBe(false)
    expect(p.log.map((e) => [e.event, e.reason])).toEqual([['refused', 'shared_machine']])
  })
  it('each pairing and unpairing writes a ledger entry', () => {
    const c = clock()
    const p = new PhonePairing({ now: c.now })
    complete(p, 'p1', p.begin('touch').code)
    expect(complete(p, 'p1', 'bad')).toBe(false)
    p.unpair('p1')
    p.unpair('p1')
    expect(p.log.map((e) => [e.event, e.phoneId, e.reason])).toEqual([
      ['pair', 'p1', undefined], ['refused', 'p1', 'unknown_code'], ['unpair', 'p1', undefined],
    ])
  })
  it('a phone that is not the paired one cannot answer', async () => {
    const pairing = new PhonePairing()
    complete(pairing, 'p1', pairing.begin('touch').code)
    const o = prod({ pairing, available: ['phone'] })
    // Shield R7-10: the other phone is refused and the Ask stays open; the paired phone's answer decides it.
    for (const from of [{ phoneId: 'p2' }, {}]) {
      let n = 0
      const out = await ask(RG, 'Brakes step', null, (_c, _p, req) => (++n === 1 ? good(req!, { from }) : good(req!, { approved: false })), o)
      expect(out).toMatchObject({ approved: false, reason: 'denied' })
      expect(n).toBe(2)
    }
    expect(await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), o)).toMatchObject({ approved: true, channel: 'phone' })
  })
  it('a ledger settle on a phone request with no pairing context fails', () => {
    const l = new AskLedger()
    const req = l.open({ action: 'a', tier: 'ask', channel: 'phone' })
    expect(l.settle(good(req))).toEqual({ ok: false, reason: 'unpaired_phone' })
  })
})

describe('#1340: phone MCP Accept/Decline goes through the Ask gate', () => {
  const pairing = new PhonePairing()
  complete(pairing, 'p1', pairing.begin('touch').code)
  const base = { ledger: new AskLedger(), pairing, manifest: stampManifest([{ name: 'calendar.read', readOnly: true, send: false }], 'bridge'), available: ['phone'] }
  const el = { server: 'calendar', message: 'Allow access to your work calendar?', tool: 'calendar.read' }
  it('an approved bound answer accepts and the prompt names the server and message', async () => {
    let prompt = ''
    const r = await answerMcpElicitation(BK, el, null, (_c, p, req) => { prompt = p; return good(req!) }, base)
    expect(r.action).toBe('accept')
    expect(prompt).toBe('ASK: MCP calendar: Allow access to your work calendar?')
  })
  it('even a read-only tool asks (never auto-accepted)', async () => {
    const r = await answerMcpElicitation(BK, el, null, (_c, _p, req) => good(req!), base)
    expect(r.outcome?.tier).toBe('ask')
  })
  it('a bare phone tap (true), a denial, or an unpaired phone declines', async () => {
    expect((await answerMcpElicitation(BK, el, null, () => true, base)).action).toBe('decline')
    expect((await answerMcpElicitation(BK, el, null, (_c, _p, req) => good(req!, { approved: false }), base)).action).toBe('decline')
    // R7-10: an unpaired phone's accept is refused (the Ask stays open); the paired phone then declines.
    let n = 0
    expect((await answerMcpElicitation(BK, el, null, (_c, _p, req) => (++n === 1 ? good(req!, { from: { phoneId: 'zz' } }) : good(req!, { approved: false })), base)).action).toBe('decline')
    expect(n).toBe(2)
  })
  it('a never-listed or gate error declines', async () => {
    const T = { permissions: { never: ['MCP calendar: Allow access to your work calendar?'] } }
    const r = await answerMcpElicitation(T, el, null, () => true, base)
    expect(r).toMatchObject({ action: 'decline', error: expect.stringMatching(/never/) })
    const r2 = await answerMcpElicitation(BK, { server: 's', message: 'm' }, null, () => true, { ...base, ledger: undefined })
    expect(r2.action).toBe('decline')
  })
  it('an auto-listed elicitation still declines without a person', async () => {
    const T = { permissions: { auto: ['MCP s: m'] } }
    expect((await answerMcpElicitation(T, { server: 's', message: 'm' }, null, () => true, base)).action).toBe('decline')
  })
})

describe('decided: Auto can never loosen a template Ask', () => {
  it('agentMode auto does not change Ask or locked_ask', async () => {
    for (const mode of ['auto', 'ask', 'bypass']) {
      const r = await ask(BK, 'Send an invoice', null, (_c, _p, req) => good(req!), prod({ agentMode: mode, available: ['touch'] }))
      expect(r.tier).toBe('ask')
      const r2 = await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), prod({ agentMode: mode }))
      expect(r2.tier).toBe('locked_ask')
    }
  })
  it('profile values meaning auto do not loosen', () => {
    for (const p of [{ approval_strictness: 'auto' }, { approvals: { 'Send an invoice': 'auto' } }, { mode: 'auto', auto_approve: true }]) {
      expect(resolve(BK, 'Send an invoice', p)).toBe('ask')
      expect(resolve(RG, 'Brakes step', p)).toBe('locked_ask')
    }
  })
  it('an override to auto on an Ask or locked_ask item is refused', () => {
    expect(() => applyOverride(BK, 'Send an invoice', 'auto')).toThrow(ApprovalDenied)
    expect(() => applyOverride(RG, 'Brakes step', 'auto')).toThrow(ApprovalDenied)
    expect(() => applyOverride(RG, 'Brakes step', 'ask')).toThrow(ApprovalDenied)
  })
})
