/**
 * Shield adversarial verification of the Ildra M1 blockers (security/FINDINGS.md F2, F5, F6, F8).
 * Written by Shield, independent of Build's specs. Each test is an attack that must fail.
 */
import { chmodSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, PhonePairing, actionDigest8, ask, openJournal,
  type AskAnswer, type AskRequest, type ApprovalTemplate, type AnswerFn,
} from './approvals.js'

const T: ApprovalTemplate = { permissions: { ask: ['Send an email', 'Pay a bill'], locked_ask: ['Brakes step'] } }
const MIC = { speaking: () => {} }
const KIND = (tool: string) => ({ kind: { manifest: [], tool } })

function clock(t = 10_000_000) {
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
function dir() { return mkdtempSync(join(tmpdir(), 'shield-')) }
function answerWith(fn: (req: AskRequest) => Partial<AskAnswer> | null): AnswerFn {
  return (_c, _p, req) => {
    const extra = fn(req!)
    return extra === null ? true : { id: req!.id, digest8: req!.digest8, approved: true, transcript: req!.challenge ? `yes ${req!.challenge}` : undefined, from: { phoneId: 'p1' }, ...extra }
  }
}
function pairedPhone(now: () => number) {
  const p = new PhonePairing({ now })
  const { code } = p.begin('touch')
  p.offer('p1', 'pub1', code)
  p.confirm('p1', 'touch', true)
  return p
}

describe('Shield F2: replay, expiry, digest', () => {
  it('replayed answer is rejected the second time', () => {
    const c = clock(); const l = new AskLedger({ now: c.now })
    const req = l.open({ action: 'Send an email', tier: 'ask', channel: 'touch' })
    const a: AskAnswer = { id: req.id, digest8: req.digest8, approved: true }
    expect(l.settle(a)).toEqual({ ok: true })
    expect(l.settle(a)).toEqual({ ok: false, reason: 'replayed' })
  })
  it('replay survives a daemon restart (spent ids persisted)', () => {
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    const req = j1.ledger.open({ action: 'Send an email', tier: 'ask', channel: 'touch' })
    const a: AskAnswer = { id: req.id, digest8: req.digest8, approved: true }
    expect(j1.ledger.settle(a).ok).toBe(true)
    const j2 = openJournal(f, { now: c.now })
    expect(j2.ledger.settle(a)).toEqual({ ok: false, reason: 'replayed' })
  })
  it('answer at or after expiry is rejected, money 1 h', () => {
    const c = clock(); const l = new AskLedger({ now: c.now })
    const req = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'touch', amountMinor: 100 })
    expect(req.expiresAt - req.openedAt).toBe(3_600_000)
    c.advance(3_600_000)
    expect(l.settle({ id: req.id, digest8: req.digest8, approved: true })).toEqual({ ok: false, reason: 'expired' })
  })
  it('answer for a different digest is rejected and spends the request', () => {
    const c = clock(); const l = new AskLedger({ now: c.now })
    const req = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'touch', amountMinor: 100 })
    const other = actionDigest8('Pay a bill', { amountMinor: 999999, currency: 'USD' })
    expect(l.settle({ id: req.id, digest8: other, approved: true })).toEqual({ ok: false, reason: 'digest_mismatch' })
    expect(l.settle({ id: req.id, digest8: req.digest8, approved: true })).toEqual({ ok: false, reason: 'replayed' })
  })
  it('bare true (reference style) does not approve in production', async () => {
    const c = clock()
    const r = await ask(T, 'Send an email', null, answerWith(() => null), { ...KIND('x'), ledger: new AskLedger({ now: c.now }), available: ['touch'] })
    expect(r.approved).toBe(false)
  })
  it('voice answer without the challenge words fails; recorded old challenge fails', async () => {
    const c = clock(); const l = new AskLedger({ now: c.now })
    let old = ''
    const r1 = await ask(T, 'Send an email', null, answerWith((q) => { old = q.challenge!; return {} }), { ...KIND('x'), ledger: l, mic: MIC, available: ['voice'] })
    expect(r1.approved).toBe(true)
    const r2 = await ask(T, 'Send an email', null, answerWith((q) => (q.challenge === old ? { transcript: 'yes' } : { transcript: `yes ${old}` })), { ...KIND('x'), ledger: l, mic: MIC, available: ['voice'] })
    expect(r2.approved).toBe(false)
    expect(r2.reason).toBe('challenge_mismatch')
  })
  it('voice is refused when no MicGuard is supplied', async () => {
    const r = await ask(T, 'Send an email', null, answerWith(() => ({})), { ...KIND('x'), ledger: new AskLedger(), available: ['voice'] })
    expect(r.channel).toBeNull()
    expect(r.approved).toBe(false)
  })
  it('verifier that throws or returns truthy non-true rejects', async () => {
    for (const v of [() => { throw new Error('x') }, () => 1 as unknown as boolean]) {
      const r = await ask(T, 'Send an email', null, answerWith(() => ({})), { ...KIND('x'), ledger: new AskLedger(), verifier: v, available: ['touch'] })
      expect(r.approved).toBe(false)
    }
  })
})

