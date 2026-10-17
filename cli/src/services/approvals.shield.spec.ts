/**
 * Shield adversarial verification of the Ildra M1 blockers (security/FINDINGS.md F2, F5, F6, F8).
 * Written by Shield, independent of Build's specs. Each test is an attack that must fail.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, AskPaneGuard, PhonePairing, actionDigest8, answerMcpElicitation, ask,
  defaultMarkerPath, openJournal, phoneElicitationPress, sharedOriginFromPeers,
  askKindFor, isSendTool, stampManifest, toDeviceMessage,
  type AskAnswer, type AskRequest, type ApprovalTemplate, type AnswerFn,
} from './approvals.js'
import { randomBytes as aidBytes } from 'node:crypto'
/** DECISIONS ad47477: every answer carries a fresh answerId (32 lowercase hex). */
const aid = (): string => aidBytes(16).toString('hex')

/** Shield pilot review A1: a device (touch) approval is a hold of 1.5 s or more; phone answers ignore it. */
const HOLD = 2000

const T: ApprovalTemplate = { permissions: { ask: ['Send an email', 'Pay a bill'], locked_ask: ['Brakes step'] } }
const MIC = { speaking: () => {} }
// Shield pilot review (a): only an explicit send:false keeps a tool out of the send checks.
const KIND = (tool: string) => ({ kind: { manifest: stampManifest([{ name: tool, send: false }], 'bridge'), tool } })

