/**
 * Port of eng/reference/tests/test_device_api.py (dr eggbot, device interface v3, f4f6ef1) against approvals.ts.
 * The Gadget prompt.reply carries answer_id (128 random bits, 32 lowercase hex, fresh per reply), mapped by the
 * bridge to AskAnswer.answerId. Where Build's later decisions supersede v3 the port follows the decision and
 * says so: lone surrogates refuse the Ask (v3 escaped them), AskOutcome always has a reason (v3 omitted it when
 * approved), and an old-channel answer after a handoff is stale_channel and keeps the Ask (v3: unpaired_phone). Pilot profile only: money and locked_ask are phone-only,
 * voice is off (no mic guard), plain Asks go to device touch with a 1500 ms hold. Not ported: the product
 * profile (money by voice, deferred; needs a schema change), the Python stdio server, and the old digest
 * vectors (replaced by protocol/examples/vectors/digest8.json, checked in approvals.protocol.spec.ts).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, DEVICE_HOLD_MIN_MS, MONEY_ASK_EXPIRY_MS, OTHER_ASK_EXPIRY_MS, PhonePairing,
  InvalidUnicode, USE_YOUR_PHONE, actionDigest8, ask, canonicalJson, digestInput, firstLine, neverOutcome, fromDeviceReply, toDeviceMessage,
  type AskAnswer, type AskRequest, type ApprovalTemplate,
  stampManifest,
} from './approvals.js'

const NOW = 1_760_596_400_000
const T: ApprovalTemplate = { permissions: { auto: ['Read the ledger'], ask: ['Send an invoice', 'Rename a file'], locked_ask: ['Brakes step'], never: ['Move money out'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const hex = (): string => randomBytes(16).toString('hex')
const clock = () => { let t = NOW; return { now: () => t, set: (v: number) => { t = v } } }
function paired(): PhonePairing {
  const p = new PhonePairing()
  const { code } = p.begin('touch'); p.offer('phone-1', 'pub1', code); p.confirm('phone-1', 'touch', true)
  return p
}
const PAIRED = { isPaired: (id: string) => id === 'phone-1' }
const VECTORS = JSON.parse(readFileSync(new URL('./ildra-digest8-vectors.json', import.meta.url), 'utf8')) as {
  invoiceMessage: string; vectors: { name: string; action: string; fields: Record<string, unknown>; jcs: string | null; digest8: string | null; refused?: string }[]
}
/** Gadget prompt.reply from the Ildra firmware fork. */
const reply = (req: AskRequest, o: { answer?: string; hold_ms?: number; digest8?: string; answer_id?: string } = {}) =>
  ({ type: 'prompt.reply', id: req.id, answer_id: o.answer_id ?? hex(), answer: o.answer ?? 'yes', digest8: o.digest8 ?? req.digest8, hold_ms: o.hold_ms ?? 1620 })
const phoneAnswer = (req: AskRequest, extra: Partial<AskAnswer> = {}): AskAnswer =>
  ({ id: req.id, digest8: req.digest8, answerId: randomUUID(), approved: true, from: { phoneId: 'phone-1' }, ...extra })
/** Opens one Ask the way the daemon does (channel picked by ask()), and hands back the request. */
async function opened(action: string, o: Record<string, unknown> = {}): Promise<{ req: AskRequest | null; outcome: Awaited<ReturnType<typeof ask>> }> {
  let req: AskRequest | null = null
  const outcome = await ask(T, action, null, (_c, _p, r) => { req = r!; return null }, {
    ledger: new AskLedger({ now: () => NOW }), pairing: paired(), window: new ApprovalWindow(), agentId: 'bk1', kind, ...o,
  })
  return { req, outcome }
}

describe('digest (v2 DigestTests)', () => {
  it('the request digest binds agentId, tier, amount, currency, recipient and the message', () => {
    const l = new AskLedger({ now: () => NOW })
    const m = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 12000, agentId: 'bills-1' })
    expect(m.digest8).toBe(actionDigest8('Pay a bill', { agentId: 'bills-1', tier: 'ask', amountMinor: 12000, currency: 'USD' }))
    const msg = 'Hi Dana, invoice attached.\nThe total is $120.00.'
    const messageSha256 = createHash('sha256').update(msg, 'utf8').digest('hex')
    const s = l.open({ action: 'Send an invoice', tier: 'ask', channel: 'touch', agentId: 'bookkeeper-1', recipient: 'dana@example.com', firstLine: 'Hi Dana, invoice attached.', details: { recipient: 'dana@example.com', messageSha256 } })
    expect(s.digest8).toBe(actionDigest8('Send an invoice', { agentId: 'bookkeeper-1', tier: 'ask', recipient: 'dana@example.com', messageSha256 }))
    expect(s.firstLine).toBe('Hi Dana, invoice attached.')
  })
})

