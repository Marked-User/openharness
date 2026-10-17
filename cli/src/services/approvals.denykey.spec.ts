/**
 * Shield's deny-key YES with conditions (batch A). The paired phone may hold one deny-only key (no user presence)
 * that signs a Deny on a pending Ask and nothing else. One describe per condition; (5) is phone-side (App).
 */
import { randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { askAnswerMessage, settingsSetMessage, PHONE_VERBS } from '../core/ildraDeviceProof.js'
import { createIldraAsk } from './ildraAsk.js'
import { deviceKeyPair, phoneKeyPair, proveBridge, signedConfirm } from './ildraAsk.testkit.js'
import { PhonePairing, stampManifest, type ApprovalTemplate, type AskRequest } from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file'], locked_ask: ['Brakes step'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); for (let i = 0; i < 20; i++) await Promise.resolve() }
const sig = (key: KeyObject, message: string): string => sign(null, Buffer.from(message, 'utf8'), key).toString('base64')

function rig(dir = mkdtempSync(join(tmpdir(), 'build-deny-')), clock = { t: 1_000_000 }) {
  const MAIN = phoneKeyPair(); const DENY = phoneKeyPair()
  return rigWith(dir, clock, MAIN, DENY)
}
function rigWith(dir: string, clock: { t: number }, MAIN: { pub: string; key: KeyObject }, DENY: { pub: string; key: KeyObject }) {
  const clients: Record<string, IldraAskClient> = { ph: { identity: MAIN.pub, role: 'web' }, dev: { identity: DEV, role: 'device' } }
  const now = () => clock.t
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:'), now })
  const svc = createIldraAsk({ inputs: core, journalPath: join(dir, 'j', 'a.json'), markerPath: join(dir, 'm', 'x.installed'), now })
  const sent: AskRequest[] = []
  const events: { type: string; body: unknown }[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  svc.events = (type, body) => { events.push({ type, body }) }
  const remote = (connection: string) => ({ local: false, owner: false, connection })
  const pair = (key = MAIN.pub) => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer('p1', key, code); p.confirm('p1', 'touch', true) }
  /** A main-key-signed enroll.confirm that carries the deny key (condition 2). */
  const installDeny = async (denyPub = DENY.pub, signer = MAIN.key, dev = deviceKeyPair()) => {
    await core.requests.ildra_device_enroll({ devicePub: dev.pub }, remote('dev'))
    return core.requests.ildra_device_enroll_confirm({ ...signedConfirm(svc, signer, dev.pub, true, 'biometric', denyPub), from: { phoneId: 'p1' } }, remote('ph'))
  }
  /** A phone answer signed by `key` over askAnswerMessage. */
  const keyAnswer = (req: AskRequest, key: KeyObject, approved: boolean, o: { answerId?: string; id?: string; connection?: string } = {}) => {
    const answerId = o.answerId ?? aid()
    return core.requests.ildra_ask_answer({ id: o.id ?? req.id, digest8: req.digest8, answerId, approved, holdMs: 2000, from: { phoneId: 'p1' },
      phoneSignature: sig(key, askAnswerMessage(approved, req.id, req.digest8, answerId)) }, remote(o.connection ?? 'ph'))
  }
  const phoneAsk = (title = 'Rename a file') => svc.ask(T, title, null, { kind, agentId: 'a', available: ['phone'] })
  return { dir, clock, core, svc, sent, events, remote, pair, installDeny, keyAnswer, phoneAsk, MAIN, DENY, journalText: () => readFileSync(join(dir, 'j', 'a.json'), 'utf8') }
}

describe('Shield deny key (1): the verifier comes from the stored key role; deny_only signs only Deny on a pending Ask', () => {
  it('every other verb, listed or unknown, is verifier_rejected and logged; the main key signs all; a stranger key is bad_signature', () => {
    const MAIN = phoneKeyPair(); const DENY = phoneKeyPair(); const STRANGER = phoneKeyPair()
    const p = new PhonePairing(); const { code } = p.begin('touch'); p.offer('p1', MAIN.pub, code); p.confirm('p1', 'touch', true)
    expect(p.setDenyKey('p1', DENY.pub)).toBe(true)
    const verbs = [...PHONE_VERBS.filter((v) => v !== 'ask.deny'), 'ask.voice', 'device.revoke', 'future.verb.v9', '']
    for (const verb of verbs) {
      const m = `msg|${verb}`
      expect(p.verifyPhone('p1', verb, m, sig(DENY.key, m)), verb).toEqual({ ok: false, reason: 'verifier_rejected' })
      expect(p.verifyPhone('p1', verb, m, sig(MAIN.key, m)), verb).toEqual({ ok: true, role: 'main' })
      expect(p.verifyPhone('p1', verb, m, sig(STRANGER.key, m)), verb).toEqual({ ok: false, reason: 'bad_signature' })
    }
    expect(p.verifierLog.map((e) => e.verb)).toEqual(verbs)
    expect(p.verifierLog.every((e) => e.reason === 'verifier_rejected' && e.phoneId === 'p1')).toBe(true)
    expect(p.verifyPhone('p1', 'ask.deny', 'm', sig(DENY.key, 'm'))).toEqual({ ok: true, role: 'deny_only' })
    // Nothing in the message selects the verifier: the same deny-key signature is judged by the verb the daemon checks.
    expect(p.verifyPhone('p2', 'ask.deny', 'm', sig(DENY.key, 'm'))).toEqual({ ok: false, reason: 'unpaired_phone' })
  })
  it('runtime: deny-key Deny settles a pending Ask as denied; deny-key Approve, settings.set and enroll.confirm are verifier_rejected', async () => {
    const r = rig(); r.pair()
    expect(await r.installDeny()).toEqual({ ok: true, state: 'enrolled' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBe(r.DENY.pub)
    const p = r.phoneAsk(); await tick()
    const req = r.sent.at(-1)!
    expect(await r.keyAnswer(req, r.DENY.key, true)).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().ledger.pending()).toBe(1) // still open
    // settings.set signed by the deny key
    const ss = { key: 'ask.deviceWindowSec', value: 45 }
    expect(await r.core.requests.ildra_settings_set({ ...ss, signature: sig(r.DENY.key, settingsSetMessage(ss.key, ss.value)), from: { phoneId: 'p1' } }, r.remote('ph'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(await r.core.requests.ildra_settings_set({ ...ss, signature: sig(r.MAIN.key, settingsSetMessage(ss.key, ss.value)), from: { phoneId: 'p1' } }, r.remote('ph'))).toMatchObject({ ok: true, value: 45 })
    // enroll.confirm signed by the deny key
    const dev = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: dev.pub }, r.remote('dev'))
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.DENY.key, dev.pub), from: { phoneId: 'p1' } }, r.remote('ph'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().pairing.verifierLog.map((e) => e.verb)).toEqual(['ask.approve', 'settings.set', 'device.enroll.confirm'])
    expect(await r.keyAnswer(req, r.DENY.key, false)).toEqual({ ok: true })
    expect(await p).toMatchObject({ approved: false, channel: 'phone' })
  })
})

describe('Shield deny key (2): deny_key only inside a main-key-signed enroll.confirm; one per phone, replaced by a new confirm', () => {
  it('unsigned, deny-key-signed, or outside the signature: refused and not installed', async () => {
    const r = rig(); r.pair()
    const dev = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: dev.pub }, r.remote('dev'))
    const { signature: _s, ...unsigned } = signedConfirm(r.svc, r.MAIN.key, dev.pub, true, 'biometric', r.DENY.pub)
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...unsigned, from: { phoneId: 'p1' } }, r.remote('ph'))).toEqual({ ok: false, reason: 'bad_signature' })
    // Signed without the deny key, deny key added afterwards: not covered by the signature.
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.MAIN.key, dev.pub), denyKey: r.DENY.pub, from: { phoneId: 'p1' } }, r.remote('ph'))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
    // Install one with the main key; then the deny key tries to install (or replace with) a key: verifier_rejected.
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.MAIN.key, dev.pub, true, 'biometric', r.DENY.pub), from: { phoneId: 'p1' } }, r.remote('ph'))).toEqual({ ok: true, state: 'enrolled' })
    const evil = phoneKeyPair()
    expect(await r.installDeny(evil.pub, r.DENY.key)).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBe(r.DENY.pub)
    expect(r.svc.journal().pairing.verifierLog.at(-1)!.verb).toBe('deny_key.set')
  })
  it('a new main-signed confirm replaces the deny key: the old one then signs nothing', async () => {
    const r = rig(); r.pair()
    await r.installDeny()
    const next = phoneKeyPair()
    expect(await r.installDeny(next.pub)).toEqual({ ok: true, state: 'enrolled' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBe(next.pub)
    const p = r.phoneAsk(); await tick()
    expect(await r.keyAnswer(r.sent.at(-1)!, r.DENY.key, false)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.keyAnswer(r.sent.at(-1)!, next.key, false)).toEqual({ ok: true })
    expect(await p).toMatchObject({ approved: false })
  })
})

