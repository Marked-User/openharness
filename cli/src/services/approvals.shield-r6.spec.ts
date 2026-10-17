/**
 * Shield round 6 checks of the Ask gate on c6bab0231 (R5 fixes) and 81d6c2d55 (v3.3). Written by Shield,
 * independent of Build's specs. FIXED and verified tests are attacks that must fail. GAP and RESIDUAL tests
 * assert today's weak behavior so a fix flips them (security/FINDINGS.md, "Final M1 Ask-gate check, round 6").
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { createIldraAsk } from './ildraAsk.js'
import { deviceKeyPair, enrollBridge, proveBridge } from './ildraAsk.testkit.js'
import {
  ApprovalWindow, AskLedger, PhonePairing, ask, askKindFor, classifyTool, isSendTool, resolveTool, stampManifest, toDeviceMessage,
  type AskAnswer, type AskRequest, type ApprovalTemplate,
} from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file', 'Send an email'], locked_ask: ['Brakes step'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const DEV2 = 'E'.repeat(43) + '='
const PHONE = 'P'.repeat(43) + '='
const PHONE2 = 'Q'.repeat(43) + '='
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function rig(clients: Record<string, IldraAskClient>) {
  const d = mkdtempSync(join(tmpdir(), 'shield-r6-'))
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:') })
  const svc = createIldraAsk({ inputs: core, journalPath: join(d, 'j', 'a.json'), markerPath: join(d, 'm', 'x.installed') })
  const sent: AskRequest[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  const answer = (req: AskRequest, connection: string, extra: Record<string, unknown> = {}) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 2000, ...extra }, { local: false, owner: false, connection })
  const pair = (key: string) => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer('p1', key, code); p.confirm('p1', 'touch', true) }
  return { core, svc, sent, answer, pair }
}

describe('Shield R6: the two Build edits to Shield tests do not weaken them', () => {
  it('an unstamped entry, a copy of a stamped entry, or an owner written after stamping is not believed', () => {
    const raw = [{ name: 'evil.mail', send: false, owner: 'bridge', safetyVerification: true }]
    expect(isSendTool(raw, 'evil.mail')).toBe(true)
    const stamped = stampManifest([{ name: 'evil.mail', send: false }], 'bridge')
    expect(isSendTool(stamped, 'evil.mail')).toBe(false)
    expect(isSendTool([{ ...stamped[0]! }], 'evil.mail')).toBe(true) // a copy is the manifest's own claim
    const tp = stampManifest([{ name: 'evil.mail', send: false }], 'third_party')
    expect(() => { (tp[0] as { owner: unknown }).owner = 'bridge' }).toThrow() // frozen
    expect(isSendTool(tp, 'evil.mail')).toBe(true)
    expect(isSendTool(stampManifest([{ name: 'evil.mail', send: false }], 'store' as never), 'evil.mail')).toBe(true) // unknown source is third_party
  })
  it("a third-party stamped KIND entry is still checked: send checks apply and it never sets safety_verification", async () => {
    const tpKind = (tool: string) => ({ kind: { manifest: stampManifest([{ name: tool, send: false, safetyVerification: true }], 'third_party'), tool } })
    let prompted = 0
    await expect(ask(T, 'Rename a file', null, () => { prompted++; return null }, { ...tpKind('fs.rename'), ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'] }))
      .rejects.toThrow(/recipient and the message/)
    expect(prompted).toBe(0)
    expect(askKindFor({ permissions: { locked_ask: ['Brakes step'] } }, 'Brakes step', 'locked_ask', tpKind('t').kind)).toBeUndefined()
  })
  it('homoglyph edit: a Cyrillic look-alike never reaches the device; the full ask path routes it to the phone with its own digest', async () => {
    const send = (recipient: string) => {
      let req: AskRequest | undefined
      return ask(T, 'Send an email', null, (_c, _p, q) => { req = q!; return null },
        { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch', 'phone'], isPaired: () => true,
          pairing: (() => { const p = new PhonePairing(); const { code } = p.begin('touch'); p.offer('p1', PHONE, code); p.confirm('p1', 'touch', true); return p })(),
          send: { recipient, message: 'hi' } }).then((out) => ({ out, req }))
    }
    const lat = await send('alice@x.com'); const cyr = await send('\u0430lice@x.com')
    expect(lat.req!.channel).toBe('touch')
    expect(cyr.req!.channel).toBe('phone')
    expect(cyr.req!.recipientFlags).toContain('mixed_script')
    expect(cyr.req!.digest8).not.toBe(lat.req!.digest8)
  })
})

describe('Shield R6 R5-1: who may answer, end to end through the runtime', () => {
  it('phone key pinning: after a re-pair with a new key the old key is refused (Ask stays open) and the new key approves; after unpair nothing', async () => {
    const r = rig({ old: { identity: PHONE, role: 'web' }, neu: { identity: PHONE2, role: 'web' } })
    r.pair(PHONE)
    r.svc.journal().pairing.unpair('p1')
    r.pair(PHONE2)
    const p1 = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await tick()
    await r.answer(r.sent[0]!, 'old', { from: { phoneId: 'p1' } })
    await tick()
    expect(r.svc.journal().ledger.pending()).toBe(1) // R7-10: refused first, nothing spent
    await r.answer(r.sent[r.sent.length - 1]!, 'neu', { from: { phoneId: 'p1' } })
    expect(await p1).toMatchObject({ approved: true, channel: 'phone' })
    r.svc.journal().pairing.unpair('p1')
    const p3 = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    expect(await p3).toMatchObject({ approved: false, channel: null, reason: 'no_paired_phone' })
  })
  it('FIXED R7-1: a device-role connection that has not proved the enrolled device key answers nothing; the enrolled one does', async () => {
    const r = rig({ ildra: { identity: DEV, role: 'device' }, other: { identity: DEV2, role: 'device' } })
    const cred = enrollBridge(r.core, r.svc, { ildra: { role: 'device', identity: DEV } })!
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'other')).toEqual({ ok: false, reason: 'no_authority' })
    expect(proveBridge(r.core, 'other', deviceKeyPair().key)).toBe(false) // its own key is not the device
    expect(await r.answer(r.sent[0]!, 'other')).toEqual({ ok: false, reason: 'no_authority' })
    await r.answer(r.sent[0]!, 'ildra')
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
  })
  it("Build's ildraAsk.shield.spec.ts:80 edit: an unknown connection gets no_authority, approves nothing, records nothing, spends nothing", async () => {
    const r = rig({})
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    const before = JSON.stringify(r.svc.journal().ledger.toJSON())
    for (const conn of ['ghost', '', 'local:x']) {
      const out = await r.answer(r.sent[0]!, conn)
      expect(out.ok, conn).toBe(false)
    }
    await tick()
    const j = r.svc.journal().ledger
    expect(j.pending()).toBe(1)
    expect(j.attempts()).toEqual([])
    expect(JSON.stringify(j.toJSON())).toBe(before)
    r.core.cancel(r.sent[0]!.id)
    expect(await p).toMatchObject({ approved: false })
  })
  it('RESIDUAL (in-process only): a ledger answer with no via and no key is checked by phone id alone', () => {
    const l = new AskLedger(); const p = new PhonePairing(); const { code } = p.begin('touch'); p.offer('p1', PHONE, code); p.confirm('p1', 'touch', true)
    const r = l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone' })
    const ctx = { isPaired: (id: string, pub?: string) => (pub === undefined ? p.isPaired(id) : p.isPairedKey(id, pub)) }
    expect(l.settle({ id: r.id, digest8: r.digest8, answerId: aid(), approved: true, from: { phoneId: 'p1' } } as AskAnswer, ctx)).toEqual({ ok: true })
  })
})

describe('Shield R6 R5-4 and v3.3 timing', () => {
  it('after hold_limit a correct 2 s hold with a fresh answerId does not approve', () => {
    const l = new AskLedger()
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    const t = (holdMs: number): AskAnswer => ({ id: r.id, digest8: r.digest8, answerId: aid(), approved: true, holdMs, via: 'touch', from: { machinePub: DEV } })
    const out = [1, 2, 3, 4, 5].map(() => l.settle(t(100)))
    expect(out.at(-1)).toEqual({ ok: false, reason: 'hold_limit' })
    expect(l.settle(t(2000))).toMatchObject({ ok: false })
  })
  it('a phone answer after the Ask expired is refused (expired), even right after a handoff', () => {
    let now = 1_000_000
    const l = new AskLedger({ now: () => now })
    const p = new PhonePairing({ now: () => now }); const { code } = p.begin('touch'); p.offer('p1', PHONE, code); p.confirm('p1', 'touch', true)
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch', phoneAllowed: true })
    l.handoff(r.id, 'phone', 'timer')
    now = r.expiresAt + 1
    const ctx = { isPaired: (id: string, pub?: string) => (pub === undefined ? p.isPaired(id) : p.isPairedKey(id, pub)) }
    expect(l.settle({ id: r.id, digest8: r.digest8, answerId: aid(), approved: true, via: 'phone', from: { phoneId: 'p1', machinePub: PHONE } }, ctx)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('Shield R6 R5-5: what the device shows', () => {
  const show = async (recipient: string, contacts: string[] = []) => {
    let req: AskRequest | undefined
    const out = await ask(T, 'Send an email', null, (_c, _p, q) => { req = q!; return null },
      { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'], contacts, send: { recipient, message: 'hi' } })
    return { out, device: req ? toDeviceMessage(req, Date.now()) as { text: string } : null }
  }
  it('a whole-script Cyrillic domain (no mixed script) never reaches the device', async () => {
    const { out, device } = await show('bob@\u0430\u0440\u0440\u04CF\u0435.com')
    expect(device).toBeNull(); expect(out).toMatchObject({ approved: false, reason: 'no_channel' })
  })
  it('a whole-script Cyrillic look-alike of a known contact (skeleton match) never reaches the device', async () => {
    const { device } = await show('\u0441\u043E\u0441\u043E@gmail.com', ['coco@gmail.com'])
    expect(device).toBeNull()
  })
  it('FIXED R7-3: whole-script Cyrillic local parts with an ASCII domain never reach the device (with or without a contact list)', async () => {
    for (const contacts of [[], ['apple@gmail.com']]) {
      const { device } = await show('\u0430\u0440\u0440\u04CF\u0435@gmail.com', contacts)
      expect(device).toBeNull()
    }
  })
  it('FIXED R7-2: default-ignorable characters in the recipient refuse the Ask as malformed (never shown)', async () => {
    for (const c of ['\u00AD', '\u034F', '\u2063', '\uFE0F', '\u{E0041}', '\u{E0001}', '\u180E', '\u2061', '\u{1D173}', '\uFFA0']) {
      let req: AskRequest | undefined
      const out = await ask(T, 'Send an email', null, (_c, _p, q) => { req = q!; return null },
        { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'], send: { recipient: `bo${c}b@x.com`, message: 'hi' } })
      expect(out, JSON.stringify(c)).toMatchObject({ approved: false, reason: 'malformed' })
      expect(req, JSON.stringify(c)).toBeUndefined()
    }
  })
})

describe('Shield R6 F4: who may call a tool a read', () => {
  it('FIXED R7-4: a third-party readOnlyHint is not believed, and a send is never Auto even from a trusted read-only entry', async () => {
    const tp = stampManifest([{ name: 'evil.wipe', annotations: { readOnlyHint: true } }], 'third_party', 'evil')
    expect(classifyTool(tp, 'evil.wipe')).toBe('write')
    expect(resolveTool(T, 'evil.wipe', tp)).toBe('ask')
    for (const m of [tp, stampManifest([{ name: 'evil.wipe', readOnly: true, annotations: { readOnlyHint: true } }], 'bridge'),
                     stampManifest([{ name: 'evil.wipe', readOnly: true, send: false }], 'first_party')]) {
      let prompted = 0
      const out = await ask(T, 'Wipe the drive', null, () => { prompted++; return null },
        { kind: { manifest: m, tool: 'evil.wipe' }, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'], send: { recipient: 'boss@company.com', message: 'Wire $9,000 now' } })
      expect(out.tier).not.toBe('auto'); expect(out.approved).toBe(false); expect(prompted).toBeGreaterThan(0)
    }
  })
})