describe('pilot open (v2 PilotOpenTests)', () => {
  it('auto and never never reach the wire', async () => {
    const a = await opened('Read the ledger', { kind: { manifest: stampManifest([{ name: 'ledger.read', readOnly: true, send: false }], 'bridge'), tool: 'ledger.read' } })
    expect(a.req).toBeNull()
    expect(a.outcome).toMatchObject({ approved: true, channel: null, tier: 'auto' })
    // ask() refuses a never item outright (ApprovalDenied) before any prompt; the wire outcome is neverOutcome().
    let shown = 0
    await expect(ask(T, 'Move money out', null, () => { shown++; return null }, { ledger: new AskLedger(), kind })).rejects.toThrow(ApprovalDenied)
    expect(shown).toBe(0)
    expect(neverOutcome()).toEqual({ approved: false, channel: null, tier: 'never', reason: 'never' })
  })
  it('a plain Ask goes to device touch', async () => {
    const { req } = await opened('Rename a file', { available: ['touch', 'phone'] })
    expect(req).toMatchObject({ channel: 'touch', tier: 'ask', agentId: 'bk1', expiresAt: NOW + OTHER_ASK_EXPIRY_MS })
    expect(req!.challenge).toBeUndefined()
  })
  it('a money Ask is phone-only and expires in one hour; under $50 is still phone-only', async () => {
    for (const amountMinor of [4500, 12000]) {
      const { req } = await opened('Send an invoice', { amountMinor, available: ['voice', 'touch', 'phone'] })
      expect(req).toMatchObject({ channel: 'phone', amountMinor, currency: 'USD', expiresAt: NOW + MONEY_ASK_EXPIRY_MS })
    }
  })
  it('a locked_ask is phone-only', async () => {
    const { req } = await opened('Brakes step', { available: ['voice', 'touch', 'phone'] })
    expect(req).toMatchObject({ channel: 'phone', tier: 'locked_ask' })
  })
  it('voice is off in the pilot (no mic guard): never chosen', async () => {
    expect((await opened('Rename a file', { available: ['voice', 'touch'] })).req!.channel).toBe('touch')
    expect((await opened('Rename a file', { available: ['voice'] })).outcome).toMatchObject({ approved: false, channel: null, reason: 'no_channel' })
  })
  it('phone-only without a phone fails closed', async () => {
    const r = await opened('Brakes step', { available: ['touch'] })
    expect(r.req).toBeNull()
    expect(r.outcome).toEqual({ approved: false, channel: null, tier: 'locked_ask', reason: 'no_channel' })
    expect(() => new AskLedger().open({ action: 'Pay a bill', tier: 'ask', channel: 'touch', amountMinor: 1 })).toThrow(ApprovalDenied)
  })
  it('ids are unique', () => {
    const l = new AskLedger()
    const ids = new Set(Array.from({ length: 50 }, () => l.open({ action: 'a', tier: 'ask', channel: 'touch' }).id))
    expect(ids.size).toBe(50)
  })
})