describe('Shield deny key (3): a Deny is bound to answerId and digest8, single use, same expiry as Approve', () => {
  it('cross-Ask and replay are refused; a Deny after settle is a no-op; after expiry it never denies', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    const p1 = r.phoneAsk(); await tick(); const a = r.sent.at(-1)!
    const p2 = r.phoneAsk(); await tick(); const b = r.sent.at(-1)!
    expect(a.id).not.toBe(b.id)
    // A Deny signed for Ask a, sent for Ask b: the signature does not cover b.
    const answerId = aid()
    const forA = { digest8: a.digest8, answerId, approved: false, from: { phoneId: 'p1' }, phoneSignature: sig(r.DENY.key, askAnswerMessage(false, a.id, a.digest8, answerId)) }
    expect(await r.core.requests.ildra_ask_answer({ ...forA, id: b.id, digest8: b.digest8 }, r.remote('ph'))).toEqual({ ok: false, reason: 'bad_signature' })
    const other8 = a.digest8 === 'ffffffff' ? '00000000' : 'ffffffff'
    expect(await r.core.requests.ildra_ask_answer({ ...forA, id: a.id, digest8: other8 }, r.remote('ph'))).toEqual({ ok: false, reason: 'bad_signature' }) // digest8 bound
    expect(await r.core.requests.ildra_ask_answer({ ...forA, id: a.id }, r.remote('ph'))).toEqual({ ok: true })
    expect(await p1).toMatchObject({ approved: false })
    // Replay of the same signed Deny: Ask a is settled, nothing changes (no-op).
    const state = () => { const x = r.svc.journal().ledger.toJSON() as { open: unknown; spent: unknown }; return JSON.stringify([x.open, x.spent]) }
    const before = state()
    expect(await r.core.requests.ildra_ask_answer({ ...forA, id: a.id }, r.remote('ph'))).toMatchObject({ ok: false })
    expect(state()).toBe(before) // nothing opened, spent or settled again
    expect(r.svc.journal().pairing.denyLog).toHaveLength(1) // and not journaled twice
    // The same answerId re-signed for Ask b is single use: replayed (which spends b, as for any replayed answer), never denied.
    const reuse = { id: b.id, digest8: b.digest8, answerId, approved: false, from: { phoneId: 'p1' }, phoneSignature: sig(r.DENY.key, askAnswerMessage(false, b.id, b.digest8, answerId)) }
    await r.core.requests.ildra_ask_answer(reuse, r.remote('ph'))
    expect(await p2).toMatchObject({ approved: false, reason: 'replayed' })
    expect(r.svc.journal().pairing.denyLog).toHaveLength(1)
    // Same expiry as Approve: after expiresAt a deny-key Deny never settles the Ask as denied.
    const p3 = r.phoneAsk(); await tick(); const c = r.sent.at(-1)!
    r.clock.t = c.expiresAt + 1
    await r.keyAnswer(c, r.DENY.key, false)
    const o3 = await p3
    expect(o3.approved).toBe(false)
    expect(o3.reason).not.toBe('denied')
    expect(r.svc.journal().pairing.denyLog).toHaveLength(1)
  })
})