function clock(t = 10_000_000) {
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
function dir() { return mkdtempSync(join(tmpdir(), 'shield-')) }
function answerWith(fn: (req: AskRequest) => Partial<AskAnswer> | null): AnswerFn {
  return (_c, _p, req) => {
    const extra = fn(req!)
    return extra === null ? true : { id: req!.id, digest8: req!.digest8, answerId: aid(), approved: true, holdMs: HOLD, transcript: req!.challenge ? `yes ${req!.challenge}` : undefined, from: { phoneId: 'p1' }, ...extra }
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
    const a: AskAnswer = { id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: HOLD }
    expect(l.settle(a)).toEqual({ ok: true })
    expect(l.settle(a)).toEqual({ ok: false, reason: 'replayed' })
  })
  it('replay survives a daemon restart (spent ids persisted)', () => {
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    const req = j1.ledger.open({ action: 'Send an email', tier: 'ask', channel: 'touch' })
    const a: AskAnswer = { id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: HOLD }
    expect(j1.ledger.settle(a).ok).toBe(true)
    const j2 = openJournal(f, { now: c.now })
    expect(j2.ledger.settle(a)).toEqual({ ok: false, reason: 'replayed' })
  })
  it('answer at or after expiry is rejected, money 1 h', () => {
    const c = clock(); const l = new AskLedger({ now: c.now })
    const req = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 100 })
    expect(req.expiresAt - req.openedAt).toBe(3_600_000)
    c.advance(3_600_000)
    expect(l.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: HOLD })).toEqual({ ok: false, reason: 'expired' })
  })
  it('answer for a different digest is rejected and spends the request', () => {
    const c = clock(); const l = new AskLedger({ now: c.now })
    const req = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 100 })
    const other = actionDigest8('Pay a bill', { amountMinor: 999999, currency: 'USD' })
    expect(l.settle({ id: req.id, digest8: other, answerId: aid(), approved: true, holdMs: HOLD })).toEqual({ ok: false, reason: 'digest_mismatch' })
    expect(l.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: HOLD })).toEqual({ ok: false, reason: 'replayed' })
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
    // Since the pilot review (A1) money Asks are phone-only, so the cap is checked on the persisted window.
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    const o = { ...KIND('x'), ledger: j1.ledger, window: j1.window, agentId: 'a', mic: MIC, pairing: pairedPhone(c.now), available: ['voice', 'touch', 'phone'] }
    const r1 = await ask(T, 'Pay a bill', null, answerWith(() => ({})), { ...o, amountMinor: 4500 })
    expect(r1.channel).toBe('phone'); expect(r1.approved).toBe(true)
    expect(j1.window.wouldExceed('a', { amountMinor: 500 }).voiceAllowed).toBe(true)
    const j2 = openJournal(f, { now: c.now })
    expect(j2.window.wouldExceed('a', { amountMinor: 501 }).voiceAllowed).toBe(false)
    expect(j2.window.totals('a').amountMinor).toBe(4500)
    const r2 = await ask(T, 'Pay a bill', null, answerWith(() => ({})), { ...o, ledger: j2.ledger, window: j2.window, amountMinor: 4500 })
    expect(r2.channel).toBe('phone')
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
  it('FIXED (was KNOWN GAP): deleting the journal after install fails closed', () => {
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    j1.window.record('a', { amountMinor: 5000 })
    unlinkSync(f)
    const j2 = openJournal(f, { now: c.now })
    expect(j2.recovered).toBe(true)
    expect(j2.window.wouldExceed('a', { amountMinor: 100 }).voiceAllowed).toBe(false)
    expect(j2.window.wouldExceed('fresh-agent').voiceAllowed).toBe(false)
    c.advance(24 * 3600 * 1000)
    expect(j2.window.wouldExceed('fresh-agent').voiceAllowed).toBe(true)
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
  it('FIXED (was KNOWN GAP): 5 wrong codes burn every open code until a new device touch', () => {
    const p = new PhonePairing()
    const { code } = p.begin('touch')
    const other = p.begin('touch').code
    const wrong = ['000000', '111111', '222222', '333333', '444444', '555555'].filter((g) => g !== code && g !== other).slice(0, 5)
    for (const g of wrong.slice(0, 4)) expect(p.offer('evil', 'pubE', g)).toEqual({ ok: false, reason: 'unknown_code' })
    expect(p.offer('evil', 'pubE', wrong[4]!)).toEqual({ ok: false, reason: 'locked_out' })
    expect(p.lockedOut).toBe(true)
    expect(p.offer('p1', 'pub1', code)).toEqual({ ok: false, reason: 'locked_out' })
    expect(p.offer('p1', 'pub1', other)).toEqual({ ok: false, reason: 'locked_out' })
    const fresh = p.begin('touch')
    expect(p.lockedOut).toBe(false)
    expect(p.offer('p1', 'pub1', code)).toEqual({ ok: false, reason: 'unknown_code' })
    expect(p.offer('p1', 'pub1', fresh.code).ok).toBe(true)
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
    const fn: AnswerFn = (_c, p, q) => { prompt = p; seen.push(q!); return { id: q!.id, digest8: q!.digest8, answerId: aid(), approved: true, holdMs: HOLD } }
    await ask(T, 'Send an email', null, fn, { ...o(), send: { recipient: 'a@x.com', message: '\n  Hello Bob  \nsecret line 2' } })
    expect(prompt).toContain('a@x.com'); expect(prompt).toContain('"Hello Bob"')
    await ask(T, 'Send an email', null, fn, { ...o(), send: { recipient: 'b@x.com', message: '\n  Hello Bob  \nsecret line 2' } })
    await ask(T, 'Send an email', null, fn, { ...o(), send: { recipient: 'a@x.com', message: 'Hello Eve' } })
    expect(new Set(seen.map((s) => s.digest8)).size).toBe(3)
  })
  it('FIXED (was KNOWN GAP): an empty or whitespace-only message is refused before any prompt', async () => {
    let called = 0
    for (const message of ['', '   \n ', '\n\t\n']) {
      await expect(ask(T, 'Send an email', null, () => { called++; return true }, { ...o(), send: { recipient: 'a@x.com', message } })).rejects.toThrow(/first line/)
    }
    expect(called).toBe(0)
  })
  it('FIXED (was KNOWN GAP): the manifest marks the send; without isSend or send details it is refused', async () => {
    let called = 0
    const kind = { manifest: [{ name: 'gmail.send', send: true }], tool: 'gmail.send' }
    await expect(ask(T, 'Send an email', null, () => { called++; return true }, { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'] })).rejects.toThrow(ApprovalDenied)
    await expect(ask(T, 'Send an email', null, () => { called++; return true }, { kind, ledger: new AskLedger(), available: ['touch'], isSend: false, send: { recipient: 'a@x.com', message: 'hi' } })).rejects.toThrow(/window/)
    expect(called).toBe(0)
    let prompt = ''
    await ask(T, 'Send an email', null, (_c, p, q) => { prompt = p; return { id: q!.id, digest8: q!.digest8, answerId: aid(), approved: true, holdMs: HOLD } },
      { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'], isSend: false, send: { recipient: 'a@x.com', message: 'hi' } })
    expect(prompt).toContain('to a@x.com: "hi"')
  })
})

// ---- Shield round 3 (Oct 16): adversarial checks on f6a011a01 and 1845a5c90 ----

describe('Shield R3 F5: install marker placement', () => {
  it('marker given inside the journal folder is refused', () => {
    const d = dir()
    expect(() => openJournal(join(d, 'j.json'), { markerPath: join(d, 'm.installed') })).toThrow(ApprovalDenied)
    expect(() => openJournal(join(d, 'j.json'), { markerPath: join(d, 'sub', 'deeper', 'm.installed') })).toThrow(ApprovalDenied)
  })
  it('path traversal into the journal folder is refused', () => {
    const d = dir(); const j = join(d, 'state', 'j.json'); mkdirSync(join(d, 'state'))
    expect(() => openJournal(j, { markerPath: join(d, 'elsewhere', '..', 'state', 'm.installed') })).toThrow(ApprovalDenied)
  })
  it('ILDRA_MARKER_DIR pointing inside the journal folder is refused', () => {
    const d = dir(); const old = process.env.ILDRA_MARKER_DIR
    try {
      process.env.ILDRA_MARKER_DIR = join(d, 'markers')
      expect(defaultMarkerPath(join(d, 'j.json')).startsWith(join(d, 'markers'))).toBe(true)
      expect(() => openJournal(join(d, 'j.json'))).toThrow(ApprovalDenied)
    } finally {
      if (old === undefined) delete process.env.ILDRA_MARKER_DIR; else process.env.ILDRA_MARKER_DIR = old
    }
  })
  it('FIXED (was REOPEN, R3-1): a symlinked marker folder that points into the journal folder is refused', () => {
    const d = dir(); const jdir = join(d, 'state'); mkdirSync(jdir)
    symlinkSync(jdir, join(d, 'link'))
    // realpath of the marker's nearest existing parent sees that link/ is state/.
    expect(() => openJournal(join(jdir, 'j.json'), { markerPath: join(d, 'link', 'm.installed') })).toThrow(ApprovalDenied)
    expect(() => openJournal(join(jdir, 'j.json'), { markerPath: join(d, 'link', 'not', 'yet', 'm.installed') })).toThrow(ApprovalDenied)
  })
  it('RESIDUAL: deleting both marker and journal looks like a fresh install (totals reset)', () => {
    const c = clock(); const d = dir(); const j = join(d, 'j', 'j.json'); const m = join(d, 'm', 'x.installed')
    const j1 = openJournal(j, { now: c.now, markerPath: m })
    j1.window.record('a', { amountMinor: 5000 })
    unlinkSync(j); unlinkSync(m)
    const j2 = openJournal(j, { now: c.now, markerPath: m })
    expect(j2.recovered).toBe(false)
    expect(j2.window.wouldExceed('a', { amountMinor: 100 }).voiceAllowed).toBe(true)
  })
})

describe('Shield R3 pilot A1: device answers', () => {
  const ledgerTouch = (c = clock()) => { const l = new AskLedger({ now: c.now }); return { l, req: l.open({ action: 'Send an email', tier: 'ask', channel: 'touch' }) } }
  it('touch approval with no holdMs, 1499, NaN, Infinity or a string is too short', () => {
    for (const holdMs of [undefined, 1499, Number.NaN, Number.POSITIVE_INFINITY, '2000' as unknown as number, -5]) {
      const { l, req } = ledgerTouch()
      expect(l.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs })).toEqual({ ok: false, reason: 'hold_too_short' })
    }
  })
  it('REOPEN (D5 b): holdMs is whatever the answer claims; any sender on the device channel can say 1500', () => {
    const { l, req } = ledgerTouch()
    expect(l.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 1500 })).toEqual({ ok: true })
  })
  it('device answer with a different digest8 is rejected even with a long hold', () => {
    const { l, req } = ledgerTouch()
    const other = actionDigest8('Send an email', { recipient: 'evil@x.com' })
    expect(l.settle({ id: req.id, digest8: other, answerId: aid(), approved: true, holdMs: 5000 })).toEqual({ ok: false, reason: 'digest_mismatch' })
  })
  it('device answer with no digest8 is malformed', () => {
    const { l, req } = ledgerTouch()
    expect(l.settle({ id: req.id, approved: true, holdMs: 5000 } as unknown as AskAnswer)).toEqual({ ok: false, reason: 'malformed' })
  })
  it('money and locked_ask never open on touch or voice; fail closed with no paired phone', async () => {
    const l = new AskLedger()
    for (const ch of ['touch', 'voice'] as const) {
      expect(() => l.open({ action: 'Pay a bill', tier: 'ask', channel: ch, amountMinor: 1 })).toThrow(ApprovalDenied)
      expect(() => l.open({ action: 'Brakes step', tier: 'locked_ask', channel: ch })).toThrow(ApprovalDenied)
    }
    let called = 0
    const r = await ask(T, 'Brakes step', null, () => { called++; return true }, { ...KIND('x'), ledger: new AskLedger(), mic: MIC, available: ['voice', 'touch', 'phone'] })
    expect(r.approved).toBe(false); expect(r.channel).toBeNull(); expect(called).toBe(0)
  })
  it('phone unpaired mid-Ask: the answer that arrives after unpair is rejected', async () => {
    const c = clock(); const pairing = pairedPhone(c.now)
    const r = await ask(T, 'Pay a bill', null, answerWith(() => { pairing.unpair('p1'); return {} }),
      { ...KIND('x'), ledger: new AskLedger({ now: c.now }), window: new ApprovalWindow({ now: c.now }), agentId: 'a', pairing, amountMinor: 100, available: ['phone'] })
    expect(r.approved).toBe(false); expect(r.reason).toBe('unpaired_phone')
  })
  it('leftover money Ask opened on touch before the rule is spent on journal reload', () => {
    const c = clock(); const d = dir(); const f = join(d, 'j', 'j.json'); const m = join(d, 'm', 'x.installed')
    const j1 = openJournal(f, { now: c.now, markerPath: m })
    const req = j1.ledger.open({ action: 'Send an email', tier: 'ask', channel: 'touch' })
    j1.save()
    const body = JSON.parse(readFileSync(f, 'utf8'))
    body.ledger.open[0].amountMinor = 4000; body.ledger.open[0].currency = 'USD'
    writeFileSync(f, JSON.stringify(body))
    const j2 = openJournal(f, { now: c.now, markerPath: m })
    expect(j2.ledger.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 5000 })).toEqual({ ok: false, reason: 'replayed' })
  })
})

