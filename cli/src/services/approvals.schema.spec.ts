/**
 * Real approvals.ts outputs validate against the Ildra wire schema (draft 2020-12).
 * ildra-messages.schema.json here is a byte-identical vendored copy of protocol/ildra-messages.schema.json
 * in Marked-User/ildra (the source of truth). Set ILDRA_SCHEMA_PATH to that file to check the copy.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import Ajv2020Module from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  ApprovalWindow, AskLedger, PhonePairing, ask, pairingCheck,
  type AskAnswer, type AskRequest, type ApprovalTemplate,
  stampManifest,
} from './approvals.js'
import { randomBytes as aidBytes } from 'node:crypto'
import { fixturePhonePub } from './ildraAsk.testkit.js'
/** DECISIONS ad47477: every answer carries a fresh answerId (32 lowercase hex). */
const aid = (): string => aidBytes(16).toString('hex')

/** Shield pilot review A1: a device (touch) approval is a hold of 1.5 s or more; phone answers ignore it. */
const HOLD = 2000

const schemaText = readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8')
const schema = JSON.parse(schemaText)
// ajv ships CommonJS; under NodeNext the class is the default export's `default`.
const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module
const ajv = new (Ajv2020 as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true })
ajv.addSchema(schema)
const id = schema.$id as string

function check(def: string, value: unknown): string[] {
  const v = ajv.getSchema(`${id}#/$defs/${def}`)!
  return v(value) ? [] : (v.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`)
}
const valid = (def: string, value: unknown) => expect(check(def, value), JSON.stringify(value)).toEqual([])
const invalid = (def: string, value: unknown) => expect(check(def, value).length, JSON.stringify(value)).toBeGreaterThan(0)
function envelope(type: string, body: unknown): string[] {
  const v = ajv.getSchema(id)!
  return v({ type, proto: 1, body }) ? [] : (v.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`)
}

const T: ApprovalTemplate = { permissions: { auto: ['Read the ledger'], ask: ['Send an invoice', 'Pay a bill'], locked_ask: ['Brakes step'] } }
const MIC = { speaking: () => {} }
// Shield pilot review (a): only an explicit send:false keeps a tool out of the send checks.
const kind = { manifest: stampManifest([{ name: 'x', send: false }], 'bridge'), tool: 'x' }
const PUB = 'A'.repeat(43) + '='

describe('vendored schema', () => {
  it('compiles under draft 2020-12 strict mode and matches the Ildra copy when given', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    for (const d of ['AskRequest', 'AskAnswer', 'AskRejection', 'AskOutcome', 'PairingBegin', 'PairingOffer', 'PairingOfferResult', 'PairingConfirm', 'PairingStatus']) {
      expect(schema.$defs[d], d).toBeDefined()
    }
    const src = process.env.ILDRA_SCHEMA_PATH
    if (src && existsSync(src)) {
      const sha = (s: string) => createHash('sha256').update(s).digest('hex')
      expect(sha(schemaText)).toBe(sha(readFileSync(src, 'utf8')))
    }
  })
})

describe('real AskRequest outputs', () => {
  it('money, send, voice, locked_ask and plain requests from AskLedger.open and ask()', async () => {
    const l = new AskLedger()
    const reqs: AskRequest[] = [
      l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 12_000, agentId: 'bills', templateId: 'home-bills' }),
      l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 0 }),
      l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone' }),
      l.open({ action: 'Send an invoice', tier: 'ask', channel: 'voice' }),
    ]
    await ask(T, 'Send an invoice', null, (_c, _p, r) => { reqs.push(r!); return false }, {
      ledger: l, kind, window: new ApprovalWindow(), agentId: 'bk', templateId: 'owner-bookkeeper', mic: MIC,
      isSend: true, send: { recipient: 'dana@example.com', message: 'Hi Dana, invoice attached.' },
    })
    for (const r of reqs) {
      valid('AskRequest', r)
      expect(envelope('ildra.ask.request', r)).toEqual([])
      expect(r.expiresAt - r.openedAt).toBe(r.amountMinor !== undefined ? 3_600_000 : 86_400_000)
    }
    expect(reqs[4]).toMatchObject({ channel: 'voice', recipient: 'dana@example.com', firstLine: 'Hi Dana, invoice attached.' })
  })

  it('money cases: amountMinor and currency only together; voice needs the 2-word challenge', () => {
    const base = { id: '00000000-0000-4000-8000-000000000000', digest8: '0011aabb', openedAt: 1, expiresAt: 2, channel: 'touch', tier: 'ask', action: 'a' }
    valid('AskRequest', { ...base, channel: 'phone', amountMinor: 5, currency: 'USD' })
    valid('AskRequest', { ...base, channel: 'phone', amountMinor: 0, currency: 'USD' })
    invalid('AskRequest', { ...base, amountMinor: 5 })
    invalid('AskRequest', { ...base, currency: 'USD' })
    invalid('AskRequest', { ...base, amountMinor: 5, currency: 'EUR' })
    invalid('AskRequest', { ...base, amountMinor: -1, currency: 'USD' })
    invalid('AskRequest', { ...base, amountMinor: 1.5, currency: 'USD' })
    invalid('AskRequest', { ...base, channel: 'voice' })
    invalid('AskRequest', { ...base, channel: 'voice', challenge: 'maple' })
    invalid('AskRequest', { ...base, channel: 'voice', challenge: 'maple river lake' })
    invalid('AskRequest', { ...base, challenge: 'maple river' })
    valid('AskRequest', { ...base, channel: 'voice', challenge: 'maple river' })
    invalid('AskRequest', { ...base, channel: 'voice', challenge: 'maple river', tier: 'locked_ask' })
    // Pilot review A1: locked_ask and money are phone-only (no device touch, no voice).
    invalid('AskRequest', { ...base, channel: 'voice', challenge: 'maple river', amountMinor: 5001, currency: 'USD' })
    invalid('AskRequest', { ...base, channel: 'voice', challenge: 'maple river', amountMinor: 5000, currency: 'USD' })
    invalid('AskRequest', { ...base, amountMinor: 5, currency: 'USD' })
    invalid('AskRequest', { ...base, tier: 'locked_ask' })
    valid('AskRequest', { ...base, channel: 'phone', tier: 'locked_ask' })
    for (const k of ['tier', 'expiresAt', 'id', 'digest8', 'action']) {
      const { [k]: _, ...rest } = base as Record<string, unknown>
      invalid('AskRequest', rest)
    }
    invalid('AskRequest', { ...base, tier: 'auto' })
    invalid('AskRequest', { ...base, recipient: 'r' })
    invalid('AskRequest', { ...base, extra: 1 })
    invalid('AskRequest', { ...base, agentId: null })
  })
})