describe('pilot settle (v2 PilotSettleTests, device answers through fromDeviceReply)', () => {
  const touch = (l: AskLedger) => l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch', agentId: 'bk1' })
  const money = (l: AskLedger) => l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 4500, agentId: 'bk1' })
  const locked = (l: AskLedger) => l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone', agentId: 'rg' })
  const dev = (msg: unknown): AskAnswer => { const a = fromDeviceReply(msg); expect(a).not.toBeNull(); return a! }

  it('a device hold approves a plain Ask', () => {
    const l = new AskLedger(); const r = touch(l)
    expect(l.settle(dev(reply(r)))).toEqual({ ok: true })
  })
  it('a short hold is rejected, recorded as an attempt, and the Ask stays open (v3: hold_too_short keeps it)', () => {
    const l = new AskLedger(); const r = touch(l)
    const short = dev(reply(r, { hold_ms: 640 }))
    expect(l.settle(short)).toEqual({ ok: false, reason: 'hold_too_short' })
    expect(l.attempts()).toEqual([{ id: r.id, answerId: short.answerId, channel: 'touch', reason: 'hold_too_short', holdMs: 640, at: expect.any(Number) }])
    expect(l.settle(dev(reply(r)))).toEqual({ ok: true })
  })
  it('a hold of exactly the minimum approves', () => {
    const l = new AskLedger(); const r = touch(l)
    expect(l.settle(dev(reply(r, { hold_ms: DEVICE_HOLD_MIN_MS })))).toEqual({ ok: true })
  })
  it('a device deny needs no hold', () => {
    const l = new AskLedger(); const r = touch(l)
    const a = dev(reply(r, { answer: 'no', hold_ms: 0 }))
    expect(a.approved).toBe(false)
    expect(l.settle(a)).toEqual({ ok: true })
  })
  it('a device answer to a money or locked_ask Ask is rejected (it carries no paired phone)', () => {
    for (const open of [money, locked]) {
      const l = new AskLedger(); const r = open(l)
      expect(toDeviceMessage(r, NOW)).toMatchObject({ type: 'display', body: USE_YOUR_PHONE })
      expect(l.settle(dev(reply(r, { hold_ms: 2000 })), PAIRED)).toEqual({ ok: false, reason: 'unpaired_phone' })
    }
  })
  it('the paired phone approves money; an unpaired phone, or no pairing lookup, is rejected', () => {
    let l = new AskLedger(); let r = money(l)
    expect(l.settle(phoneAnswer(r), PAIRED)).toEqual({ ok: true })
    l = new AskLedger(); r = money(l)
    expect(l.settle(phoneAnswer(r, { from: { phoneId: 'phone-9' } }), PAIRED)).toEqual({ ok: false, reason: 'unpaired_phone' })
    l = new AskLedger(); r = money(l)
    expect(l.settle(phoneAnswer(r))).toEqual({ ok: false, reason: 'unpaired_phone' })
  })
  it('a shared origin is rejected', () => {
    const l = new AskLedger(); const r = money(l)
    expect(l.settle(phoneAnswer(r, { from: { phoneId: 'phone-1', shared: true } }), PAIRED)).toEqual({ ok: false, reason: 'shared_machine' })
  })
  it('digest mismatch', () => {
    const l = new AskLedger(); const r = touch(l)
    expect(l.settle(dev(reply(r, { digest8: '00000000' })))).toEqual({ ok: false, reason: 'digest_mismatch' })
  })
  it('replay, then unknown; a repeated answer_id is a replay', () => {
    const l = new AskLedger(); const r = touch(l)
    const m = reply(r)
    expect(l.settle(dev(m))).toEqual({ ok: true })
    expect(l.settle(dev({ ...m, answer_id: hex() }))).toEqual({ ok: false, reason: 'replayed' })
    expect(l.settle(dev(reply({ ...r, id: randomUUID() })))).toEqual({ ok: false, reason: 'unknown_id' })
    const r2 = touch(l)
    expect(l.settle(dev({ ...reply(r2), answer_id: m.answer_id }))).toEqual({ ok: false, reason: 'replayed' })
  })
  it('a rejection spends the request', () => {
    const l = new AskLedger(); const r = touch(l)
    expect(l.settle(dev(reply(r, { digest8: '00000000' })))).toEqual({ ok: false, reason: 'digest_mismatch' })
    expect(l.settle(dev(reply(r)))).toEqual({ ok: false, reason: 'replayed' })
  })
  it('money expires at one hour, plain Asks at 24 hours', () => {
    const c = clock()
    let l = new AskLedger({ now: c.now }); let r = money(l)
    c.set(NOW + MONEY_ASK_EXPIRY_MS - 1)
    expect(l.settle(phoneAnswer(r), PAIRED)).toEqual({ ok: true })
    c.set(NOW); l = new AskLedger({ now: c.now }); r = money(l)
    c.set(NOW + MONEY_ASK_EXPIRY_MS)
    expect(l.settle(phoneAnswer(r), PAIRED)).toEqual({ ok: false, reason: 'expired' })
    c.set(NOW); l = new AskLedger({ now: c.now }); r = touch(l)
    expect(r.expiresAt).toBe(NOW + OTHER_ASK_EXPIRY_MS)
    c.set(NOW + OTHER_ASK_EXPIRY_MS)
    expect(l.settle(dev(reply(r)))).toEqual({ ok: false, reason: 'expired' })
  })
  it('the reply must be exactly the five fields (plus type)', () => {
    const r = touch(new AskLedger())
    const m = reply(r)
    expect(fromDeviceReply(m)).not.toBeNull()
    const { type: _t, ...noType } = m
    expect(fromDeviceReply(noType)).not.toBeNull()
    for (const k of ['id', 'answer_id', 'answer', 'digest8', 'hold_ms'] as const) {
      const { [k]: _gone, ...rest } = m
      expect(fromDeviceReply(rest), k).toBeNull()
    }
    expect(fromDeviceReply({ ...m, extra: 1 })).toBeNull()
    expect(fromDeviceReply({ ...m, answerId: m.answer_id })).toBeNull() // camelCase belongs to the Ildra side
    expect(fromDeviceReply({ ...m, type: 'prompt' })).toBeNull()
  })
  it('a stock Gadget reply never maps, so it never approves', () => {
    const r = touch(new AskLedger())
    expect(fromDeviceReply({ type: 'prompt.reply', id: r.id, answer: 'yes' })).toBeNull()
  })
  it('a bad answer word, hold or answer_id is malformed', () => {
    const r = touch(new AskLedger())
    for (const bad of [{ answer: 'YES' }, { answer: 'maybe' }, { hold_ms: -1 }, { hold_ms: Number.NaN }, { hold_ms: '2000' }, { hold_ms: true },
      { answer_id: hex().toUpperCase() }, { answer_id: hex().slice(2) }, { answer_id: `${hex()}00` }, { answer_id: randomUUID() }, { answer_id: 7 }]) {
      expect(fromDeviceReply({ ...reply(r), ...bad }), JSON.stringify(bad)).toBeNull()
    }
    for (const bad of [null, 'x', [], 1]) expect(fromDeviceReply(bad)).toBeNull()
  })
  it('the bridge maps snake_case to camelCase 1:1', () => {
    const r = touch(new AskLedger())
    const m = reply(r, { hold_ms: 1620, answer_id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' })
    expect(fromDeviceReply(m)).toEqual({ id: r.id, answerId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', digest8: r.digest8, approved: true, holdMs: 1620 })
  })
})

describe('device messages (v2 DeviceMessageTests)', () => {
  it('a touch Ask renders as a Gadget prompt with digest8', () => {
    const l = new AskLedger({ now: () => NOW })
    const r = l.open({ action: 'Send an invoice', tier: 'ask', channel: 'touch', recipient: 'dana@example.com', firstLine: 'Hi Dana, invoice attached.', details: { recipient: 'dana@example.com', messageSha256: 'x' } })
    expect(toDeviceMessage(r, NOW)).toEqual({ type: 'prompt', id: r.id, title: 'Ask', text: 'Send an invoice\nTo dana@example.com: Hi Dana, invoice attached.', ttl_s: OTHER_ASK_EXPIRY_MS / 1000, digest8: r.digest8 })
    const p = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    expect(toDeviceMessage(p, NOW)).toMatchObject({ type: 'prompt', text: 'Rename a file' })
  })
  it('a phone-only Ask shows "Use your phone" and no prompt to answer', () => {
    const r = new AskLedger({ now: () => NOW }).open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 12000 })
    expect(toDeviceMessage(r, NOW)).toEqual({ type: 'display', title: 'Ask', body: 'Use your phone', ttl_s: MONEY_ASK_EXPIRY_MS / 1000 })
  })
  it('ttl counts down to expiry and never goes negative', () => {
    const r = new AskLedger({ now: () => NOW }).open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(toDeviceMessage(r, NOW + 1500).ttl_s).toBe(OTHER_ASK_EXPIRY_MS / 1000 - 2)
    expect(toDeviceMessage(r, r.expiresAt + 5000).ttl_s).toBe(0)
  })
  it('a handoff moves the device prompt to "Use your phone"; same id, digest8 and expiry; device answers are stale', () => {
    const c = clock()
    const l = new AskLedger({ now: c.now })
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    c.set(NOW + 60_000)
    expect(l.handoff(r.id, 'phone')).toEqual({ id: r.id, from: 'device', to: 'phone', channel: 'touch', cause: 'timer', at: NOW + 60_000 })
    const after = l.toJSON().open.find((x) => x.id === r.id)!
    expect(after).toMatchObject({ id: r.id, digest8: r.digest8, expiresAt: r.expiresAt, channel: 'phone' })
    expect(toDeviceMessage(after, c.now())).toMatchObject({ type: 'display', body: USE_YOUR_PHONE })
    expect(l.settle(fromDeviceReply(reply(r))!, PAIRED)).toEqual({ ok: false, reason: 'stale_channel' })
    expect(l.settle(phoneAnswer(r), PAIRED)).toEqual({ ok: true })
  })
})