describe('Shield deny key (4): unpair or main-key rotation revokes the deny key atomically', () => {
  it('unpair: the deny key is gone in the same journal write; a re-pair with the same key does not bring it back', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    expect(r.journalText()).toContain(r.DENY.pub)
    r.svc.journal().pairing.unpair('p1')
    expect(r.journalText()).not.toContain(r.DENY.pub)
    r.pair()
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
  })
  it('rotation: a re-pair of the phone with a new main key drops the deny key; it survives a restart only while the pairing stands', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    const r2 = rigWith(r.dir, r.clock, r.MAIN, r.DENY)
    expect(r2.svc.journal().pairing.denyKey('p1')).toBe(r.DENY.pub)
    const rotated = phoneKeyPair()
    r2.pair(rotated.pub)
    expect(r2.svc.journal().pairing.denyKey('p1')).toBeNull()
    expect(r2.journalText()).not.toContain(r.DENY.pub)
  })
})

describe('Shield deny key (6): every deny-key Deny is journaled with source deny_key; more than 3 in 60 s flags the phone', () => {
  it('3 in 60 s: no flag; the 4th sets it; the next phone open shows the summary once; it survives a restart', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    const denyOne = async () => { const p = r.phoneAsk(); await tick(); expect(await r.keyAnswer(r.sent.at(-1)!, r.DENY.key, false)).toEqual({ ok: true }); await p; r.clock.t += 10_000 }
    for (let i = 0; i < 3; i++) await denyOne()
    const log = r.svc.journal().pairing.denyLog
    expect(log).toHaveLength(3)
    expect(log.every((e) => e.source === 'deny_key' && e.phoneId === 'p1')).toBe(true)
    expect(await r.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r.remote('ph'))).toEqual({ ok: true, denySummary: null })
    // A main-key Deny is not counted.
    const pm = r.phoneAsk(); await tick(); await r.keyAnswer(r.sent.at(-1)!, r.MAIN.key, false); await pm
    expect(r.svc.journal().pairing.denyLog).toHaveLength(3)
    await denyOne()
    expect(r.journalText()).toContain('"source":"deny_key"')
    const r2 = rigWith(r.dir, r.clock, r.MAIN, r.DENY)
    const open1 = await r2.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r2.remote('ph'))
    expect(open1).toEqual({ ok: true, denySummary: { count: 4, since: 1_000_000, at: expect.any(Number) } })
    expect(r2.events.find((e) => e.type === 'ildra.phone.deny_summary')).toBeTruthy()
    expect(await r2.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r2.remote('ph'))).toEqual({ ok: true, denySummary: null })
    expect(await r2.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r2.remote('dev'))).toEqual({ ok: false, reason: 'no_authority' })
  })
  it('4 spread over more than 60 s set no flag', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    for (let i = 0; i < 4; i++) { const p = r.phoneAsk(); await tick(); await r.keyAnswer(r.sent.at(-1)!, r.DENY.key, false); await p; r.clock.t += 25_000 }
    expect(r.svc.journal().pairing.peekDenySummary('p1')).toBeNull()
  })
})

