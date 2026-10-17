/**
 * DECISIONS.md ad47477 (OPEN-QUESTIONS 49): single use moves to answer ids. Every AskAnswer carries a fresh
 * answerId; a used one is never accepted again (persisted in the journal). hold_too_short never spends the
 * Ask, which stays open until it expires; every other rejection still spends it. A voice deny needs no
 * challenge words (only an approve does), like a deny needs no hold.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AskLedger, openJournal, type AskAnswer, type AskRequest } from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
function clock(t = 5_000_000) { return { now: () => t, advance: (ms: number) => { t += ms } } }
const touch = (l: AskLedger) => l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
const ans = (req: AskRequest, extra: Partial<AskAnswer> = {}): AskAnswer => ({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 2000, ...extra })

describe('answerId', () => {
  it('is required: 16 to 64 characters of [A-Za-z0-9-] (phone UUIDs and firmware 32 hex both pass)', () => {
    for (const ok of [randomUUID(), aid(), aid().toUpperCase(), 'a'.repeat(16), 'Z-9'.repeat(21).slice(0, 64)]) {
      const l = new AskLedger()
      const r = l.open({ action: 'a', tier: 'ask', channel: 'phone' })
      expect(l.settle({ id: r.id, digest8: r.digest8, answerId: ok, approved: true, from: { phoneId: 'p1' } }, { isPaired: () => true }), ok).toEqual({ ok: true })
    }
    for (const answerId of [undefined, '', 'abc', 7, 'a'.repeat(15), 'a'.repeat(65), 'has space 0123456789', 'under_score_0123456', `${aid()}\n`]) {
      const l = new AskLedger(); const req = touch(l)
      expect(l.settle({ ...ans(req), answerId } as AskAnswer), String(answerId)).toEqual({ ok: false, reason: 'malformed' })
      // A malformed answer touches nothing: the Ask is still open.
      expect(l.pending()).toBe(1)
    }
  })
  it('a used answerId is refused, on the same Ask and on any other, and spends the Ask it is replayed at', () => {
    const l = new AskLedger(); const a = touch(l); const b = touch(l)
    const first = ans(a)
    expect(l.settle(first)).toEqual({ ok: true })
    expect(l.settle({ ...first, id: b.id, digest8: b.digest8 })).toEqual({ ok: false, reason: 'replayed' })
    expect(l.pending()).toBe(0)
    expect(l.settle(ans(b))).toEqual({ ok: false, reason: 'replayed' })
  })
  it('an answerId spent on an unknown Ask cannot be used later', () => {
    const l = new AskLedger(); const req = touch(l)
    const reused = aid()
    expect(l.settle({ id: randomUUID(), digest8: '0011aabb', answerId: reused, approved: true })).toEqual({ ok: false, reason: 'unknown_id' })
    expect(l.settle(ans(req, { answerId: reused }))).toEqual({ ok: false, reason: 'replayed' })
  })
  it('spent answerIds survive a restart', () => {
    const c = clock(); const d = mkdtempSync(join(tmpdir(), 'aid-')); const f = join(d, 'j', 'j.json'); const m = join(d, 'm', 'x')
    const j1 = openJournal(f, { now: c.now, markerPath: m })
    const req = touch(j1.ledger)
    const short = ans(req, { holdMs: 300 })
    expect(j1.ledger.settle(short)).toEqual({ ok: false, reason: 'hold_too_short' })
    const j2 = openJournal(f, { now: c.now, markerPath: m })
    expect(j2.recovered).toBe(false)
    expect(j2.ledger.settle({ ...short, holdMs: 2000 })).toEqual({ ok: false, reason: 'replayed' })
  })
})

describe('hold_too_short keeps the Ask open', () => {
  it('any number of short holds, then a proper hold approves', () => {
    const l = new AskLedger(); const req = touch(l)
    for (let i = 0; i < 6; i++) expect(l.settle(ans(req, { holdMs: 900 }))).toEqual({ ok: false, reason: 'hold_too_short' })
    expect(l.pending()).toBe(1)
    expect(l.settle(ans(req, { holdMs: 1500 }))).toEqual({ ok: true })
    expect(l.pending()).toBe(0)
  })
  it('until it expires', () => {
    const c = clock(); const l = new AskLedger({ now: c.now, ttlMs: 1000 }); const req = touch(l)
    expect(l.settle(ans(req, { holdMs: 1 }))).toEqual({ ok: false, reason: 'hold_too_short' })
    c.advance(1000)
    expect(l.settle(ans(req))).toEqual({ ok: false, reason: 'expired' })
  })
  it('only when id and digest8 match and the Ask has not expired; a wrong digest spends it', () => {
    const c = clock(); const l = new AskLedger({ now: c.now, ttlMs: 1000 })
    const a = touch(l)
    expect(l.settle(ans(a, { digest8: 'deadbeef', holdMs: 1 }))).toEqual({ ok: false, reason: 'digest_mismatch' })
    expect(l.settle(ans(a))).toEqual({ ok: false, reason: 'replayed' })
    const b = touch(l)
    c.advance(1000)
    expect(l.settle(ans(b, { holdMs: 1 }))).toEqual({ ok: false, reason: 'expired' })
  })
  it('other rejections still spend the Ask (shared machine, verifier)', () => {
    const l = new AskLedger({ verifier: (_r, x) => x.signature === 'ok' }); const a = touch(l)
    expect(l.settle(ans(a, { from: { shared: true } }))).toEqual({ ok: false, reason: 'shared_machine' })
    expect(l.settle(ans(a))).toEqual({ ok: false, reason: 'replayed' })
    const b = touch(l)
    expect(l.settle(ans(b))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(l.settle(ans(b, { signature: 'ok' }))).toEqual({ ok: false, reason: 'replayed' })
  })
  it('a short hold from a shared machine is a shared_machine rejection (spends), not a short hold', () => {
    const l = new AskLedger(); const a = touch(l)
    expect(l.settle(ans(a, { holdMs: 1, from: { shared: true } }))).toEqual({ ok: false, reason: 'shared_machine' })
    expect(l.pending()).toBe(0)
  })
})

describe('voice deny', () => {
  it('a voice deny needs no challenge words; an approve does', () => {
    const l = new AskLedger()
    const v1 = l.open({ action: 'Send an email', tier: 'ask', channel: 'voice' })
    expect(l.settle({ id: v1.id, digest8: v1.digest8, answerId: aid(), approved: false })).toEqual({ ok: true })
    const v2 = l.open({ action: 'Send an email', tier: 'ask', channel: 'voice' })
    expect(l.settle({ id: v2.id, digest8: v2.digest8, answerId: aid(), approved: true, transcript: 'yes' })).toEqual({ ok: false, reason: 'challenge_mismatch' })
  })
})