describe('real AskAnswer, AskRejection and AskOutcome outputs', () => {
  it('answers, rejections and outcomes from a run validate', async () => {
    const l = new AskLedger()
    const pairing = new PhonePairing()
    const s = pairing.begin('touch'); pairing.offer('p1', fixturePhonePub('pubA'), s.code, { machinePub: PUB }); pairing.confirm('p1', 'touch', true)
    const answers: AskAnswer[] = []
    const outcomes = []
    const answer = (extra: Partial<AskAnswer>) => (_c: unknown, _p: unknown, r?: AskRequest) => {
      const a: AskAnswer = { id: r!.id, digest8: r!.digest8, answerId: aid(), approved: true, holdMs: HOLD, transcript: r!.challenge ? `yes ${r!.challenge}` : undefined, from: { phoneId: 'p1', machinePub: PUB }, ...extra }
      if (a.transcript === undefined) delete a.transcript
      answers.push(a)
      return a
    }
    const o = { ledger: l, kind, pairing, mic: MIC }
    outcomes.push(await ask(T, 'Send an invoice', null, answer({}), o))
    outcomes.push(await ask(T, 'Brakes step', null, answer({}), { ...o, available: ['phone'] }))
    outcomes.push(await ask(T, 'Brakes step', null, answer({ digest8: 'ffffffff' }), { ...o, available: ['phone'] }))
    // R7-10: the unpaired answer is refused and the Ask stays open; the paired phone then denies it.
    let n = 0
    const unpairedThenDeny = answer({ from: { phoneId: 'zz' } }); const deny = answer({ approved: false })
    outcomes.push(await ask(T, 'Brakes step', null, (c, p, r) => (++n === 1 ? unpairedThenDeny(c, p, r) : deny(c, p, r)), { ...o, available: ['phone'] }))
    outcomes.push(await ask(T, 'Read the ledger', null, answer({}), o))
    outcomes.push(await ask(T, 'Brakes step', null, answer({}), { ...o, available: ['voice'] }))
    for (const a of answers) { valid('AskAnswer', a); expect(envelope('ildra.ask.answer', a)).toEqual([]) }
    for (const out of outcomes) { valid('AskOutcome', out); expect(envelope('ildra.ask.outcome', out)).toEqual([]) }
    expect(outcomes.map((x) => x.reason)).toEqual(['approved', 'approved', 'digest_mismatch', 'denied', 'approved', 'no_channel'])
    for (const reason of ['malformed', 'unknown_id', 'replayed', 'expired', 'digest_mismatch', 'challenge_mismatch', 'verifier_rejected', 'shared_machine', 'unpaired_phone', 'hold_too_short']) {
      valid('AskRejection', { ok: false, reason })
    }
    const req = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    const rej = l.settle({ id: req.id, digest8: 'deadbeef', answerId: aid(), approved: true, holdMs: HOLD })
    valid('AskRejection', rej)
    l.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: HOLD })
    const replay = l.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: HOLD })
    valid('AskRejection', replay)
    const req2 = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    const short = l.settle({ id: req2.id, digest8: req2.digest8, answerId: aid(), approved: true, holdMs: 600 })
    expect(short).toEqual({ ok: false, reason: 'hold_too_short' })
    valid('AskRejection', short)
  })
  it('rejects malformed answers and outcomes', () => {
    const a = { id: '00000000-0000-4000-8000-000000000000', digest8: '0011aabb', answerId: aid(), approved: true, holdMs: HOLD }
    valid('AskAnswer', a)
    invalid('AskAnswer', { ...a, approved: 'yes' })
    valid('AskAnswer', { ...a, holdMs: 1500.5 })
    invalid('AskAnswer', { ...a, holdMs: -1 })
    invalid('AskAnswer', { ...a, holdMs: '2000' })
    invalid('AskAnswer', { ...a, answer: 'approve' })
    invalid('AskAnswer', { ...a, from: { shared: 'no' } })
    invalid('AskAnswer', { ...a, from: { machinePub: 'short' } })
    invalid('AskRejection', { ok: false, reason: 'nope' })
    invalid('AskRejection', { ok: true })
    invalid('AskOutcome', { approved: true, channel: 'touch', tier: 'ask', reason: 'expired' })
    invalid('AskOutcome', { approved: false, channel: 'touch', tier: 'auto', reason: 'denied' })
    invalid('AskOutcome', { approved: true, tier: 'ask', reason: 'approved' })
    // PM spec (v3): reason always present, 'approved' exactly when approved.
    invalid('AskOutcome', { approved: false, channel: null, tier: 'locked_ask' })
    invalid('AskOutcome', { approved: true, channel: 'touch', tier: 'ask' })
    invalid('AskOutcome', { approved: false, channel: 'touch', tier: 'ask', reason: 'approved' })
    valid('AskOutcome', { approved: false, channel: null, tier: 'locked_ask', reason: 'no_channel' })
    valid('AskOutcome', { approved: true, channel: 'touch', tier: 'ask', reason: 'approved' })
  })
})

