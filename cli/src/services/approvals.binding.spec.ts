import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
const MIC = { speaking: () => {} }
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, CHALLENGE_WORDS, actionDigest8, ask as askProd, drawChallenge,
  PhonePairing, openJournal, transcriptMatches,
  type AskAnswer, type AskChannel, type AskRequest, type ApprovalTemplate,
} from './approvals.js'

/** Production defaults for these tests: manifest present (tool unknown, so write) and a window. */
const ask: typeof askProd = (t, a, p, f, o = {}) => askProd(t, a, p, f, { kind: { manifest: [], tool: a }, window: new ApprovalWindow(), agentId: 'agent', ...o })
/** Pair through the full F6 flow: device touch, phone offers code + key, device touch confirms the match. */
function complete(p: PhonePairing, id: string, code: string, origin?: { shared?: boolean }): boolean {
  const o = p.offer(id, `pub-${id}`, code, origin)
  return o.ok && p.confirm(id, 'touch', true)
}

const BK: ApprovalTemplate = { permissions: { auto: ['Read the ledger'], ask: ['Send an invoice'], never: ['Move money out'] } }
const RG: ApprovalTemplate = { permissions: { locked_ask: ['Brakes step'] } }

function clock(t = 1_000_000) {
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
function good(req: AskRequest, extra: Partial<AskAnswer> = {}): AskAnswer {
  return { id: req.id, digest8: req.digest8, approved: true, transcript: req.challenge ? `yes ${req.challenge}` : undefined, from: { phoneId: 'phone-1' }, ...extra }
}

describe('F2 digest8', () => {
  it('is 8 hex, stable, and changes with action or amount', () => {
    const d = actionDigest8('Send an invoice', { amountMinor: 100 })
    expect(d).toMatch(/^[0-9a-f]{8}$/)
    expect(actionDigest8('Send an invoice', { amountMinor: 100 })).toBe(d)
    expect(actionDigest8('Send an invoice', { amountMinor: 101 })).not.toBe(d)
    expect(actionDigest8('Send an invoice ')).not.toBe(actionDigest8('Send an invoice'))
    expect(actionDigest8('a', { recipient: 'x' })).not.toBe(actionDigest8('a', { recipient: 'y' }))
    expect(actionDigest8('a', { b: 1, a: 2 })).toBe(actionDigest8('a', { a: 2, b: 1 }))
    expect(actionDigest8('a', { to: ['x', 'y'] })).not.toBe(actionDigest8('a', { to: ['y', 'x'] }))
    expect(actionDigest8('a', { f: () => 1, n: null })).toBe(actionDigest8('a', { f: () => 2, n: null }))
    expect(actionDigest8('a', { u: undefined })).toBe(actionDigest8('a'))
  })
})

describe('F2 spoken challenge', () => {
  it('two distinct words from the list, not digits', () => {
    for (let i = 0; i < 200; i++) {
      const [a, b] = drawChallenge().split(' ')
      expect(CHALLENGE_WORDS).toContain(a)
      expect(CHALLENGE_WORDS).toContain(b)
      expect(a).not.toBe(b)
    }
    expect(CHALLENGE_WORDS.length).toBeGreaterThanOrEqual(64)
    expect(CHALLENGE_WORDS.every((w) => /^[a-z]+$/.test(w))).toBe(true)
    expect(new Set(CHALLENGE_WORDS).size).toBe(CHALLENGE_WORDS.length)
  })
  it('uses the injected random source', () => {
    let n = 0
    expect(drawChallenge(() => n++)).toBe(`${CHALLENGE_WORDS[0]} ${CHALLENGE_WORDS[1]}`)
  })
  it('re-draws when the second word repeats the first', () => {
    const seq = [3, 3, 3, 5]
    expect(drawChallenge(() => seq.shift()!)).toBe(`${CHALLENGE_WORDS[3]} ${CHALLENGE_WORDS[5]}`)
  })
  it('transcript must contain both words, adjacent, in order', () => {
    expect(transcriptMatches('maple river', 'Yes, Maple River!')).toBe(true)
    expect(transcriptMatches('maple river', 'approve maple   river please')).toBe(true)
    expect(transcriptMatches('maple river', 'river maple')).toBe(false)
    expect(transcriptMatches('maple river', 'maple big river')).toBe(false)
    expect(transcriptMatches('maple river', 'yes')).toBe(false)
    expect(transcriptMatches('maple river', undefined)).toBe(false)
    expect(transcriptMatches('maple river', 'maplerivers')).toBe(false)
  })
})

describe('F2 AskLedger', () => {
  it('opens a request with id, digest8, expiry, and a challenge only for voice', () => {
    const c = clock()
    const l = new AskLedger({ now: c.now, ttlMs: 1000 })
    const v = l.open({ action: 'Send an invoice', tier: 'ask', channel: 'voice', amountMinor: 100 })
    expect(v.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(v.digest8).toBe(actionDigest8('Send an invoice', { amountMinor: 100, currency: 'USD' }))
    expect(v.expiresAt).toBe(1_001_000)
    expect(v.challenge?.split(' ')).toHaveLength(2)
    const t = l.open({ action: 'Send an invoice', tier: 'ask', channel: 'touch' })
    expect(t.challenge).toBeUndefined()
    expect(t.id).not.toBe(v.id)
    expect(l.pending()).toBe(2)
  })
  it('accepts a matching answer once', () => {
    const l = new AskLedger()
    const req = l.open({ action: 'a', tier: 'ask', channel: 'voice' })
    expect(l.settle(good(req))).toEqual({ ok: true })
    expect(l.settle(good(req))).toEqual({ ok: false, reason: 'replayed' })
    expect(l.pending()).toBe(0)
  })
  it('rejects unknown id, mismatched digest, expired, wrong challenge', () => {
    const c = clock()
    const l = new AskLedger({ now: c.now, ttlMs: 1000 })
    const r1 = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(l.settle({ ...good(r1), id: 'nope' })).toEqual({ ok: false, reason: 'unknown_id' })
    expect(l.settle({ ...good(r1), digest8: '00000000' })).toEqual({ ok: false, reason: 'digest_mismatch' })
    expect(l.settle(good(r1))).toEqual({ ok: false, reason: 'replayed' })
    const r2 = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    c.advance(999)
    expect(l.settle(good(r2))).toEqual({ ok: true })
    const r3 = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    c.advance(1001)
    expect(l.settle(good(r3))).toEqual({ ok: false, reason: 'expired' })
    const r4 = l.open({ action: 'a', tier: 'ask', channel: 'voice' })
    expect(l.settle(good(r4, { transcript: 'yes please' }))).toEqual({ ok: false, reason: 'challenge_mismatch' })
    const r5 = l.open({ action: 'a', tier: 'ask', channel: 'voice' })
    expect(l.settle(good(r5, { transcript: undefined }))).toEqual({ ok: false, reason: 'challenge_mismatch' })
  })
  it('an answer for one request cannot release another', () => {
    const l = new AskLedger()
    const a = l.open({ action: 'Pay $10', tier: 'ask', channel: 'touch' })
    const b = l.open({ action: 'Pay $900', tier: 'ask', channel: 'touch' })
    expect(l.settle({ ...good(a), id: b.id })).toEqual({ ok: false, reason: 'digest_mismatch' })
    expect(l.settle(good(a))).toEqual({ ok: true })
  })
  it('denial settles ok but is not approval; malformed answers rejected', () => {
    const l = new AskLedger()
    const r = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(l.settle(good(r, { approved: false }))).toEqual({ ok: true })
    for (const bad of [null, undefined, 'yes', true, 1, {}]) expect(l.settle(bad as never)).toEqual({ ok: false, reason: 'malformed' })
  })
  it('calls the verifier after built-in checks and rejects when it says no', () => {
    const seen: string[] = []
    const l = new AskLedger({ verifier: (req, ans) => { seen.push(req.id + ans.id); return ans.signature === 'ok' } })
    const r = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(l.settle({ ...good(r), digest8: 'bad' })).toEqual({ ok: false, reason: 'digest_mismatch' })
    expect(seen).toEqual([])
    const r2 = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(l.settle(good(r2, { signature: 'no' }))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(seen).toEqual([r2.id + r2.id])
    const r3 = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(l.settle(good(r3, { signature: 'ok' }))).toEqual({ ok: true })
  })
  it('a throwing verifier rejects', () => {
    const l = new AskLedger({ verifier: () => { throw new Error('x') } })
    const r = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(l.settle(good(r))).toEqual({ ok: false, reason: 'verifier_rejected' })
  })
  it('drops expired requests from pending', () => {
    const c = clock()
    const l = new AskLedger({ now: c.now, ttlMs: 10 })
    l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    c.advance(11)
    expect(l.pending()).toBe(0)
  })
})

describe('F2 ask with a ledger', () => {
  it('voice Ask carries the challenge in the prompt and approves with a matching transcript', async () => {
    const l = new AskLedger()
    const seen: [AskChannel, string, AskRequest][] = []
    const r = await ask(BK, 'Send an invoice', null, (ch, p, req) => { seen.push([ch, p, req!]); return good(req!) }, { mic: MIC, ledger: l })
    expect(r).toMatchObject({ approved: true, channel: 'voice', tier: 'ask', reason: undefined })
    const [, prompt, req] = seen[0]!
    expect(prompt).toBe(`ASK: Send an invoice (running total today: 1 actions, $0.00). Say "${req.challenge}" to approve.`)
    expect(req.digest8).toBe(actionDigest8('Send an invoice', {}))
  })
  it('touch Ask needs no challenge', async () => {
    const r = await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), { ledger: new AskLedger() })
    expect(r.approved).toBe(true)
    expect(r.channel).toBe('touch')
  })
  it('bare true is not accepted when bound', async () => {
    const r = await ask(BK, 'Send an invoice', null, () => true, { mic: MIC, ledger: new AskLedger() })
    expect(r).toMatchObject({ approved: false, channel: 'voice', tier: 'ask', reason: 'malformed' })
  })
  it('replay of a previous answer against a new Ask is rejected', async () => {
    const l = new AskLedger()
    let captured: AskAnswer | undefined
    await ask(BK, 'Send an invoice', null, (_c, _p, req) => (captured = good(req!)), { mic: MIC, ledger: l })
    const r = await ask(BK, 'Send an invoice', null, () => captured, { mic: MIC, ledger: l })
    expect(r.approved).toBe(false)
    expect(r.reason).toBe('replayed')
  })
  it('expired answers are rejected and not recorded in the window', async () => {
    const c = clock()
    const l = new AskLedger({ now: c.now, ttlMs: 100 })
    const w = new ApprovalWindow({ now: c.now })
    const r = await ask(BK, 'Send an invoice', null, (_c, _p, req) => { c.advance(101); return good(req!) }, { mic: MIC, ledger: l, window: w, agentId: 'a', amountMinor: 100 })
    expect(r).toMatchObject({ approved: false, channel: 'voice', tier: 'ask', reason: 'expired' })
    expect(w.totals('a').count).toBe(0)
  })
  it('a verifier without a ledger fails closed', async () => {
    await expect(ask(BK, 'Send an invoice', null, () => true, { verifier: () => true })).rejects.toThrow(ApprovalDenied)
  })
  it('passes details into the digest', async () => {
    let d = ''
    await ask(BK, 'Send an invoice', null, (_c, _p, req) => { d = req!.digest8; return good(req!) }, { mic: MIC, ledger: new AskLedger(), amountMinor: 700, details: { recipient: 'x' } })
    expect(d).toBe(actionDigest8('Send an invoice', { amountMinor: 700, currency: 'USD', recipient: 'x' }))
  })
  it('calls the Volt mic guard around a voice prompt (hook only)', async () => {
    const events: string[] = []
    const mic = { speaking: (on: boolean) => events.push(on ? 'mute' : 'unmute') }
    await ask(BK, 'Send an invoice', null, (_c, _p, req) => { events.push('answer'); return good(req!) }, { ledger: new AskLedger(), mic })
    expect(events).toEqual(['mute', 'answer', 'unmute'])
    events.length = 0
    await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), { ledger: new AskLedger(), mic })
    expect(events).toEqual([])
  })
  it('unmutes even if the answer throws', async () => {
    const events: string[] = []
    const mic = { speaking: (on: boolean) => events.push(String(on)) }
    await expect(ask(BK, 'Send an invoice', null, () => { throw new Error('x') }, { ledger: new AskLedger(), mic })).rejects.toThrow('x')
    expect(events).toEqual(['true', 'false'])
  })
})

