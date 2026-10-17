/** App's requests (Oct 15): display fields on AskRequest, and the F6 pairing check string. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, PAIRING_CHECK_VERSION, PhonePairing, actionDigest8, ask, openJournal, pairingCheck,
  type AskRequest, type ApprovalTemplate,
} from './approvals.js'
import { randomBytes as aidBytes } from 'node:crypto'
/** DECISIONS ad47477: every answer carries a fresh answerId (32 lowercase hex). */
const aid = (): string => aidBytes(16).toString('hex')
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** locked_ask and money Asks go to the paired phone only (pilot review A1). */
function paired() {
  const p = new PhonePairing()
  const { code } = p.begin('touch'); p.offer('p1', 'pub1', code); p.confirm('p1', 'touch', true)
  return p
}

const BK: ApprovalTemplate = { permissions: { ask: ['Send an invoice'] } }
// Shield pilot review (a): only an explicit send:false keeps a tool out of the send checks.
const kind = { manifest: [{ name: 'x', send: false, owner: 'bridge' }], tool: 'x' }
function clock(t = 1_000_000) {
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('AskRequest display fields', () => {
  it('send money Ask carries agentId, templateId, action, recipient, firstLine, currency', async () => {
    let req: AskRequest | undefined
    await ask(BK, 'Send an invoice', null, (_c, _p, r) => { req = r; return false }, {
      ledger: new AskLedger(), kind, window: new ApprovalWindow(), agentId: 'bookkeeper-1', templateId: 'owner-bookkeeper',
      amountMinor: 1250, isSend: true, send: { recipient: 'dana@example.com', message: '\nHi Dana, invoice attached.\nThanks' }, available: ['phone'], pairing: paired(),
    })
    expect(req).toMatchObject({
      agentId: 'bookkeeper-1', templateId: 'owner-bookkeeper', action: 'Send an invoice', recipient: 'dana@example.com',
      firstLine: 'Hi Dana, invoice attached.', amountMinor: 1250, currency: 'USD', channel: 'phone', tier: 'ask',
    })
  })
  it('no amount: no currency; no send: no recipient or firstLine; ids absent when not given', () => {
    const r = new AskLedger().open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(r.action).toBe('a')
    for (const k of ['currency', 'amountMinor', 'recipient', 'firstLine', 'agentId', 'templateId']) expect(k in r).toBe(false)
  })
  it('currency is present whenever amountMinor is, including 0', () => {
    expect(new AskLedger().open({ action: 'a', tier: 'ask', channel: 'phone', amountMinor: 0 }).currency).toBe('USD')
  })
  it('templateId is not in the digest; agentId, tier, currency and content are (protocol README "Digest")', () => {
    const l = new AskLedger()
    const a = l.open({ action: 'a', tier: 'ask', channel: 'phone', amountMinor: 5, agentId: 'x', templateId: 't' })
    const b = l.open({ action: 'a', tier: 'ask', channel: 'phone', amountMinor: 5, agentId: 'x', templateId: 'u' })
    const c = l.open({ action: 'a', tier: 'ask', channel: 'phone', amountMinor: 5, agentId: 'y', templateId: 't' })
    const d = l.open({ action: 'a', tier: 'locked_ask', channel: 'phone', amountMinor: 5, agentId: 'x' })
    expect(a.digest8).toBe(b.digest8)
    expect(c.digest8).not.toBe(a.digest8)
    expect(d.digest8).not.toBe(a.digest8)
    expect(a.digest8).toBe(actionDigest8('a', { agentId: 'x', tier: 'ask', amountMinor: 5, currency: 'USD' }))
    expect(a.digest8).not.toBe(actionDigest8('a', { agentId: 'x', tier: 'ask', amountMinor: 5 }))
    const n = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(n.digest8).toBe(actionDigest8('a', { tier: 'ask' }))
  })
  it('journal round-trips the new fields and rejects bad ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-'))
    const p = join(dir, 'j.json')
    const j = openJournal(p)
    const r = j.ledger.open({ action: 'a', tier: 'ask', channel: 'phone', amountMinor: 5, agentId: 'g', templateId: 't', recipient: 'r', firstLine: 'f' })
    const j2 = openJournal(p)
    expect(j2.recovered).toBe(false)
    expect(j2.ledger.toJSON().open[0]).toEqual(r)
    const base = { v: 1, window: { lockedUntil: 0, entries: {} }, pairing: { phones: [] } }
    const req = { id: 'x', digest8: '0011aabb', openedAt: 0, expiresAt: 1, channel: 'touch', tier: 'ask', action: 'a' }
    for (const bad of [
      { ...req, action: undefined }, { ...req, currency: 'USD' }, { ...req, amountMinor: 5 }, { ...req, amountMinor: 5, currency: 'EUR' }, { ...req, agentId: 7 },
    ]) {
      writeFileSync(p, JSON.stringify({ ...base, ledger: { open: [bad], spent: [] } }))
      expect(openJournal(p).recovered).toBe(true)
    }
  })
})