describe('v3 digest (JCS) and firstLine', () => {
  it('every vector matches; refused vectors are malformed (InvalidUnicode)', () => {
    for (const v of VECTORS.vectors) {
      if (v.refused) {
        expect(() => actionDigest8(v.action, v.fields), v.name).toThrow(InvalidUnicode)
      } else {
        expect(digestInput(v.action, v.fields), v.name).toBe(v.jcs)
        expect(actionDigest8(v.action, v.fields), v.name).toBe(v.digest8)
      }
    }
  })
  it('the ledger gives the send vector (46d275ab) for the invoice message', () => {
    const messageSha256 = createHash('sha256').update(VECTORS.invoiceMessage, 'utf8').digest('hex')
    const r = new AskLedger().open({ action: 'Send an invoice', tier: 'ask', channel: 'touch', agentId: 'bookkeeper-1', recipient: 'dana@example.com', firstLine: firstLine(VECTORS.invoiceMessage), details: { recipient: 'dana@example.com', messageSha256 } })
    expect(r.digest8).toBe('46d275ab')
    expect(r.firstLine).toBe('Hi Dana, invoice attached.')
  })
  it('JCS sorts keys by UTF-16 code units, writes numbers as ECMAScript, refuses what JSON cannot hold', () => {
    expect(canonicalJson({ '\u{1F600}': 1, '\uFB01': 2, a: 3 })).toBe('{"a":3,"\u{1F600}":1,"\uFB01":2}')
    expect(canonicalJson([1e21, 1e-7, 0.1, -0, 100, 1.5])).toBe('[1e+21,1e-7,0.1,0,100,1.5]')
    for (const bad of [Number.NaN, Infinity, () => 1, Symbol('s'), 1n]) expect(() => canonicalJson([bad])).toThrow(ApprovalDenied)
  })
  it('lone surrogates refuse the Ask with reason malformed (supersedes v3 escaping); paired ones are fine', async () => {
    expect(() => canonicalJson('a\uD800')).toThrow(InvalidUnicode)
    expect(canonicalJson('\uD83D\uDE00')).toBe('"\u{1F600}"')
    let prompted = 0
    const o = { ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'bk1', kind, available: ['touch'] }
    expect(await ask(T, 'Rename a file', null, () => { prompted++; return null }, { ...o, details: { memo: 'x\uDC00' } })).toEqual({ approved: false, channel: null, tier: 'ask', reason: 'malformed' })
    expect(await ask(T, 'Send an invoice', null, () => { prompted++; return null }, { ...o, send: { recipient: 'dana@example.com', message: 'Hi \uD800' } })).toEqual({ approved: false, channel: null, tier: 'ask', reason: 'malformed' })
    expect(prompted).toBe(0)
    expect(o.ledger.pending()).toBe(0)
  })
  it('a detail may not reuse a named field', () => {
    for (const k of ['action', 'agentId', 'tier', 'amountMinor', 'currency']) {
      expect(() => new AskLedger().open({ action: 'a', tier: 'ask', channel: 'touch', details: { [k]: 'x' } }), k).toThrow(ApprovalDenied)
    }
  })
  it('channel, ids, templateId and times are not in the digest', () => {
    let t = NOW
    const l = new AskLedger({ now: () => t })
    const a = l.open({ action: 'a', tier: 'ask', channel: 'touch', agentId: 'x', templateId: 't1' })
    t += 5000
    const b = l.open({ action: 'a', tier: 'ask', channel: 'phone', agentId: 'x', templateId: 't2' })
    expect(a.id).not.toBe(b.id)
    expect(a.digest8).toBe(b.digest8)
  })
  it('firstLine: first non-empty line trimmed, 80 code points (79 + ellipsis), emoji never split, never empty', () => {
    expect(firstLine('\n  \r\n  Hello there  \nsecond')).toBe('Hello there')
    expect(firstLine('x'.repeat(80))).toBe('x'.repeat(80))
    expect(firstLine('x'.repeat(81))).toBe(`${'x'.repeat(79)}\u2026`)
    const e = firstLine('\u{1F600}'.repeat(90))
    expect(Array.from(e)).toHaveLength(80)
    expect(e).toBe(`${'\u{1F600}'.repeat(79)}\u2026`)
    expect(firstLine(' \n\t\n')).toBe('')
    expect(() => new AskLedger().open({ action: 'a', tier: 'ask', channel: 'touch', firstLine: '' })).toThrow(ApprovalDenied)
  })
})