describe('Shield R3 F8 (a): send-ness', () => {
  it('a tool missing from the manifest, or with send not literally false, gets the send checks', async () => {
    for (const manifest of [[], [{ name: 'x' }], [{ name: 'x', send: 'false' }], [{ name: 'x', send: 0 }], null]) {
      await expect(ask(T, 'Send an email', null, () => true, { kind: { manifest: manifest as never, tool: 'x' }, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'] }))
        .rejects.toThrow(ApprovalDenied)
    }
  })
  it('FIXED (was NOTE, R3-3): send:false from a manifest that is not first-party or bridge-owned is ignored', async () => {
    let called = 0
    for (const entry of [{ name: 'evil.mail', send: false }, { name: 'evil.mail', send: false, owner: 'third_party' }, { name: 'evil.mail', send: false, owner: 'store:acme' }]) {
      await expect(ask(T, 'Send an email', null, () => { called++; return true },
        { kind: { manifest: [entry], tool: 'evil.mail' }, ledger: new AskLedger(), available: ['touch'] })).rejects.toThrow(ApprovalDenied)
    }
    expect(called).toBe(0)
  })
  it('phone Accept on an MCP dialog for an unlisted tool always declines', async () => {
    const c = clock(); const pairing = pairedPhone(c.now)
    let called = 0
    const out = await answerMcpElicitation(T, { server: 'srv', message: 'Proceed?', tool: 'unknown.tool' }, null,
      (_c, _p, q) => { called++; return { id: q!.id, digest8: q!.digest8, answerId: aid(), approved: true, from: { phoneId: 'p1' } } },
      { manifest: [], ledger: new AskLedger({ now: c.now }), window: new ApprovalWindow({ now: c.now }), agentId: 'a', pairing, available: ['phone'] })
    expect(out.action).toBe('decline'); expect(called).toBe(0)
    const out2 = await answerMcpElicitation(T, { server: 'srv', message: 'Proceed?' }, null, () => true, { manifest: [], ledger: new AskLedger(), pairing, available: ['phone'] })
    expect(out2.action).toBe('decline')
  })
})

describe('Shield R3 F12 and F13', () => {
  it('F12: shared:false from a gateway-shared machine is ignored; a throwing lookup counts as shared', () => {
    const c = clock(); const look = sharedOriginFromPeers([{ pub: 'SHAREDPUB' }])
    const mk = () => { const l = new AskLedger({ now: c.now }); return { l, req: l.open({ action: 'Send an email', tier: 'ask', channel: 'touch' }) } }
    let t = mk()
    expect(t.l.settle({ id: t.req.id, digest8: t.req.digest8, answerId: aid(), approved: true, holdMs: 2000, from: { machinePub: 'SHAREDPUB', shared: false } }, { isShared: look })).toEqual({ ok: false, reason: 'shared_machine' })
    t = mk()
    expect(t.l.settle({ id: t.req.id, digest8: t.req.digest8, answerId: aid(), approved: true, holdMs: 2000, from: { machinePub: 'OWN' } }, { isShared: () => { throw new Error('down') } })).toEqual({ ok: false, reason: 'shared_machine' })
    t = mk()
    expect(t.l.settle({ id: t.req.id, digest8: t.req.digest8, answerId: aid(), approved: true, holdMs: 2000, from: { machinePub: 'OWN' } }, { isShared: look })).toEqual({ ok: true })
  })
  it('F12: pairing from a gateway-shared machine is refused', () => {
    const p = new PhonePairing({ isShared: sharedOriginFromPeers([{ pub: 'S' }]) } as never)
    expect(() => p.begin('touch', { machinePub: 'S', shared: false } as never)).toThrow(ApprovalDenied)
  })
  it('F13: an Ildra Ask pane is never pressed, and a remote keystroke to it is blocked', async () => {
    const g = new AskPaneGuard(); g.open('pane', 'r1')
    let called = 0
    const out = await phoneElicitationPress(T, { paneId: 'pane', server: 's', message: 'ok?', tool: 't' }, null, () => { called++; return true },
      { manifest: [{ name: 't', send: false }], ledger: new AskLedger(), available: ['phone'], guard: g })
    expect(out.key).toBeNull(); expect(called).toBe(0)
    expect(g.filterInput('pane', 'remote')).toBe('block')
  })
})

// ---- Shield round 5 (Oct 17): final M1 checks on d4dd1a42e, 37f9ec49e, bf1c5b733 ----

describe('Shield R5 F5: marker folder overlap after realpath', () => {
  it('a symlink at the grandparent, or a deeper not-yet-created path through it, is refused', () => {
    const d = dir(); const jdir = join(d, 'a', 'b', 'state'); mkdirSync(jdir, { recursive: true })
    symlinkSync(join(d, 'a'), join(d, 'ga'))
    expect(() => openJournal(join(jdir, 'j.json'), { markerPath: join(d, 'ga', 'b', 'state', 'm.installed') })).toThrow(ApprovalDenied)
    expect(() => openJournal(join(jdir, 'j.json'), { markerPath: join(d, 'ga', 'b', 'state', 'x', 'y', 'm.installed') })).toThrow(ApprovalDenied)
  })
  it('the other direction: a journal folder that links inside the marker folder is refused', () => {
    const d = dir(); const mdir = join(d, 'markers'); mkdirSync(join(mdir, 'inner'), { recursive: true })
    symlinkSync(join(mdir, 'inner'), join(d, 'jlink'))
    expect(() => openJournal(join(d, 'jlink', 'j.json'), { markerPath: join(mdir, 'm.installed') })).toThrow(ApprovalDenied)
  })
  it('RESIDUAL: a folder created as a link into the journal folder after the check is followed (same-user race)', () => {
    const d = dir(); const jdir = join(d, 'state'); mkdirSync(jdir)
    const j = openJournal(join(jdir, 'j.json'), { markerPath: join(d, 'late', 'm.installed') })
    expect(j.recovered).toBe(false)
    // The check ran against d/ (nearest existing parent). Anyone who can make d/late a link can also delete both files,
    // so this is the same residual as "both deleted"; fixed only by a marker outside this user's reach (P7).
  })
})

describe('Shield R5 R3-3: who owns a manifest entry', () => {
  it('stampManifest overwrites any owner a third-party manifest claims', () => {
    const m = stampManifest([{ name: 'evil.mail', send: false, owner: 'bridge', safetyVerification: true }], 'third_party')
    expect(m[0]!.owner).toBe('third_party')
    expect(isSendTool(m, 'evil.mail')).toBe(true)
    expect(askKindFor({ permissions: { locked_ask: ['Brakes step'] } }, 'Brakes step', 'locked_ask', { manifest: m, tool: 'evil.mail' })).toBeUndefined()
  })
  // Flipped by Build (R5-2 fix). KIND above now goes through stampManifest(…, 'bridge'), the daemon's loader
  // stamp, since a raw owner:'bridge' is no longer believed (exactly what the first test below checks).
  it('FIXED R5-2: no daemon code calls stampManifest, so an unstamped entry that claims owner bridge is believed', () => {
    const raw = [{ name: 'evil.mail', send: false, owner: 'bridge', safetyVerification: true }]
    expect(isSendTool(raw, 'evil.mail')).toBe(true)
    expect(askKindFor({ permissions: { locked_ask: ['Brakes step'] } }, 'Brakes step', 'locked_ask', { manifest: raw, tool: 'evil.mail' })).toBeUndefined()
  })
  it('FIXED R5-2: a third-party tool with the same name as a first-party send:false tool inherits it (first match wins)', () => {
    const merged = [...stampManifest([{ name: 'notes.save', send: false }], 'first_party'), ...stampManifest([{ name: 'notes.save' }], 'third_party')]
    expect(isSendTool(merged, 'notes.save')).toBe(true)
  })
  it('safety_verification only on locked_ask; a stamped third-party entry never sets it', () => {
    const tp = stampManifest([{ name: 't', safetyVerification: true }], 'third_party')
    const br = stampManifest([{ name: 't', safetyVerification: true }], 'bridge')
    expect(askKindFor({ permissions: {} }, 'x', 'locked_ask', { manifest: tp, tool: 't' })).toBeUndefined()
    expect(askKindFor({ permissions: {} }, 'x', 'ask', { manifest: br, tool: 't' })).toBeUndefined()
    expect(askKindFor({ permissions: {} }, 'x', 'locked_ask', { manifest: br, tool: 't' })).toBe('safety_verification')
    const l = new AskLedger()
    expect(() => l.open({ action: 'x', tier: 'ask', channel: 'phone', kind: 'safety_verification' } as never)).toThrow(ApprovalDenied)
  })
})

describe('Shield R5 F8: Unicode in recipient and first line', () => {
  const o = () => ({ kind: { manifest: [{ name: 'gmail.send', send: true, owner: 'bridge' }], tool: 'gmail.send' }, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'] as const })
  const shown = async (recipient: string, message: string) => {
    let req: AskRequest | undefined; let prompt = ''
    const out = await ask(T, 'Send an email', null, (_c, p, q) => { prompt = p; req = q!; return { id: q!.id, digest8: q!.digest8, answerId: aid(), approved: false } },
      { ...o(), available: ['touch'], send: { recipient, message } })
    return { out, prompt, device: req ? toDeviceMessage(req, Date.now()) : null }
  }
  it('a lone surrogate in recipient or message refuses the Ask before any prompt (malformed)', async () => {
    for (const [r, m] of [['a\uD800@x.com', 'hi'], ['a@x.com', 'hi \uDC00']]) {
      const { out, device } = await shown(r!, m!)
      expect(out).toMatchObject({ approved: false, reason: 'malformed' }); expect(device).toBeNull()
    }
  })
  // Flipped by Build (R5-5 fix): such a recipient is refused before any prompt (malformed, like a lone
  // surrogate); a hidden character in the message's first line is shown as a visible marker.
  it('FIXED R5-5: RTL override, zero-width and line breaks in the recipient reach the device text unchanged', async () => {
    for (const r of ['moc.live\u202E@bob', 'bo\u200Bb@x.com', 'evil@x.com\nTo boss@company.com']) {
      const { out, device } = await shown(r, 'hi')
      expect(out, JSON.stringify(r)).toMatchObject({ approved: false, reason: 'malformed' }); expect(device).toBeNull()
    }
    const ls = await shown('a@x.com', 'Hello\u2028Wire $9,000 now')
    expect((ls.device as { text: string }).text).not.toContain('\u2028')
    expect((ls.device as { text: string }).text).toBe('Send an email\nTo a@x.com: Hello⟦U+2028⟧Wire $9,000 now')
  })
  it('NOTE: a homoglyph recipient (Cyrillic a) is shown as is; its digest differs, so the device approves what it showed', async () => {
    const latin = await shown('alice@x.com', 'hi'); const cyr = await shown('\u0430lice@x.com', 'hi')
    expect((cyr.device as { text: string; digest8: string }).digest8).not.toBe((latin.device as { digest8: string }).digest8)
    expect((cyr.device as { text: string }).text).toContain('\u0430lice@x.com')
  })
})