describe('Shield deny key (7): never on the voice path; a locked_ask settles by it only as denied', () => {
  it('a device (touch or voice) answer carrying a phone-key signature is verifier_rejected and logged', async () => {
    const r = rig(); r.pair()
    const dev = deviceKeyPair()
    await r.installDeny(undefined, undefined, dev)
    expect(proveBridge(r.core, 'dev', dev.key)).toBe(true) // the proven device: its answers reach the touch and voice path
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch', 'voice'] })
    await tick()
    const req = r.sent.at(-1)!
    expect(await r.keyAnswer(req, r.DENY.key, false, { connection: 'dev' })).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().pairing.verifierLog.at(-1)!.verb).toMatch(/^answer\.(touch|voice)$/)
    r.core.cancel(req.id); await p
  })
  it('locked_ask: deny-key Approve is verifier_rejected, deny-key Deny settles it as denied', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    const p = r.phoneAsk('Brakes step'); await tick()
    const req = r.sent.at(-1)!
    expect(await r.keyAnswer(req, r.DENY.key, true)).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(await r.keyAnswer(req, r.DENY.key, false)).toEqual({ ok: true })
    expect(await p).toMatchObject({ approved: false, channel: 'phone' })
  })
})

describe('Shield deny key: wire', () => {
  it('phoneSignature, denyKey, settings signature, bad_signature and the phone open / deny summary messages match the schema', async () => {
    const { readFileSync: rf } = await import('node:fs')
    const Ajv2020Module = (await import('ajv/dist/2020.js')).default as unknown as { default?: unknown }
    const Ajv2020 = (Ajv2020Module.default ?? Ajv2020Module) as new (o: object) => import('ajv').default
    const schema = JSON.parse(rf(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true }); ajv.addSchema(schema)
    const env = (type: string, body: unknown): boolean => ajv.getSchema(schema.$id)!({ type, proto: 1, body }) as boolean
    const s64 = Buffer.alloc(64, 7).toString('base64'); const k = phoneKeyPair().pub; const dk = deviceKeyPair().pub
    expect(env('ildra.ask.answer', { id: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', digest8: '0011aabb', answerId: aid(), approved: false, phoneSignature: s64 })).toBe(true)
    expect(env('ildra.ask.answer', { id: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', digest8: '0011aabb', answerId: aid(), approved: false, phoneSignature: 'x' })).toBe(false)
    expect(env('ildra.device.enroll.confirm', { devicePub: dk, nonce: randomBytes(32).toString('base64url'), approved: true, uv: 'passcode', signature: s64, denyKey: k })).toBe(true)
    expect(env('ildra.device.enroll.confirm', { devicePub: dk, nonce: randomBytes(32).toString('base64url'), approved: true, uv: 'passcode', signature: s64, denyKey: dk })).toBe(false) // P-256 move: an Ed25519 deny key
    expect(env('ildra.device.enroll.confirm', { devicePub: dk, nonce: randomBytes(32).toString('base64url'), approved: true, uv: 'passcode', signature: s64, denyKey: 'nope' })).toBe(false)
    expect(env('ildra.settings.set', { key: 'ask.deviceWindowSec', value: 45, signature: s64 })).toBe(true)
    expect(env('ildra.phone.open', {})).toBe(true)
    expect(env('ildra.phone.deny_summary', { count: 4, since: 1, at: 2 })).toBe(true)
    expect(env('ildra.phone.deny_summary', { count: 3, since: 1, at: 2 })).toBe(false)
    expect(schema.$defs.AskRejectionReason.enum).toEqual(expect.arrayContaining(['verifier_rejected', 'bad_signature']))
  })
})

describe('Shield D2a: the confirm is all or nothing', () => {
  it('a refused deny key (the main key itself) leaves the enrollment pending, no device, no deny key, no ledger enrollment; a good confirm then enrolls', async () => {
    const r = rig(); r.pair()
    const dev = deviceKeyPair()
    expect(await r.installDeny(r.MAIN.pub, r.MAIN.key, dev)).toEqual({ ok: false, reason: 'malformed' })
    const j = r.svc.journal()
    expect(j.device.device()).toBeNull()
    expect(j.device.pending()?.devicePub).toBe(dev.pub)
    expect(j.pairing.denyKey('p1')).toBeNull()
    expect(j.pairingLedger.all().some((e) => e.kind === 'device_enrolled' || e.kind === 'deny_key_set')).toBe(false)
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.MAIN.key, dev.pub, true, 'biometric', r.DENY.pub), from: { phoneId: 'p1' } }, r.remote('ph'))).toEqual({ ok: true, state: 'enrolled' })
    expect(j.device.device()).toBe(dev.pub)
  })
})

describe('Shield (a): a deny key equal to the main key is refused, compared as parsed points, all or nothing', () => {
  it('enroll.confirm: denyKey = the main key is refused whole (malformed): no device, no deny key, nothing on the ledger', async () => {
    const r = rig(); r.pair()
    const dev = deviceKeyPair()
    const before = r.svc.journal().pairingLedger.all().length
    expect(await r.installDeny(r.MAIN.pub, r.MAIN.key, dev)).toEqual({ ok: false, reason: 'malformed' })
    expect(r.svc.journal().device.device()).toBeNull()
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
    expect(r.svc.journal().pairingLedger.all().slice(before).some((e) => e.kind === 'device_enrolled' || e.kind === 'deny_key_set')).toBe(false)
    expect(new PhonePairing().canSetDenyKey('p1', r.MAIN.pub)).toBe(false)
  })
  it('pairing: a re-pair offering the current deny key as the main key is refused whole (bad_phone_key); the pairing and deny key stand', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    const p = r.svc.journal().pairing
    const { code } = p.begin('touch')
    expect(p.offer('p1', r.DENY.pub, code)).toEqual({ ok: false, reason: 'bad_phone_key' })
    expect(p.offer('p9', r.DENY.pub, p.begin('touch').code)).toEqual({ ok: false, reason: 'bad_phone_key' })
    expect(p.phoneKey('p1')).toBe(r.MAIN.pub)
    expect(p.denyKey('p1')).toBe(r.DENY.pub)
    expect(p.isPaired('p9')).toBe(false)
  })
  it('pairing: a deny key installed between offer and confirm still blocks that main key at confirm', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    const p = r.svc.journal().pairing
    // p2 offers a fresh key; meanwhile p1 makes that same point its deny key; p2's confirm is then refused.
    const K2 = phoneKeyPair()
    const { code } = p.begin('touch')
    expect(p.offer('p2', K2.pub, code)).toMatchObject({ ok: true })
    expect(await r.installDeny(K2.pub)).toEqual({ ok: true, state: 'enrolled' })
    expect(p.confirm('p2', 'touch', true)).toBe(false)
    expect(p.isPaired('p2')).toBe(false)
  })
  it('unpair revokes the deny key (ledger deny_key_revoked unpaired, it signs nothing); re-pair plus a new confirm replaces it', async () => {
    const r = rig(); r.pair(); await r.installDeny()
    r.svc.journal().pairing.unpair('p1')
    expect(r.svc.journal().pairingLedger.all().some((e) => e.kind === 'deny_key_revoked' && e.reason === 'unpaired')).toBe(true)
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
    r.pair()
    const next = phoneKeyPair()
    expect(await r.installDeny(next.pub)).toEqual({ ok: true, state: 'enrolled' })
    const pa = r.phoneAsk(); await tick()
    expect(await r.keyAnswer(r.sent.at(-1)!, r.DENY.key, false)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.keyAnswer(r.sent.at(-1)!, next.key, false)).toEqual({ ok: true })
    expect(await pa).toMatchObject({ approved: false })
  })
})