describe('v3 answerId, hold_too_short and stale_channel', () => {
  const touch = (l: AskLedger) => l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
  it('the same answer_id twice is replayed; a fresh one after approval is replayed too', () => {
    let l = new AskLedger(); let r = touch(l)
    const m = reply(r)
    expect(l.settle(fromDeviceReply(m)!)).toEqual({ ok: true })
    expect(l.settle(fromDeviceReply(m)!)).toEqual({ ok: false, reason: 'replayed' })
    l = new AskLedger(); r = touch(l)
    expect(l.settle(fromDeviceReply(reply(r))!)).toEqual({ ok: true })
    expect(l.settle(fromDeviceReply(reply(r))!)).toEqual({ ok: false, reason: 'replayed' })
  })
  it('hold_too_short keeps the Ask open; its answer_id cannot be reused; after expiry it is expired', () => {
    let t = NOW
    const l = new AskLedger({ now: () => t })
    const r = touch(l)
    const short = reply(r, { hold_ms: 100 })
    expect(l.settle(fromDeviceReply(short)!)).toEqual({ ok: false, reason: 'hold_too_short' })
    expect(l.pending()).toBe(1)
    expect(l.settle(fromDeviceReply({ ...short, hold_ms: 2000 })!)).toEqual({ ok: false, reason: 'replayed' })
    const r2 = touch(l)
    expect(l.settle(fromDeviceReply(reply(r2, { hold_ms: 100 }))!)).toEqual({ ok: false, reason: 'hold_too_short' })
    t = r2.expiresAt
    expect(l.settle(fromDeviceReply(reply(r2))!)).toEqual({ ok: false, reason: 'expired' })
  })
  it('a deny after a short hold closes the Ask', () => {
    const l = new AskLedger(); const r = touch(l)
    l.settle(fromDeviceReply(reply(r, { hold_ms: 100 }))!)
    expect(l.settle(fromDeviceReply(reply(r, { answer: 'no', hold_ms: 0 }))!)).toEqual({ ok: true })
    expect(l.pending()).toBe(0)
  })
  it('phone UUID answerIds are accepted; the device needs 32 hex; a phone answer with no answerId is malformed', () => {
    const l = new AskLedger()
    const m = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 100 })
    const { answerId: _a, ...noId } = phoneAnswer(m)
    expect(l.settle(noId as AskAnswer, PAIRED)).toEqual({ ok: false, reason: 'malformed' })
    expect(l.settle(phoneAnswer(m), PAIRED)).toEqual({ ok: true })
    expect(fromDeviceReply(reply(touch(l), { answer_id: randomUUID() }))).toBeNull()
  })
  it('stale_channel: after a handoff a device approve or deny is logged and does not spend; the phone settles it', () => {
    const l = new AskLedger()
    const seen: unknown[] = []
    l.onAttempt = (a) => seen.push(a)
    const r = touch(l)
    l.handoff(r.id, 'phone')
    const yes = fromDeviceReply(reply(r))!
    const no = fromDeviceReply(reply(r, { answer: 'no', hold_ms: 0 }))!
    expect(l.settle(yes, PAIRED)).toEqual({ ok: false, reason: 'stale_channel' })
    expect(l.settle(no, PAIRED)).toEqual({ ok: false, reason: 'stale_channel' })
    expect(l.settle({ ...no, answerId: hex() }, { ...PAIRED, via: 'touch' })).toEqual({ ok: false, reason: 'stale_channel' })
    expect(seen).toMatchObject([
      { id: r.id, answerId: yes.answerId, channel: 'touch', reason: 'stale_channel', holdMs: 1620 },
      { id: r.id, answerId: no.answerId, channel: 'touch', reason: 'stale_channel', holdMs: 0 },
      { reason: 'stale_channel' },
    ])
    expect(l.settle(yes, PAIRED)).toEqual({ ok: false, reason: 'stale_channel' }) // v3.1: stale before replayed
    expect(l.pending()).toBe(1)
    const r2 = touch(l); l.handoff(r2.id, 'phone')
    l.settle(fromDeviceReply(reply(r2))!, PAIRED)
    expect(l.settle(phoneAnswer(r2, { approved: false }), PAIRED)).toEqual({ ok: true })
  })
  it('check order (v3.1): stale_channel before replayed; an old-channel answer with a reused answerId keeps the Ask; replayed on the current channel spends it', () => {
    const l = new AskLedger()
    const seen: { reason: string; answerId: string }[] = []
    l.onAttempt = (a) => seen.push(a)
    const r = touch(l)
    const short = fromDeviceReply(reply(r, { hold_ms: 100 }))!
    expect(l.settle(short)).toEqual({ ok: false, reason: 'hold_too_short' }) // spends this answerId
    l.handoff(r.id, 'phone')
    const reused = { ...short, holdMs: 2000 }
    expect(l.settle(reused, PAIRED)).toEqual({ ok: false, reason: 'stale_channel' })
    expect(l.settle(reused, PAIRED)).toEqual({ ok: false, reason: 'stale_channel' })
    expect(seen.map((a) => [a.reason, a.answerId])).toEqual([['hold_too_short', short.answerId], ['stale_channel', short.answerId], ['stale_channel', short.answerId]])
    expect(l.pending()).toBe(1)
    // On the current channel a reused answerId is replayed and spends the Ask.
    const phone = phoneAnswer(r)
    const r2 = touch(l); l.handoff(r2.id, 'phone')
    expect(l.settle(phoneAnswer(r2, { answerId: phone.answerId }), PAIRED)).toEqual({ ok: true })
    expect(l.settle(phone, PAIRED)).toEqual({ ok: false, reason: 'replayed' })
    expect(l.settle(phoneAnswer(r), PAIRED)).toEqual({ ok: false, reason: 'replayed' })
    expect(l.pending()).toBe(0)
  })
  it('handoff state survives a journal round trip', () => {
    const l = new AskLedger(); const r = touch(l); l.handoff(r.id, 'phone')
    const back = new AskLedger(); back.restore(JSON.parse(JSON.stringify(l.toJSON())))
    expect(back.settle(fromDeviceReply(reply(r))!, PAIRED)).toEqual({ ok: false, reason: 'stale_channel' })
  })
  it('only an open, unexpired touch Ask moves, and only to the phone', () => {
    let t = NOW
    const l = new AskLedger({ now: () => t })
    const r = touch(l)
    expect(l.handoff(r.id, 'voice')).toBeNull()
    expect(l.handoff(randomUUID(), 'phone')).toBeNull()
    const p = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 1 })
    expect(l.handoff(p.id, 'phone')).toBeNull()
    t = r.expiresAt
    expect(l.handoff(r.id, 'phone')).toBeNull()
  })
})