describe('F6 pairing check string', () => {
  it('is 6 digits from sha256 of version|code|phonePub|deviceNonce', () => {
    const h = createHash('sha256').update(`${PAIRING_CHECK_VERSION}|123456|pubA|nonce1`).digest()
    expect(pairingCheck('123456', 'pubA', 'nonce1')).toBe(String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0'))
    expect(pairingCheck('123456', 'pubA', 'nonce1')).toMatch(/^\d{6}$/)
    expect(PAIRING_CHECK_VERSION).toBe('ildra-pair-v1')
  })
  it('changes if the code, phone key or nonce changes', () => {
    const c = pairingCheck('123456', 'pubA', 'n')
    expect(pairingCheck('123457', 'pubA', 'n')).not.toBe(c)
    expect(pairingCheck('123456', 'pubB', 'n')).not.toBe(c)
    expect(pairingCheck('123456', 'pubA', 'm')).not.toBe(c)
  })
  it('device and phone compute the same string; pairing completes only after a touch confirm of the match', () => {
    const p = new PhonePairing()
    const start = p.begin('touch')
    expect(start.deviceNonce).toMatch(/^[0-9a-f]{32}$/)
    const offer = p.offer('phone-1', 'pubA', start.code)
    expect(offer).toMatchObject({ ok: true })
    const phoneSide = pairingCheck(start.code, 'pubA', start.deviceNonce)
    expect(offer.ok && offer.check).toBe(phoneSide)
    expect(p.pendingCheck('phone-1')).toBe(phoneSide)
    expect(p.isPaired('phone-1')).toBe(false)
    expect(p.confirm('phone-1', 'touch', true)).toBe(true)
    expect(p.isPaired('phone-1')).toBe(true)
    expect(p.pendingCheck('phone-1')).toBeNull()
  })
  it('confirm by voice or phone, a mismatch, a second confirm, or expiry refuses', () => {
    const c = clock()
    const p = new PhonePairing({ now: c.now, ttlMs: 100 })
    for (const [ch, matched, reason] of [['voice', true, 'not_touch'], ['phone', true, 'not_touch'], ['touch', false, 'check_mismatch']] as const) {
      const s = p.begin('touch')
      p.offer('ph', 'pub', s.code)
      expect(p.confirm('ph', ch, matched)).toBe(false)
      expect(p.log.at(-1)).toMatchObject({ event: 'refused', reason })
      p.confirm('ph', 'touch', false)
    }
    expect(p.confirm('ph', 'touch', true)).toBe(false)
    expect(p.log.at(-1)?.reason).toBe('no_pending')
    const s = p.begin('touch')
    p.offer('ph', 'pub', s.code)
    c.advance(100)
    expect(p.confirm('ph', 'touch', true)).toBe(false)
    expect(p.log.at(-1)?.reason).toBe('expired')
    expect(p.isPaired()).toBe(false)
  })
  it('offer refuses unknown, reused, expired, shared, and missing ids or keys', () => {
    const c = clock()
    const p = new PhonePairing({ now: c.now, ttlMs: 100 })
    expect(p.offer('a', 'pub', '000000')).toEqual({ ok: false, reason: 'unknown_code' })
    const s1 = p.begin('touch')
    expect(p.offer('a', 'pub', s1.code).ok).toBe(true)
    expect(p.offer('b', 'pub', s1.code)).toEqual({ ok: false, reason: 'unknown_code' })
    expect(p.offer('a', 'pub', p.begin('touch').code, { shared: true })).toEqual({ ok: false, reason: 'shared_machine' })
    expect(p.offer('', 'pub', p.begin('touch').code)).toEqual({ ok: false, reason: 'no_phone_id' })
    expect(p.offer('a', '', p.begin('touch').code)).toEqual({ ok: false, reason: 'no_phone_pub' })
    const late = p.begin('touch')
    c.advance(100)
    expect(p.offer('a', 'pub', late.code)).toEqual({ ok: false, reason: 'expired' })
  })
  it('begin still refuses voice, phone and shared machines', () => {
    const p = new PhonePairing()
    expect(() => p.begin('voice')).toThrow(ApprovalDenied)
    expect(() => p.begin('touch', { shared: true })).toThrow(ApprovalDenied)
  })
})

describe('App follow-up: offer returns deviceNonce, pairingStatus', () => {
  it('offer success returns the same deviceNonce so the phone computes the check alone', () => {
    const p = new PhonePairing()
    const s = p.begin('touch')
    const o = p.offer('ph', 'pubA', s.code)
    expect(o).toEqual({ ok: true, check: pairingCheck(s.code, 'pubA', s.deviceNonce), deviceNonce: s.deviceNonce, expiresAt: s.expiresAt })
    if (o.ok) expect(pairingCheck(s.code, 'pubA', o.deviceNonce)).toBe(o.check)
  })
  it('status goes unknown -> pending -> paired, unpair returns to unknown', () => {
    const p = new PhonePairing()
    expect(p.pairingStatus('ph')).toEqual({ state: 'unknown' })
    p.offer('ph', 'pub', p.begin('touch').code)
    expect(p.pairingStatus('ph')).toEqual({ state: 'pending' })
    p.confirm('ph', 'touch', true)
    expect(p.pairingStatus('ph')).toEqual({ state: 'paired' })
    p.unpair('ph')
    expect(p.pairingStatus('ph')).toEqual({ state: 'unknown' })
  })
  it('keeps the last refusal reason; a new pending or pairing clears it', () => {
    const p = new PhonePairing()
    p.offer('ph', 'pub', '999999')
    expect(p.pairingStatus('ph')).toEqual({ state: 'refused', reason: 'unknown_code' })
    p.offer('ph', 'pub', p.begin('touch').code)
    expect(p.pairingStatus('ph')).toEqual({ state: 'pending' })
    p.confirm('ph', 'touch', false)
    expect(p.pairingStatus('ph')).toEqual({ state: 'refused', reason: 'check_mismatch' })
    p.offer('ph', 'pub', p.begin('touch').code)
    p.confirm('ph', 'touch', true)
    expect(p.pairingStatus('ph')).toEqual({ state: 'paired' })
    p.offer('', 'pub', p.begin('touch').code)
    expect(p.pairingStatus('')).toEqual({ state: 'unknown' })
  })
  it('a pending pair past expiry reads as refused: expired', () => {
    const c = clock()
    const p = new PhonePairing({ now: c.now, ttlMs: 10 })
    p.offer('ph', 'pub', p.begin('touch').code)
    c.advance(10)
    expect(p.pairingStatus('ph')).toEqual({ state: 'refused', reason: 'expired' })
  })
  it('refusal reasons persist in the journal; bad ones fail closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'))
    const f = join(dir, 'j.json')
    const j = openJournal(f)
    j.pairing.offer('ph', 'pub', '000001')
    j.pairing.offer('ok', 'pub', j.pairing.begin('touch').code)
    j.pairing.confirm('ok', 'touch', true)
    const j2 = openJournal(f)
    expect(j2.pairing.pairingStatus('ph')).toEqual({ state: 'refused', reason: 'unknown_code' })
    expect(j2.pairing.pairingStatus('ok')).toEqual({ state: 'paired' })
    const base = { v: 1, window: { lockedUntil: 0, entries: {} }, ledger: { open: [], spent: [] } }
    for (const refused of [null, [], { a: 1 }]) {
      writeFileSync(f, JSON.stringify({ ...base, pairing: { phones: [], refused } }))
      expect(openJournal(f).recovered).toBe(true)
    }
  })
})

describe('prompt text still reaches the answer function', () => {
  it('ASK and LOCKED_ASK prompts are generated and passed', async () => {
    const prompts: string[] = []
    await ask(BK, 'Send an invoice', null, (_c, p, r) => { prompts.push(p); return { id: r!.id, digest8: r!.digest8, answerId: aid(), approved: false } },
      { ledger: new AskLedger(), kind, available: ['touch'] })
    await ask({ permissions: { locked_ask: ['Brakes step'] } }, 'Brakes step', null, (_c, p) => { prompts.push(p); return false },
      { ledger: new AskLedger(), kind, pairing: paired(), available: ['phone'] })
    expect(prompts).toEqual(['ASK: Send an invoice', 'LOCKED_ASK: Brakes step'])
  })
})