describe('F2 mic guard is required for voice in bound mode', () => {
  it('without a mic guard voice is skipped, voice-only fails closed', async () => {
    const r = await ask(BK, 'Send an invoice', null, (_c, _p, req) => good(req!), { ledger: new AskLedger() })
    expect(r.channel).toBe('touch')
    const calls: unknown[] = []
    const r2 = await ask(BK, 'Send an invoice', null, (c) => calls.push(c), { ledger: new AskLedger(), available: ['voice'] })
    expect(r2).toEqual({ approved: false, channel: null, tier: 'ask' })
    expect(calls).toEqual([])
  })
})

describe('F6 minimum: phone pairing', () => {
  it('begin needs touch on the device', () => {
    const p = new PhonePairing()
    expect(() => p.begin('voice')).toThrow(ApprovalDenied)
    expect(() => p.begin('phone')).toThrow(ApprovalDenied)
    expect(p.begin('touch').code).toMatch(/^\d{6}$/)
  })
  it('code is single use and expires', () => {
    const c = clock()
    const p = new PhonePairing({ now: c.now, ttlMs: 100 })
    const { code, expiresAt } = p.begin('touch')
    expect(expiresAt).toBe(1_000_100)
    expect(complete(p, '', code)).toBe(false)
    const second = p.begin('touch').code
    expect(complete(p, 'phone-1', second)).toBe(true)
    expect(complete(p, 'phone-2', second)).toBe(false)
    expect(complete(p, 'phone-2', 'nope')).toBe(false)
    const late = p.begin('touch').code
    c.advance(101)
    expect(complete(p, 'phone-3', late)).toBe(false)
    expect(p.isPaired('phone-1')).toBe(true)
    expect(p.isPaired('phone-3')).toBe(false)
    expect(p.isPaired()).toBe(true)
    p.unpair('phone-1')
    expect(p.isPaired()).toBe(false)
  })
  it('bound mode: phone answers only once a phone is paired', async () => {
    const pairing = new PhonePairing()
    const opts = { ledger: new AskLedger(), pairing, available: ['phone'] }
    expect((await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), opts)).channel).toBeNull()
    expect((await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), { ledger: new AskLedger(), available: ['phone'] })).channel).toBeNull()
    complete(pairing, 'phone-1', pairing.begin('touch').code)
    expect(await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), opts)).toMatchObject({ approved: true, channel: 'phone' })
    expect((await ask(RG, 'Brakes step', null, (_c, _p, req) => good(req!), { ...opts, isPaired: () => false })).channel).toBeNull()
  })
})

