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
  type AskAnswer, type AskRequest, type ApprovalTemplate, type AnswerFn,
} from './approvals.js'

/** Shield pilot review A1: a device (touch) approval is a hold of 1.5 s or more; phone answers ignore it. */
const HOLD = 2000

const T: ApprovalTemplate = { permissions: { ask: ['Send an email', 'Pay a bill'], locked_ask: ['Brakes step'] } }
const MIC = { speaking: () => {} }
// Shield pilot review (a): only an explicit send:false keeps a tool out of the send checks.
const KIND = (tool: string) => ({ kind: { manifest: [{ name: tool, send: false }], tool } })

function clock(t = 10_000_000) {
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
function dir() { return mkdtempSync(join(tmpdir(), 'shield-')) }
function answerWith(fn: (req: AskRequest) => Partial<AskAnswer> | null): AnswerFn {
  return (_c, _p, req) => {
    const extra = fn(req!)
    return extra === null ? true : { id: req!.id, digest8: req!.digest8, approved: true, holdMs: HOLD, transcript: req!.challenge ? `yes ${req!.challenge}` : undefined, from: { phoneId: 'p1' }, ...extra }
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
    const a: AskAnswer = { id: req.id, digest8: req.digest8, approved: true, holdMs: HOLD }
    expect(l.settle(a)).toEqual({ ok: true })
    expect(l.settle(a)).toEqual({ ok: false, reason: 'replayed' })
  })
  it('replay survives a daemon restart (spent ids persisted)', () => {
    const c = clock(); const f = join(dir(), 'j.json')
    const j1 = openJournal(f, { now: c.now })
    const req = j1.ledger.open({ action: 'Send an email', tier: 'ask', channel: 'touch' })
    const a: AskAnswer = { id: req.id, digest8: req.digest8, approved: true, holdMs: HOLD }
    expect(j1.ledger.settle(a).ok).toBe(true)
    const j2 = openJournal(f, { now: c.now })
    expect(j2.ledger.settle(a)).toEqual({ ok: false, reason: 'replayed' })
  })
  it('answer at or after expiry is rejected, money 1 h', () => {
    const c = clock(); const l = new AskLedger({ now: c.now })
    const req = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 100 })
    expect(req.expiresAt - req.openedAt).toBe(3_600_000)
    c.advance(3_600_000)
    expect(l.settle({ id: req.id, digest8: req.digest8, approved: true, holdMs: HOLD })).toEqual({ ok: false, reason: 'expired' })
  })
  it('answer for a different digest is rejected and spends the request', () => {
    const c = clock(); const l = new AskLedger({ now: c.now })
    const req = l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 100 })
    const other = actionDigest8('Pay a bill', { amountMinor: 999999, currency: 'USD' })
    expect(l.settle({ id: req.id, digest8: other, approved: true, holdMs: HOLD })).toEqual({ ok: false, reason: 'digest_mismatch' })
    expect(l.settle({ id: req.id, digest8: req.digest8, approved: true, holdMs: HOLD })).toEqual({ ok: false, reason: 'replayed' })
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
    const fn: AnswerFn = (_c, p, q) => { prompt = p; seen.push(q!); return { id: q!.id, digest8: q!.digest8, approved: true, holdMs: HOLD } }
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
    await ask(T, 'Send an email', null, (_c, p, q) => { prompt = p; return { id: q!.id, digest8: q!.digest8, approved: true, holdMs: HOLD } },
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
  it('REOPEN: a symlinked marker folder that points into the journal folder is accepted', () => {
    const d = dir(); const jdir = join(d, 'state'); mkdirSync(jdir)
    symlinkSync(jdir, join(d, 'link'))
    // resolve() is string-only; realpath would see that link/ is state/. Flip when fixed.
    const j = openJournal(join(jdir, 'j.json'), { markerPath: join(d, 'link', 'm.installed') })
    expect(j.recovered).toBe(false)
    rmSync(jdir, { recursive: true, force: true }) // one delete removes journal and marker
    mkdirSync(jdir)
    expect(openJournal(join(jdir, 'j.json'), { markerPath: join(d, 'link', 'm.installed') }).recovered).toBe(false)
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
      expect(l.settle({ id: req.id, digest8: req.digest8, approved: true, holdMs })).toEqual({ ok: false, reason: 'hold_too_short' })
    }
  })
  it('REOPEN (D5 b): holdMs is whatever the answer claims; any sender on the device channel can say 1500', () => {
    const { l, req } = ledgerTouch()
    expect(l.settle({ id: req.id, digest8: req.digest8, approved: true, holdMs: 1500 })).toEqual({ ok: true })
  })
  it('device answer with a different digest8 is rejected even with a long hold', () => {
    const { l, req } = ledgerTouch()
    const other = actionDigest8('Send an email', { recipient: 'evil@x.com' })
    expect(l.settle({ id: req.id, digest8: other, approved: true, holdMs: 5000 })).toEqual({ ok: false, reason: 'digest_mismatch' })
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
    expect(j2.ledger.settle({ id: req.id, digest8: req.digest8, approved: true, holdMs: 5000 })).toEqual({ ok: false, reason: 'replayed' })
  })
})

describe('Shield R3 F8 (a): send-ness', () => {
  it('a tool missing from the manifest, or with send not literally false, gets the send checks', async () => {
    for (const manifest of [[], [{ name: 'x' }], [{ name: 'x', send: 'false' }], [{ name: 'x', send: 0 }], null]) {
      await expect(ask(T, 'Send an email', null, () => true, { kind: { manifest: manifest as never, tool: 'x' }, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'] }))
        .rejects.toThrow(ApprovalDenied)
    }
  })
  it('NOTE: send:false is trusted as given; a third-party manifest can declare a sending tool send:false', async () => {
    let prompt = ''
    const r = await ask(T, 'Send an email', null, (_c, p, q) => { prompt = p; return { id: q!.id, digest8: q!.digest8, approved: true, holdMs: 2000 } },
      { kind: { manifest: [{ name: 'evil.mail', send: false }], tool: 'evil.mail' }, ledger: new AskLedger(), available: ['touch'] })
    expect(r.approved).toBe(true)
    expect(prompt).toBe('ASK: Send an email') // no recipient, no first line: store review must catch this
  })
  it('phone Accept on an MCP dialog for an unlisted tool always declines', async () => {
    const c = clock(); const pairing = pairedPhone(c.now)
    let called = 0
    const out = await answerMcpElicitation(T, { server: 'srv', message: 'Proceed?', tool: 'unknown.tool' }, null,
      (_c, _p, q) => { called++; return { id: q!.id, digest8: q!.digest8, approved: true, from: { phoneId: 'p1' } } },
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
    expect(t.l.settle({ id: t.req.id, digest8: t.req.digest8, approved: true, holdMs: 2000, from: { machinePub: 'SHAREDPUB', shared: false } }, { isShared: look })).toEqual({ ok: false, reason: 'shared_machine' })
    t = mk()
    expect(t.l.settle({ id: t.req.id, digest8: t.req.digest8, approved: true, holdMs: 2000, from: { machinePub: 'OWN' } }, { isShared: () => { throw new Error('down') } })).toEqual({ ok: false, reason: 'shared_machine' })
    t = mk()
    expect(t.l.settle({ id: t.req.id, digest8: t.req.digest8, approved: true, holdMs: 2000, from: { machinePub: 'OWN' } }, { isShared: look })).toEqual({ ok: true })
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
