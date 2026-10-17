/**
 * Protocol v3.3 (Build): early and timed device-to-phone handoff (touch and voice), ask.deviceWindowSec and
 * ildra.settings.set, the touch/phone race, phone-only flagged recipients (mixed_script, lookalike, non_ascii;
 * new_recipient informational), recipientAscii and NFC digests, and the practice Ask (PM Q52).
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020Module from 'ajv/dist/2020.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { createIldraAsk, type IldraAskEvent } from './ildraAsk.js'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, DEVICE_WINDOW_SEC, MAX_SHORT_HOLDS, PRACTICE_ACTION, PhonePairing, PracticeRefused,
  ask, openJournal, practiceAsk, stampManifest, toDeviceMessage,
  type AskAnswer, type AskHandoff, type AskRequest, type ApprovalTemplate,
} from './approvals.js'
import { CONFUSABLES_COUNT, CONFUSABLES_SHA256, CONFUSABLES_VERSION } from './unicode/confusables.js'
import { recipientAscii, skeleton } from './recipient.js'

const aid = (): string => randomBytes(16).toString('hex')
const KEY = 'P'.repeat(43) + '='
const DEV = 'D'.repeat(43) + '='
const OTHER = 'X'.repeat(43) + '='
const T: ApprovalTemplate = { permissions: { auto: ['Note it'], ask: ['Rename a file', 'Send an email'], locked_ask: ['Brakes step'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const mail = { manifest: stampManifest([{ name: 'gmail.send', send: true }], 'bridge'), tool: 'gmail.send' }

const paired = (now?: () => number): PhonePairing => {
  const p = new PhonePairing(now ? { now } : {}); const { code } = p.begin('touch'); p.offer('p1', KEY, code); p.confirm('p1', 'touch', true); return p
}
const ctxFor = (p: PhonePairing) => ({ isPaired: (id: string, pub?: string) => (pub === undefined ? p.isPaired(id) : p.isPairedKey(id, pub)) })
const phone = (r: AskRequest, extra: Partial<AskAnswer> = {}): AskAnswer => ({ id: r.id, digest8: r.digest8, answerId: aid(), approved: true, via: 'phone', from: { phoneId: 'p1', machinePub: KEY }, ...extra })
const touch = (r: AskRequest, extra: Partial<AskAnswer> = {}): AskAnswer => ({ id: r.id, digest8: r.digest8, answerId: aid(), approved: true, holdMs: 2000, via: 'touch', from: { machinePub: DEV }, ...extra })

describe('v3.3 early handoff (ledger)', () => {
  it('a paired-phone answer to an Ask on the device hands it off (from device, cause phone_answer), then settles it; a later touch is stale_channel', () => {
    const l = new AskLedger(); const p = paired()
    const seen: AskHandoff[] = []
    l.onHandoff = (h) => seen.push(h)
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch', phoneAllowed: true })
    expect(l.settle(phone(r), ctxFor(p))).toEqual({ ok: true })
    expect(seen).toEqual([{ id: r.id, from: 'device', to: 'phone', channel: 'touch', cause: 'phone_answer', at: expect.any(Number) }])
    expect(l.handoffs()).toEqual(seen) // journaled
    expect(l.pending()).toBe(0)
    const late = touch(r)
    expect(l.settle(late, ctxFor(p))).toEqual({ ok: false, reason: 'stale_channel' })
    expect(l.settle(late, ctxFor(p))).toEqual({ ok: false, reason: 'stale_channel' }) // even reused, never replayed
    expect(l.attempts().map((a) => [a.reason, a.channel])).toEqual([['stale_channel', 'touch'], ['stale_channel', 'touch']])
    // Survives a restart: the handoff record and the stale rule.
    const back = new AskLedger(); back.restore(JSON.parse(JSON.stringify(l.toJSON())))
    expect(back.handoffs()).toEqual(seen)
    expect(back.settle(touch(r), ctxFor(p))).toEqual({ ok: false, reason: 'stale_channel' })
  })
  it('never upgrades a touch-only Ask: the phone gets wrong_channel and the Ask stays on the device', () => {
    const l = new AskLedger(); const p = paired()
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch', phoneAllowed: false })
    expect(l.settle(phone(r), ctxFor(p))).toEqual({ ok: false, reason: 'wrong_channel' })
    expect(l.handoffs()).toEqual([])
    expect(l.handoff(r.id, 'phone')).toBeNull()
    expect(l.settle(touch(r), ctxFor(p))).toEqual({ ok: true })
  })
  it('only the paired key, a matching digest8, a fresh answerId and an unexpired Ask hand off; anything else is wrong_channel and spends nothing', () => {
    let t = 1_000_000
    const l = new AskLedger({ now: () => t }); const p = paired(() => t)
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    expect(l.settle(phone(r, { from: { phoneId: 'p1', machinePub: OTHER } }), ctxFor(p))).toEqual({ ok: false, reason: 'wrong_channel' })
    expect(l.settle(phone(r, { from: { phoneId: 'p9', machinePub: KEY } }), ctxFor(p))).toEqual({ ok: false, reason: 'wrong_channel' })
    expect(l.settle(phone(r, { digest8: '00000000' }), ctxFor(p))).toEqual({ ok: false, reason: 'wrong_channel' })
    const used = touch(r, { holdMs: 100 }); l.settle(used, ctxFor(p)) // a short hold: its answerId is spent
    expect(l.settle(phone(r, { answerId: used.answerId }), ctxFor(p))).toEqual({ ok: false, reason: 'wrong_channel' })
    expect(l.handoffs()).toEqual([])
    expect(l.pending()).toBe(1)
    t = r.expiresAt
    expect(l.settle(phone(r), ctxFor(p))).toEqual({ ok: false, reason: 'expired' })
  })
  it('a device answer to a phone Ask is wrong_channel and does not spend it', () => {
    const l = new AskLedger(); const p = paired()
    const r = l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone' })
    expect(l.settle(touch(r), ctxFor(p))).toEqual({ ok: false, reason: 'wrong_channel' })
    expect(l.settle(phone(r), ctxFor(p))).toEqual({ ok: true })
  })
  it('voice Asks hand off too (timer), and a device voice answer after it is stale_channel', () => {
    const l = new AskLedger(); const p = paired()
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'voice' })
    expect(r.challenge).toBeDefined()
    const h = l.handoff(r.id, 'phone')!
    expect(h).toMatchObject({ from: 'device', to: 'phone', channel: 'voice', cause: 'timer' })
    const moved = l.get(r.id)!
    expect(moved).toMatchObject({ channel: 'phone', digest8: r.digest8, expiresAt: r.expiresAt })
    expect(moved.challenge).toBeUndefined()
    expect(l.settle(touch(r, { transcript: `yes ${r.challenge}` }), ctxFor(p))).toEqual({ ok: false, reason: 'stale_channel' })
    expect(l.attempts()[0]).toMatchObject({ channel: 'voice', reason: 'stale_channel' })
    expect(l.settle(phone(r), ctxFor(p))).toEqual({ ok: true })
  })
})

describe('v3.3 ask(): which Asks the phone may take over', () => {
  it('the phone may take a device Ask only when this Ask would also route to the paired phone', async () => {
    for (const [available, expectHandoff] of [[['touch', 'phone'], true], [['touch'], false]] as const) {
      const l = new AskLedger(); const p = paired()
      let calls = 0
      const out = await ask(T, 'Rename a file', null, (_c, _p, r) => (calls++ === 0 ? phone(r!) : touch(r!)), { kind, ledger: l, pairing: p, available })
      expect(out.approved, String(available)).toBe(true)
      expect(out.channel).toBe(expectHandoff ? 'phone' : 'touch')
      expect(l.handoffs().length).toBe(expectHandoff ? 1 : 0)
    }
  })
})

// ---- the runtime: core + service as core/main.ts composes them ----

function rig(clients: Record<string, IldraAskClient>, opts: { now?: () => number } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'v33-'))
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:'), ...(opts.now ? { now: opts.now } : {}) })
  const journalPath = join(d, 'j', 'a.json')
  const markerPath = join(d, 'm', 'x.installed')
  const svc = createIldraAsk({ inputs: core, journalPath, markerPath, ...(opts.now ? { now: opts.now } : {}) })
  const shown: { channel: string; req: AskRequest }[] = []
  const withdrawn: { channel: string; id: string }[] = []
  const events: { type: IldraAskEvent['type']; body: unknown }[] = []
  svc.bridge = (channel, _p, req) => { shown.push({ channel, req }) }
  svc.withdraw = (channel, req) => { withdrawn.push({ channel, id: req.id }) }
  svc.events = (type, body) => { events.push({ type, body }) }
  const pairPhone = () => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer('p1', KEY, code); p.confirm('p1', 'touch', true) }
  const send = (req: AskRequest, conn: string, extra: Record<string, unknown> = {}) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 2000, from: { phoneId: 'p1' }, ...extra }, { local: conn.startsWith('local:'), owner: false, connection: conn })
  return { core, svc, shown, withdrawn, events, pairPhone, send, journalPath, markerPath }
}
const tick = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const CLIENTS = { dev: { identity: DEV, role: 'device' }, ph: { identity: KEY, role: 'web' }, web: { identity: OTHER, role: 'web' }, obs: { identity: KEY, role: 'observer' } }

describe('v3.3 runtime: handoff, settings, race', () => {
  afterEach(() => { vi.useRealTimers() })
  it('after ask.deviceWindowSec the Ask moves to the phone: handoff event (timer), device prompt withdrawn, shown on the phone; the phone settles it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let t = 1_000_000
    const r = rig(CLIENTS, { now: () => t })
    r.pairPhone()
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch', 'phone'] })
    await tick()
    expect(r.shown.map((s) => s.channel)).toEqual(['touch'])
    t += 59_000; vi.advanceTimersByTime(59_000); await tick()
    expect(r.events.filter((e) => e.type === 'ildra.ask.handoff')).toEqual([])
    t += 1_000; vi.advanceTimersByTime(1_000); await tick()
    expect(r.events.find((e) => e.type === 'ildra.ask.handoff')?.body).toMatchObject({ from: 'device', to: 'phone', channel: 'touch', cause: 'timer' })
    expect(r.withdrawn).toEqual([{ channel: 'touch', id: r.shown[0]!.req.id }])
    expect(r.shown.map((s) => s.channel)).toEqual(['touch', 'phone'])
    expect(await r.send(r.shown[0]!.req, 'dev')).toEqual({ ok: true }) // reaches the waiting Ask ...
    await tick()
    expect(r.svc.journal().ledger.attempts().at(-1)).toMatchObject({ reason: 'stale_channel' }) // ... and is stale
    await r.send(r.shown[1]!.req, 'ph')
    expect(await p).toMatchObject({ approved: true, channel: 'phone', reason: 'approved' })
  })
  it('ildra.settings.set from the paired phone key changes the window (clamped, journaled, echoed); nobody else can', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let t = 1_000_000
    const r = rig(CLIENTS, { now: () => t })
    r.pairPhone()
    const set = (conn: string, key: unknown, value: unknown) => r.core.requests.ildra_settings_set({ key, value, from: { phoneId: 'p1' } } as never, { local: conn.startsWith('local:'), owner: false, connection: conn })
    expect(await set('dev', 'ask.deviceWindowSec', 30)).toEqual({ ok: false, reason: 'no_authority' })
    expect(await set('local:x', 'ask.deviceWindowSec', 30)).toEqual({ ok: false, reason: 'no_authority' })
    expect(await set('obs', 'ask.deviceWindowSec', 30)).toEqual({ ok: false, reason: 'no_authority' })
    expect(await set('web', 'ask.deviceWindowSec', 30)).toEqual({ ok: false, reason: 'unpaired_phone' })
    expect(await set('ph', 'ask.other', 30)).toEqual({ ok: false, reason: 'malformed' })
    expect(await set('ph', 'ask.deviceWindowSec', '30')).toEqual({ ok: false, reason: 'malformed' })
    expect(r.svc.journal().settings.deviceWindowSec).toBe(DEVICE_WINDOW_SEC.default)
    expect(await set('ph', 'ask.deviceWindowSec', 5)).toEqual({ ok: true, key: 'ask.deviceWindowSec', value: 30 })
    expect(await set('ph', 'ask.deviceWindowSec', 1e9)).toEqual({ ok: true, key: 'ask.deviceWindowSec', value: 300 })
    expect(await set('ph', 'ask.deviceWindowSec', 44.6)).toEqual({ ok: true, key: 'ask.deviceWindowSec', value: 45 })
    expect(r.events.filter((e) => e.type === 'ildra.settings.value').map((e) => e.body)).toEqual([30, 300, 45].map((value) => ({ key: 'ask.deviceWindowSec', value })))
    expect(JSON.parse(readFileSync(r.journalPath, 'utf8')).settings).toEqual({ deviceWindowSec: 45 })
    expect(openJournal(r.journalPath, { markerPath: r.markerPath }).settings.deviceWindowSec).toBe(45)
    // The window drives the timer.
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch', 'phone'] })
    await tick()
    t += 45_000; vi.advanceTimersByTime(45_000); await tick()
    expect(r.events.some((e) => e.type === 'ildra.ask.handoff')).toBe(true)
    r.core.cancel(r.shown[0]!.req.id)
    await p
  })
  it('early handoff at runtime: the paired phone answers a device Ask; handoff (phone_answer), device withdrawn, approved on the phone; a later touch reads stale_channel', async () => {
    const r = rig(CLIENTS)
    r.pairPhone()
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch', 'phone'] })
    await tick()
    const req = r.shown[0]!.req
    expect(await r.send(req, 'ph')).toEqual({ ok: true })
    const out = await p
    expect(out).toMatchObject({ approved: true, channel: 'phone', reason: 'approved' })
    expect(r.events.map((e) => e.type)).toEqual(['ildra.ask.handoff', 'ildra.ask.outcome'])
    expect(r.events[0]!.body).toMatchObject({ from: 'device', to: 'phone', cause: 'phone_answer' })
    expect(r.withdrawn).toEqual([{ channel: 'touch', id: req.id }])
    expect(await r.send(req, 'dev')).toEqual({ ok: false, reason: 'stale_channel' })
  })
  it('a touch-only Ask at runtime: a paired-phone answer is wrong_channel and the device still settles it', async () => {
    const r = rig(CLIENTS)
    r.pairPhone()
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    await r.send(r.shown[0]!.req, 'ph'); await tick()
    expect(r.svc.journal().ledger.pending()).toBe(1)
    expect(r.events.some((e) => e.type === 'ildra.ask.handoff')).toBe(false)
    await r.send(r.shown.at(-1)!.req, 'dev')
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
  })
  it('race: a touch answer and a phone answer in the same tick; exactly one settles', async () => {
    for (const first of ['dev', 'ph']) {
      const r = rig(CLIENTS)
      r.pairPhone()
      const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch', 'phone'] })
      await tick()
      const req = r.shown[0]!.req
      const order = first === 'dev' ? ['dev', 'ph'] : ['ph', 'dev']
      const replies = await Promise.all(order.map((c) => r.send(req, c)))
      const out = await p
      expect(replies.filter((x) => x.ok)).toHaveLength(1)
      expect(out).toMatchObject({ approved: true, channel: first === 'dev' ? 'touch' : 'phone' })
      expect(r.svc.journal().ledger.pending()).toBe(0)
      expect(r.events.filter((e) => e.type === 'ildra.ask.outcome')).toHaveLength(1)
    }
  })
})

describe('v3.3 recipients: phone only when flagged, punycode, NFC, no Auto', () => {
  const o = (extra: Record<string, unknown> = {}) => ({ kind: mail, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', pairing: paired(), ...extra })
  const capture = () => {
    const seen: { channel: string; prompt: string; req: AskRequest }[] = []
    const fn = (channel: string, prompt: string, req?: AskRequest) => { seen.push({ channel, prompt, req: req! }); return phone(req!) }
    return { seen, fn }
  }
  it('mixed_script, lookalike and non_ascii route to the phone only; the device shows Use your phone; device answers are wrong_channel', async () => {
    for (const recipient of ['bob@p\u0430ypal.com', 'bob@b\u00fccher.de', '\u0440\u0430ypal@x.com']) {
      const c = capture()
      const out = await ask(T, 'Send an email', null, c.fn, o({ available: ['touch', 'phone'], send: { recipient, message: 'hi' }, contacts: ['paypal@x.com'] }))
      expect(out, recipient).toMatchObject({ approved: true, channel: 'phone' })
      expect(c.seen[0]!.channel).toBe('phone')
      expect(toDeviceMessage(c.seen[0]!.req, c.seen[0]!.req.openedAt)).toMatchObject({ type: 'display', body: 'Use your phone' })
    }
    const l = new AskLedger(); const p = paired()
    const r = l.open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'bob@b\u00fccher.de', firstLine: 'hi' })
    expect(l.settle(touch(r), ctxFor(p))).toEqual({ ok: false, reason: 'wrong_channel' })
    expect(() => l.open({ action: 'Send an email', tier: 'ask', channel: 'touch', recipient: 'bob@b\u00fccher.de', firstLine: 'hi' })).toThrow(ApprovalDenied)
  })
  it('lookalike: the skeleton (local part and domain) of a known contact or domain, text different; learned from approved sends too', async () => {
    const l = new AskLedger()
    const a = l.open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'pay\u0440al@x.com', firstLine: 'hi', known: { contacts: ['paypal@x.com'] } })
    expect(a.recipientFlags).toEqual(['mixed_script', 'lookalike', 'new_recipient'])
    const b = l.open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'ann@rnicrosoft.com', firstLine: 'hi', known: { domains: ['microsoft.com'] } })
    expect(b.recipientFlags).toEqual(['lookalike', 'new_recipient'])
    const c = l.open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'paypal@X.com', firstLine: 'hi', known: { contacts: ['paypal@x.com'] } })
    expect(c.recipientFlags).toBeUndefined() // same contact (domain case-insensitive): not a lookalike, not new
    // Learned: approve a send to bob@paypal.com, then a whole-script Cyrillic lookalike of the domain is caught.
    const p = paired()
    const first = l.open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'bob@paypal.com', firstLine: 'hi' })
    expect(first.recipientFlags).toEqual(['new_recipient'])
    expect(l.settle(phone(first), ctxFor(p))).toEqual({ ok: true })
    expect(l.knownRecipients()).toContain('bob@paypal.com')
    const again = l.open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'bob@paypal.com', firstLine: 'hi' })
    expect(again.recipientFlags).toBeUndefined()
    const fake = l.open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'bob@\u0440\u0430\u0443\u0440\u0430l.com', firstLine: 'hi' })
    expect(fake.recipientFlags).toEqual(expect.arrayContaining(['lookalike', 'non_ascii']))
    // new_recipient alone never changes routing.
    const c2 = capture()
    expect(await ask(T, 'Send an email', null, (ch, pr, r) => { c2.seen.push({ channel: ch, prompt: pr, req: r! }); return touch(r!) }, o({ available: ['touch', 'phone'], send: { recipient: 'new@example.com', message: 'hi' } }))).toMatchObject({ approved: true, channel: 'touch' })
    expect(c2.seen[0]!.req.recipientFlags).toEqual(['new_recipient'])
  })
  it('non_ascii shows punycode (recipientAscii) next to the text; digest8 covers the NFC recipient', async () => {
    const c = capture()
    await ask(T, 'Send an email', null, c.fn, o({ available: ['phone'], send: { recipient: 'bob@bu\u0308cher.de', message: 'hi' } }))
    const req = c.seen[0]!.req
    expect(req.recipient).toBe('bob@b\u00fccher.de') // NFC
    expect(req.recipientAscii).toBe('bob@xn--bcher-kva.de')
    expect(c.seen[0]!.prompt).toContain('bob@xn--bcher-kva.de (bob@b\u00fccher.de) [⚠ non-ASCII domain]')
    const c2 = capture()
    await ask(T, 'Send an email', null, c2.fn, o({ available: ['phone'], send: { recipient: 'bob@b\u00fccher.de', message: 'hi' } }))
    expect(c2.seen[0]!.req.digest8).toBe(req.digest8)
    expect(recipientAscii('a@[bad')).toBeNull()
    expect(await ask(T, 'Send an email', null, c.fn, o({ available: ['phone'], send: { recipient: 'a@xn--zz.', message: 'hi' } })).catch(() => 'threw')).toBeDefined()
  })
  it('no Auto rule covers a flagged recipient; a plain one stays auto', async () => {
    const auto: ApprovalTemplate = { permissions: { auto: ['Send an email'] } }
    const plain = await ask(auto, 'Send an email', null, () => { throw new Error('no prompt for auto') }, o({ available: ['phone'], send: { recipient: 'ann@example.com', message: 'hi' } }))
    expect(plain).toMatchObject({ approved: true, tier: 'auto', channel: null })
    const c = capture()
    const flagged = await ask(auto, 'Send an email', null, c.fn, o({ available: ['phone'], send: { recipient: 'ann@\u0435xample.com', message: 'hi' } }))
    expect(flagged).toMatchObject({ tier: 'ask', channel: 'phone' })
    expect(c.seen).toHaveLength(1)
  })
  it('the confusables table is Unicode 16.0.0, pinned, complete', () => {
    expect(CONFUSABLES_VERSION).toBe('16.0.0')
    expect(CONFUSABLES_SHA256).toBe('95bd0aad6dced5ebc63436f459c06ab21a8d107cd842fb57f5c3a1e91bca8611')
    expect(CONFUSABLES_COUNT).toBe(6355)
    expect(skeleton('\u0440\u0430\u0443\u0440\u0430l')).toBe(skeleton('paypal'))
    expect(skeleton('rn')).toBe(skeleton('m'))
    expect(skeleton('\u2170')).toBe(skeleton('i')) // small roman numeral one
    expect(skeleton('paypal')).not.toBe(skeleton('paypa1x'))
  })
})

describe('PM Q52: the practice Ask', () => {
  it('kind practice, fixed action; executes nothing, never touches totals; short holds never close it', async () => {
    const l = new AskLedger()
    let n = 0
    const out = await practiceAsk((_c, _p, r) => (++n <= MAX_SHORT_HOLDS + 3 ? touch(r!, { holdMs: 200 }) : touch(r!)), { ledger: l, available: ['touch'] })
    expect(out).toMatchObject({ approved: true, channel: 'touch', tier: 'ask', reason: 'approved', practice: true })
    expect(out.request).toMatchObject({ kind: 'practice', action: PRACTICE_ACTION, tier: 'ask' })
    expect(n).toBe(MAX_SHORT_HOLDS + 4)
    expect(l.attempts().filter((a) => a.reason === 'hold_too_short')).toHaveLength(MAX_SHORT_HOLDS + 3)
    expect(l.knownRecipients()).toEqual([])
  })
  it('anything real attached to it is refused: action, tool, amount, recipient, details, a window', async () => {
    const l = new AskLedger()
    for (const extra of [{ action: 'Pay a bill' }, { tool: 'gmail.send' }, { amountMinor: 100 }, { send: { recipient: 'a@b.c', message: 'x' } }, { recipient: 'a@b.c' }, { details: { x: 1 } }, { window: new ApprovalWindow() }, { kind: mail }]) {
      await expect(practiceAsk(() => null, { ledger: l, available: ['touch'], ...extra } as never), JSON.stringify(Object.keys(extra))).rejects.toThrow(PracticeRefused)
    }
    expect(() => l.open({ action: 'Pay a bill', tier: 'ask', channel: 'touch', kind: 'practice' })).toThrow(PracticeRefused)
    expect(() => l.open({ action: PRACTICE_ACTION, tier: 'ask', channel: 'touch', kind: 'practice', amountMinor: 5 })).toThrow(PracticeRefused)
    expect(() => l.open({ action: PRACTICE_ACTION, tier: 'ask', channel: 'phone', kind: 'practice', recipient: 'a@b.c', firstLine: 'x' })).toThrow(PracticeRefused)
    expect(() => l.open({ action: PRACTICE_ACTION, tier: 'locked_ask', channel: 'phone', kind: 'practice' })).toThrow(PracticeRefused)
    expect(() => l.open({ action: PRACTICE_ACTION, tier: 'ask', channel: 'touch', kind: 'practice', details: { tool: 'x' } })).toThrow(PracticeRefused)
    expect(l.pending()).toBe(0)
  })
  it('ask() can never produce a practice Ask, and the runtime practice never records totals', async () => {
    const seen: AskRequest[] = []
    await ask(T, 'Rename a file', null, (_c, _p, r) => { seen.push(r!); return touch(r!) }, { kind, ledger: new AskLedger(), available: ['touch'] })
    expect(seen[0]!.kind).toBeUndefined()
    const r = rig(CLIENTS)
    const before = JSON.stringify(r.svc.journal().window.toJSON())
    const p = r.svc.practice({ available: ['touch'] })
    await tick()
    expect(r.shown[0]!.req).toMatchObject({ kind: 'practice', action: PRACTICE_ACTION })
    await r.send(r.shown[0]!.req, 'dev')
    expect(await p).toMatchObject({ approved: true, practice: true })
    expect(JSON.stringify(r.svc.journal().window.toJSON())).toBe(before)
    await expect(r.svc.practice({ available: ['touch'], action: 'Pay a bill' })).rejects.toThrow(PracticeRefused)
  })
})

describe('v3.3 wire schema', () => {
  const schema = JSON.parse(readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
  const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module
  const ajv = new (Ajv2020 as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true })
  ajv.addSchema(schema)
  const env = (type: string, body: unknown) => ajv.getSchema(schema.$id)!({ type, proto: 1, body })
  it('handoff, attempts on any channel, settings, practice and flagged requests validate; wrong shapes do not', async () => {
    const l = new AskLedger(); const p = paired()
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    l.settle(phone(r), ctxFor(p))
    expect(env('ildra.ask.handoff', l.handoffs()[0])).toBe(true)
    expect(env('ildra.ask.handoff', { ...l.handoffs()[0], from: 'touch' })).toBe(false)
    const at = touch(r); l.settle(at, ctxFor(p))
    expect(env('ildra.ask.attempt', l.attempts()[0])).toBe(true)
    expect(env('ildra.ask.attempt', { ...l.attempts()[0], channel: 'voice' })).toBe(true)
    expect(env('ildra.settings.set', { key: 'ask.deviceWindowSec', value: 12.5 })).toBe(true)
    expect(env('ildra.settings.set', { key: 'other', value: 1 })).toBe(false)
    expect(env('ildra.settings.value', { key: 'ask.deviceWindowSec', value: 30 })).toBe(true)
    expect(env('ildra.settings.value', { key: 'ask.deviceWindowSec', value: 29 })).toBe(false)
    const pr = await practiceAsk((_c, _p, q) => touch(q!), { ledger: new AskLedger(), available: ['touch'] })
    expect(env('ildra.ask.request', pr.request)).toBe(true)
    expect(env('ildra.ask.outcome', pr)).toBe(true)
    expect(env('ildra.ask.request', { ...pr.request, action: 'Pay a bill' })).toBe(false)
    expect(env('ildra.ask.request', { ...pr.request, amountMinor: 1, currency: 'USD', channel: 'phone' })).toBe(false)
    const flagged = new AskLedger().open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'bob@b\u00fccher.de', firstLine: 'hi' })
    expect(env('ildra.ask.request', flagged)).toBe(true)
    expect(env('ildra.ask.request', { ...flagged, channel: 'touch' })).toBe(false)
    expect(env('ildra.ask.request', { ...flagged, recipientFlags: ['new_recipient'], channel: 'touch' })).toBe(true)
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64)
  })
})