describe('F8: a send Ask shows the recipient and first line', () => {
  it('renders recipient, first non-empty line and amount, and binds them into the digest', async () => {
    let prompt = ''
    let digest = ''
    const message = '\n  Hi Dana, your invoice is attached.  \nSecond line'
    await ask(BK, 'Send an invoice', null, (_c, p, req) => { prompt = p; digest = req!.digest8; return good(req!) },
      { ledger: new AskLedger(), isSend: true, send: { recipient: 'dana@example.com', message }, amountMinor: 1250 })
    expect(prompt).toBe('ASK: Send an invoice to dana@example.com: "Hi Dana, your invoice is attached." $12.50 (running total today: 1 actions, $12.50)')
    const other = await new Promise<string>((res) => { void ask(BK, 'Send an invoice', null, (_c, _p, req) => { res(req!.digest8); return good(req!) },
      { ledger: new AskLedger(), isSend: true, send: { recipient: 'eve@example.com', message }, amountMinor: 1250 }) })
    expect(other).not.toBe(digest)
  })
  it('long first lines are cut, empty messages show empty quotes', async () => {
    const seen: string[] = []
    await ask(BK, 'Send an invoice', null, (_c, p) => { seen.push(p); return true }, { reference: true, send: { recipient: 'r', message: 'x'.repeat(100) } })
    await ask(BK, 'Send an invoice', null, (_c, p) => { seen.push(p); return true }, { reference: true, send: { recipient: 'r', message: '' } })
    expect(seen[0]).toBe(`ASK: Send an invoice to r: "${'x'.repeat(79)}…" (running total today: 1 actions, $0.00)`)
    expect(seen[1]).toBe('ASK: Send an invoice to r: "" (running total today: 1 actions, $0.00)')
  })
  it('a send Ask without recipient or message is refused before prompting', async () => {
    const calls: unknown[] = []
    for (const send of [undefined, { recipient: ' ', message: 'm' }, { recipient: 'r' } as never]) {
      await expect(ask(BK, 'Send an invoice', null, (c) => calls.push(c), { isSend: true, send })).rejects.toThrow(ApprovalDenied)
    }
    expect(calls).toEqual([])
  })
})