describe('real pairing outputs', () => {
  it('begin, offer, offer result, confirm and status validate', () => {
    const p = new PhonePairing()
    const s = p.begin('touch')
    valid('PairingBegin', s)
    const offer = { phoneId: 'p1', phonePub: fixturePhonePub('pubA'), code: s.code, origin: { machinePub: PUB } }
    valid('PairingOffer', offer)
    const statuses = [p.pairingStatus('p1')]
    const res = p.offer(offer.phoneId, offer.phonePub, offer.code, offer.origin)
    valid('PairingOfferResult', res)
    expect(res.ok && res.check).toBe(pairingCheck(s.code, fixturePhonePub('pubA'), s.deviceNonce))
    statuses.push(p.pairingStatus('p1'))
    const confirm = { phoneId: 'p1', confirmedBy: 'touch' as const, matched: true }
    valid('PairingConfirm', confirm)
    p.confirm(confirm.phoneId, confirm.confirmedBy, confirm.matched)
    statuses.push(p.pairingStatus('p1'))
    valid('PairingOfferResult', p.offer('p2', fixturePhonePub('pub'), '000000'))
    statuses.push(p.pairingStatus('p2'))
    for (const st of statuses) valid('PairingStatus', st)
    expect(statuses.map((x) => x.state)).toEqual(['unknown', 'pending', 'paired', 'refused'])
    for (const reason of ['unknown_code', 'shared_machine', 'expired', 'no_phone_id', 'no_phone_pub', 'locked_out', 'no_pending', 'not_touch', 'check_mismatch']) {
      valid('PairingStatus', { state: 'refused', reason })
      valid('PairingOfferResult', { ok: false, reason })
    }
    expect(envelope('ildra.pairing.begin', s)).toEqual([])
    expect(envelope('ildra.pairing.offer_result', res)).toEqual([])
    expect(envelope('ildra.pairing.status', statuses[2])).toEqual([])
  })
  it('rejects malformed pairing messages', () => {
    invalid('PairingBegin', { code: '1234', deviceNonce: 'a'.repeat(32), expiresAt: 1 })
    invalid('PairingBegin', { code: '123456', deviceNonce: 'xyz', expiresAt: 1 })
    invalid('PairingOffer', { phoneId: 'p', code: '123456' })
    invalid('PairingOfferResult', { ok: true, check: '12345', deviceNonce: 'a'.repeat(32), expiresAt: 1 })
    invalid('PairingOfferResult', { ok: true, check: '123456', expiresAt: 1 })
    invalid('PairingConfirm', { phoneId: 'p', confirmedBy: 'desktop', matched: true })
    invalid('PairingStatus', { state: 'refused' })
    invalid('PairingStatus', { state: 'paired', reason: 'x' })
  })
  it('envelope checks type, proto and body', () => {
    expect(envelope('ildra.ask.answer', { id: 'x' }).length).toBeGreaterThan(0)
    const v = ajv.getSchema(id)!
    expect(v({ type: 'prompt', proto: 1, body: {} })).toBe(false)
    expect(v({ type: 'ildra.pairing.status', proto: 2, body: { state: 'unknown' } })).toBe(false)
    expect(v({ type: 'ildra.pairing.status', proto: 1, body: { state: 'unknown' }, extra: 1 })).toBe(false)
  })
})