describe('Shield F5: restart mid-window', () => {
  it('$50 voice cap holds across a restart', async () => {
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    const o = { ...KIND('x'), ledger: j1.ledger, window: j1.window, agentId: 'a', mic: MIC, available: ['voice', 'touch'] }
    const r1 = await ask(T, 'Pay a bill', null, answerWith(() => ({})), { ...o, amountMinor: 4500 })
    expect(r1.channel).toBe('voice'); expect(r1.approved).toBe(true)
    const j2 = openJournal(f, { now: c.now })
    const r2 = await ask(T, 'Pay a bill', null, answerWith(() => ({})), { ...o, ledger: j2.ledger, window: j2.window, amountMinor: 4500 })
    expect(r2.channel).toBe('touch')
  })
  it('bulk over 20 holds across a restart', async () => {
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    j1.window.record('a', { count: 20 })
    const j2 = openJournal(f, { now: c.now })
    expect(j2.window.wouldExceed('a', { count: 1 }).voiceAllowed).toBe(false)
  })
  it('corrupted journal fails closed: voice off, no phones, no pending Asks', () => {
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    j1.pairing.restore({ phones: ['p1'] })
    j1.window.record('a', { count: 1 })
    j1.ledger.open({ action: 'Send an email', tier: 'ask', channel: 'touch' })
    j1.save()
    const body = readFileSync(f, 'utf8')
    for (const bad of [body.slice(0, body.length / 2), body.replace('"v":1', '"v":2'), body.replace(/"count":\d+/, '"count":-5'), '\u0000\u0000']) {
      writeFileSync(f, bad)
      const j = openJournal(f, { now: c.now })
      expect(j.recovered, bad.slice(0, 40)).toBe(true)
      expect(j.window.wouldExceed('a').voiceAllowed).toBe(false)
      expect(j.pairing.isPaired('p1')).toBe(false)
      expect(j.ledger.pending()).toBe(0)
      // The lock is itself persisted: a second restart stays closed.
      expect(openJournal(f, { now: c.now }).window.wouldExceed('a').voiceAllowed).toBe(false)
      writeFileSync(f, body)
    }
  })
  it('journal file is 0600', () => {
    const f = join(dir(), 'j.json'); openJournal(f)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })
  it('KNOWN GAP: deleting the journal resets the window (no fail-closed on missing file)', () => {
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    j1.window.record('a', { amountMinor: 5000 })
    unlinkSync(f)
    const j2 = openJournal(f, { now: c.now })
    // Documents current behavior so a fix flips this assertion.
    expect(j2.window.wouldExceed('a', { amountMinor: 100 }).voiceAllowed).toBe(true)
  })
  it('a pre-existing loose-mode journal is replaced with 0600 on open', () => {
    const f = join(dir(), 'j.json'); openJournal(f)
    chmodSync(f, 0o666)
    openJournal(f)
    // renameSync of a fresh 0600 tmp replaces it, so mode ends 0600 after the first save.
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })
})