describe('F5 + F2 journal survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'approvals-'))
  it('round-trips totals, pending Asks, spent ids and pairings with a 0600 file', () => {
    const c = clock()
    const p = join(dir, 'sub', 'journal.json')
    const j = openJournal(p, { now: c.now })
    expect(j.recovered).toBe(false)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    j.window.record('a', { amountMinor: 4500 })
    j.window.record('b', { count: 3 })
    const pending = j.ledger.open({ action: 'a', tier: 'ask', channel: 'voice' })
    const spentReq = j.ledger.open({ action: 'a', tier: 'ask', channel: 'touch' })
    j.ledger.settle(good(spentReq))
    complete(j.pairing, 'phone-1', j.pairing.begin('touch').code)

    const j2 = openJournal(p, { now: c.now })
    expect(j2.window.totals('a')).toEqual({ count: 1, amountMinor: 4500 })
    expect(j2.window.totals('b')).toEqual({ count: 3, amountMinor: 0 })
    expect(j2.window.wouldExceed('a', { amountMinor: 1000 }).voiceAllowed).toBe(false)
    expect(j2.ledger.pending()).toBe(1)
    expect(j2.ledger.settle(good(spentReq))).toEqual({ ok: false, reason: 'replayed' })
    expect(j2.ledger.settle(good(pending))).toEqual({ ok: true })
    expect(j2.pairing.isPaired('phone-1')).toBe(true)
    j2.pairing.unpair('phone-1')
    expect(openJournal(p, { now: c.now }).pairing.isPaired()).toBe(false)
  })
  it('expired Asks and spent ids age out', () => {
    const c = clock()
    const j = openJournal(join(dir, 'age.json'), { now: c.now, ttlMs: 10, windowMs: 10 })
    const r = j.ledger.open({ action: 'a', tier: 'ask', channel: 'touch' })
    j.window.record('a')
    c.advance(11)
    expect(j.ledger.settle(good(r))).toEqual({ ok: false, reason: 'expired' })
    expect(j.ledger.settle(good(r))).toEqual({ ok: false, reason: 'replayed' })
    const r2 = j.ledger.open({ action: 'a', tier: 'ask', channel: 'touch' })
    c.advance(11)
    expect(j.ledger.pending()).toBe(0)
    expect(j.ledger.settle(good(r2))).toEqual({ ok: false, reason: 'replayed' })
    c.advance(24 * 3600 * 1000)
    expect(j.ledger.settle(good(r))).toEqual({ ok: false, reason: 'unknown_id' })
    j.save()
    const saved = JSON.parse(readFileSync(join(dir, 'age.json'), 'utf8'))
    expect(saved.ledger.open).toEqual([])
    expect(saved.window.entries).toEqual({})
  })
  it('a corrupt or tampered file fails closed: voice off for one window, nothing pending, no phone', () => {
    const c = clock()
    const base = { v: 1, window: { lockedUntil: 0, entries: {} }, ledger: { open: [], spent: [] }, pairing: { phones: [] } }
    const bodies = [
      '{not json', 'null', JSON.stringify({ v: 9 }),
      JSON.stringify({ ...base, window: null }),
      JSON.stringify({ ...base, window: { lockedUntil: 0, entries: { a: [{ at: 'x', count: 1, amountMinor: 1 }] } } }),
      JSON.stringify({ ...base, window: { lockedUntil: 0, entries: { a: [{ at: 1, count: 1, amountMinor: -5 }] } } }),
      JSON.stringify({ ...base, window: { lockedUntil: 0, entries: { a: 'x' } } }),
      JSON.stringify({ ...base, ledger: { open: [{ id: 'x', digest8: 'zz', expiresAt: 1, channel: 'voice', tier: 'ask' }], spent: [] } }),
      JSON.stringify({ ...base, ledger: { open: [{ id: 'x', digest8: '0011aabb', expiresAt: 1, channel: 'desktop', tier: 'ask' }], spent: [] } }),
      JSON.stringify({ ...base, ledger: { open: [], spent: [[1, 2]] } }),
      JSON.stringify({ ...base, ledger: null }),
      JSON.stringify({ ...base, pairing: { phones: [1] } }),
      JSON.stringify({ ...base, pairing: null }),
      JSON.stringify({ ...base, pairing: { phones: [], log: 'x' } }),
      JSON.stringify({ ...base, pairing: { phones: [], log: [{ at: 1, event: 'hack', phoneId: 'p' }] } }),
      JSON.stringify({ ...base, pairing: { phones: [], log: [null] } }),
    ]
    for (const body of bodies) {
      const p = join(dir, 'bad.json')
      writeFileSync(p, body)
      const j = openJournal(p, { now: c.now, windowMs: 1000 })
      expect(j.recovered, body).toBe(true)
      expect(j.window.wouldExceed('anyone').voiceAllowed).toBe(false)
      expect(j.ledger.pending()).toBe(0)
      expect(j.pairing.isPaired()).toBe(false)
      c.advance(1001)
      expect(j.window.wouldExceed('anyone').voiceAllowed).toBe(true)
    }
    const ok = join(dir, 'ok.json')
    writeFileSync(ok, JSON.stringify({ ...base, ledger: { open: [{ id: 'x', digest8: '0011aabb', openedAt: 0, expiresAt: 1, channel: 'voice', tier: 'ask', challenge: 'maple river', amountMinor: 5, currency: 'USD', action: 'a', agentId: 'g' }], spent: [] } }))
    expect(openJournal(ok).recovered).toBe(false)
  })
})