describe('v3 outcome reasons (PM spec: always present)', () => {
  it('approved, denied, expired, no_channel, never', async () => {
    const o = { ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'bk1', kind, available: ['touch'] }
    const ok = await ask(T, 'Rename a file', null, (_c, _p, r) => fromDeviceReply(reply(r!)), o)
    expect(ok).toMatchObject({ approved: true, channel: 'touch', reason: 'approved' })
    const no = await ask(T, 'Rename a file', null, (_c, _p, r) => fromDeviceReply(reply(r!, { answer: 'no' })), o)
    expect(no).toMatchObject({ approved: false, channel: 'touch', reason: 'denied' })
    let t = NOW
    const late = await ask(T, 'Rename a file', null, (_c, _p, r) => { t = r!.expiresAt; return fromDeviceReply(reply(r!)) }, { ...o, ledger: new AskLedger({ now: () => t }) })
    expect(late).toMatchObject({ approved: false, reason: 'expired' })
    expect((await opened('Brakes step', { available: ['touch'] })).outcome.reason).toBe('no_channel')
    expect(neverOutcome().reason).toBe('never')
    const auto = await opened('Read the ledger', { kind: { manifest: stampManifest([{ name: 'r', readOnly: true, send: false }], 'bridge'), tool: 'r' } })
    expect(auto.outcome).toEqual({ approved: true, channel: null, tier: 'auto', reason: 'approved' })
  })
})