describe('Shield F6: pairing', () => {
  it('pairing cannot start without a device touch, or from a shared machine', () => {
    const p = new PhonePairing()
    for (const ch of ['voice', 'phone'] as const) expect(() => p.begin(ch)).toThrow(ApprovalDenied)
    expect(() => p.begin('touch', { shared: true })).toThrow(ApprovalDenied)
  })
  it('code is single use: a second phone with the same code is refused', () => {
    const p = new PhonePairing()
    const { code } = p.begin('touch')
    expect(p.offer('p1', 'pub1', code).ok).toBe(true)
    expect(p.offer('evil', 'pubE', code)).toEqual({ ok: false, reason: 'unknown_code' })
  })
  it('offer alone does not pair; confirm needs touch and a match', () => {
    const p = new PhonePairing()
    const { code } = p.begin('touch')
    p.offer('p1', 'pub1', code)
    expect(p.isPaired('p1')).toBe(false)
    expect(p.confirm('p1', 'voice', true)).toBe(false)
    expect(p.isPaired('p1')).toBe(false)
    expect(p.confirm('p1', 'touch', false)).toBe(false) // mismatch spends the pending pair
    expect(p.confirm('p1', 'touch', true)).toBe(false)
  })
  it('phone answer from an unpaired phone id is rejected even if another phone is paired', async () => {
    const c = clock(); const pairing = pairedPhone(c.now)
    const r = await ask(T, 'Send an email', null, answerWith(() => ({ from: { phoneId: 'evil' } })), { ...KIND('x'), ledger: new AskLedger({ now: c.now }), pairing, available: ['phone'] })
    expect(r.approved).toBe(false); expect(r.reason).toBe('unpaired_phone')
  })
  it('KNOWN GAP: wrong-code guesses are not rate limited', () => {
    const p = new PhonePairing()
    const { code } = p.begin('touch')
    let refused = 0
    for (let i = 0; i < 500; i++) { const g = String(i).padStart(6, '0'); if (g !== code && !p.offer('evil', 'pubE', g).ok) refused++ }
    // The real code still works after 500 bad guesses: no lockout.
    expect(p.offer('p1', 'pub1', code).ok).toBe(true)
    expect(refused).toBeGreaterThan(490)
  })
})

describe('Shield F8: send Ask content', () => {
  const o = () => ({ ...KIND('gmail.send'), ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'], isSend: true })
  it('missing recipient refuses before any prompt', async () => {
    let called = 0
    for (const send of [undefined, { recipient: '', message: 'hi' }, { recipient: '   ', message: 'hi' }]) {
      await expect(ask(T, 'Send an email', null, () => { called++; return true }, { ...o(), send: send as never })).rejects.toThrow(ApprovalDenied)
    }
    expect(called).toBe(0)
  })
  it('prompt shows recipient and first line; both bound into the digest', async () => {
    let prompt = ''; const seen: AskRequest[] = []
    const fn: AnswerFn = (_c, p, q) => { prompt = p; seen.push(q!); return { id: q!.id, digest8: q!.digest8, approved: true } }
    await ask(T, 'Send an email', null, fn, { ...o(), send: { recipient: 'a@x.com', message: '\n  Hello Bob  \nsecret line 2' } })
    expect(prompt).toContain('a@x.com'); expect(prompt).toContain('"Hello Bob"')
    await ask(T, 'Send an email', null, fn, { ...o(), send: { recipient: 'b@x.com', message: '\n  Hello Bob  \nsecret line 2' } })
    await ask(T, 'Send an email', null, fn, { ...o(), send: { recipient: 'a@x.com', message: 'Hello Eve' } })
    expect(new Set(seen.map((s) => s.digest8)).size).toBe(3)
  })
  it('KNOWN GAP: an empty or whitespace-only message is accepted and shows an empty first line', async () => {
    let prompt = ''
    const r = await ask(T, 'Send an email', null, (_c, p, q) => { prompt = p; return { id: q!.id, digest8: q!.digest8, approved: true } }, { ...o(), send: { recipient: 'a@x.com', message: '   \n ' } })
    expect(r.approved).toBe(true)
    expect(prompt).toContain('""')
  })
  it('KNOWN GAP: a send passed without isSend still runs, and without send details no recipient is shown', async () => {
    let prompt = ''
    const r = await ask(T, 'Send an email', null, (_c, p, q) => { prompt = p; return { id: q!.id, digest8: q!.digest8, approved: true } }, { ...KIND('gmail.send'), ledger: new AskLedger(), available: ['touch'] })
    expect(r.approved).toBe(true)
    expect(prompt).toBe('ASK: Send an email')
  })
})
