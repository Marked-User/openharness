/**
 * Shield, on fork 52977f9ac (Build batch A deny key 91c70791c plus batch B pairing ledger and unpair).
 * D1 to D6: the phone deny key conditions, as real tests (were it.todo in approvals.shield-r7.spec.ts).
 * B: attacks on the pairing ledger and the unpair API. A test named GAP asserts a weakness Shield reported
 * that is still there; when Build fixes it, flip the assertion and rename it FIXED.
 * P-256: tests prepared for Build's move of phone keys to P-256 ECDSA; they skip until the verifier exists.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import * as proof from '../core/ildraDeviceProof.js'
import { askAnswerMessage, deviceFingerprint, settingsSetMessage, unpairMessage, unpairTouchMessage } from '../core/ildraDeviceProof.js'
import { createIldraAsk, UNPAIR_RATE } from './ildraAsk.js'
import { deviceKeyPair, phoneKeyPair, proveBridge, signedConfirm } from './ildraAsk.testkit.js'
import { stampManifest, type ApprovalTemplate, type AskRequest, type PairingLedgerEntry } from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file'], locked_ask: ['Brakes step'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); for (let i = 0; i < 20; i++) await Promise.resolve() }
const sig = (key: KeyObject, m: string): string => sign(null, Buffer.from(m, 'utf8'), key).toString('base64')
type Key = { pub: string; key: KeyObject }

function rig(dir = mkdtempSync(join(tmpdir(), 'shield-b-')), clock = { t: 5_000_000 }, keys?: { P1: Key; P2: Key; D1: Key; D2: Key; DEVK: Key }) {
  const K = keys ?? { P1: phoneKeyPair(), P2: phoneKeyPair(), D1: phoneKeyPair(), D2: phoneKeyPair(), DEVK: deviceKeyPair() }
  const clients: Record<string, IldraAskClient> = {
    ph1: { identity: K.P1.pub, role: 'web' }, ph2: { identity: K.P2.pub, role: 'web' },
    dev: { identity: DEV, role: 'device' }, obs: { identity: K.P1.pub, role: 'observer' },
  }
  const now = () => clock.t
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:'), now })
  const path = join(dir, 'j', 'a.json')
  const svc = createIldraAsk({ inputs: core, journalPath: path, markerPath: join(dir, 'm', 'x.installed'), now })
  const sent: AskRequest[] = []
  const events: { type: string; body: unknown }[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  svc.events = (type, body) => { events.push({ type, body }) }
  const remote = (connection: string) => ({ local: false, owner: false, connection })
  const local = () => ({ local: true, owner: true, connection: 'local:owner' })
  const pair = (phoneId: string, key: string) => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer(phoneId, key, code); p.confirm(phoneId, 'touch', true) }
  const enrollDevice = async (denyPub?: string, signer = K.P1, phoneId = 'p1', conn = 'ph1') => {
    await core.requests.ildra_device_enroll({ devicePub: K.DEVK.pub }, remote('dev'))
    return core.requests.ildra_device_enroll_confirm({ ...signedConfirm(svc, signer.key, K.DEVK.pub, true, 'biometric', denyPub), from: { phoneId } }, remote(conn))
  }
  const ledger = async (since?: number, conn = 'ph1', phoneId = 'p1', asker = remote(conn)) =>
    core.requests.ildra_pairing_ledger({ ...(since !== undefined ? { since } : {}), from: { phoneId } }, asker)
  const unpair = (target: string, key: KeyObject, o: { conn?: string; phoneId?: string; at?: number; touchProof?: string } = {}) => {
    const at = o.at ?? clock.t
    return core.requests.ildra_pairing_unpair({ phoneId: target, at, signature: sig(key, unpairMessage(target, at)), ...(o.touchProof ? { touchProof: o.touchProof } : {}), from: { phoneId: o.phoneId ?? 'p1' } }, remote(o.conn ?? 'ph1'))
  }
  const answer = (req: AskRequest, conn: string, phoneId: string, approved: boolean, extra: Record<string, unknown> = {}) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved, holdMs: 2000, from: { phoneId }, ...extra }, remote(conn))
  /** A deny-key (or any key) signed answer. */
  const signed = (req: AskRequest, key: KeyObject, approved: boolean, o: { conn?: string; phoneId?: string; answerId?: string; sigApproved?: boolean } = {}) => {
    const answerId = o.answerId ?? aid()
    return core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId, approved, holdMs: 2000, from: { phoneId: o.phoneId ?? 'p1' },
      phoneSignature: sig(key, askAnswerMessage(o.sigApproved ?? approved, req.id, req.digest8, answerId)) }, remote(o.conn ?? 'ph1'))
  }
  const phoneAsk = async (action = 'Rename a file', available: ('phone' | 'touch' | 'voice')[] = ['phone']) => {
    const p = svc.ask(T, action, null, { kind, agentId: 'a', available }); await tick()
    return { p, req: sent.at(-1)! }
  }
  const kinds = () => svc.journal().pairingLedger.all().map((e) => e.kind)
  const readJ = () => JSON.parse(readFileSync(path, 'utf8'))
  const writeJ = (d: unknown) => writeFileSync(path, JSON.stringify(d))
  return { dir, clock, K, core, svc, sent, events, remote, local, pair, enrollDevice, ledger, unpair, answer, signed, phoneAsk, kinds, readJ, writeJ, path }
}
const reopen = (r: ReturnType<typeof rig>) => rig(r.dir, r.clock, r.K)
const ledgerHash = (prev: string, e: Record<string, unknown>): string => {
  const order = ['seq', 'at', 'kind', 'phoneId', 'fingerprint', 'oldFingerprint', 'by', 'via', 'reason', 'askId', 'verb', 'uv', 'count', 'since', 'source']
  const body: Record<string, unknown> = {}
  for (const k of order) if (e[k] !== undefined) body[k] = e[k]
  return createHash('sha256').update(`ildra-pairing-ledger:v1|${prev}|${JSON.stringify(body)}`, 'utf8').digest('hex')
}
/** Re-chain a ledger from genesis: what anyone who can write the journal can do (no key needed). */
const rechain = (entries: PairingLedgerEntry[]): PairingLedgerEntry[] => {
  let prev = '0'.repeat(64)
  return entries.map((e, i) => { const { prev: _p, hash: _h, ...base } = e; const b = { ...base, seq: i + 1 }; const hash = ledgerHash(prev, b); const out = { ...b, prev, hash } as PairingLedgerEntry; prev = hash; return out })
}

// ---------------------------------------------------------------------------------------------------------------
describe('Shield D: phone deny key (91c70791c)', () => {
  it('D1: a deny_only key settles only a Deny; Approve, settings.set, unpair, enroll.confirm, deny-key replace and an unknown verb are verifier_rejected and logged', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    expect(await r.enrollDevice(r.K.D1.pub)).toEqual({ ok: true, state: 'enrolled' })
    const { p, req } = await r.phoneAsk()
    expect(await r.signed(req, r.K.D1.key, true)).toEqual({ ok: false, reason: 'verifier_rejected' })
    // The deny key signing 'deny' but the answer saying approved: the verb follows the answer, so verifier_rejected.
    expect(await r.signed(req, r.K.D1.key, true, { sigApproved: false })).toMatchObject({ ok: false })
    // A forged keyRole in the payload is not copied into the answer.
    expect(await r.answer(req, 'ph1', 'p1', true, { keyRole: 'main', phoneSignature: 'AAAA' })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(r.svc.journal().ledger.toJSON().open.map((x) => x.id)).toContain(req.id)
    expect(await r.core.requests.ildra_settings_set({ key: 'ask.deviceWindowSec', value: 30, signature: sig(r.K.D1.key, settingsSetMessage('ask.deviceWindowSec', 30)), from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(await r.unpair('p2', r.K.D1.key)).toEqual({ ok: false, reason: 'verifier_rejected' })
    await r.core.requests.ildra_device_enroll({ devicePub: deviceKeyPair().pub }, r.remote('dev'))
    const pend = r.svc.journal().device.pending()!
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.K.D1.key, pend.devicePub, true), from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.K.D1.key, pend.devicePub, true, 'biometric', r.K.D2.pub), from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBe(r.K.D1.pub)
    // Unknown verbs: verifyPhone with any other verb string refuses the deny key.
    expect(r.svc.journal().pairing.verifyPhone('p1', 'main_key.rotate', 'x', sig(r.K.D1.key, 'x'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().pairing.verifyPhone('p1', 'something.new', 'x', sig(r.K.D1.key, 'x'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().pairing.verifierLog.map((e) => e.verb)).toEqual(expect.arrayContaining(['ask.approve', 'settings.set', 'pairing.unpair', 'device.enroll.confirm', 'deny_key.set', 'main_key.rotate', 'something.new']))
    expect(await r.signed(req, r.K.D1.key, false)).toEqual({ ok: true })
    expect(await p).toMatchObject({ approved: false })
  })

  it('D2: deny key only inside a main-key-signed confirm, one per phone, a new confirm replaces it; not equal to the main key; not set by an unpaired or other phone', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    // Unsigned deny_key / denyKey outside the signed message: grants nothing.
    await r.core.requests.ildra_device_enroll({ devicePub: r.K.DEVK.pub }, r.remote('dev'))
    const base = signedConfirm(r.svc, r.K.P1.key, r.K.DEVK.pub, true)
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...base, denyKey: r.K.D1.pub, from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
    // p2's key signing a confirm on p1's connection: refused.
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.K.P2.key, r.K.DEVK.pub, true, 'biometric', r.K.D1.pub), from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.K.P1.key, r.K.DEVK.pub, true, 'biometric', r.K.D1.pub), from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: true, state: 'enrolled' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBe(r.K.D1.pub)
    expect(r.svc.journal().pairing.denyKey('p2')).toBeNull()
    // A new main-key confirm replaces it; the old deny key no longer verifies.
    await r.core.requests.ildra_device_enroll({ devicePub: r.K.DEVK.pub }, r.remote('dev'))
    await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.K.P1.key, r.K.DEVK.pub, true, 'biometric', r.K.D2.pub), from: { phoneId: 'p1' } }, r.remote('ph1'))
    expect(r.svc.journal().pairing.denyKey('p1')).toBe(r.K.D2.pub)
    const { req } = await r.phoneAsk()
    expect(await r.signed(req, r.K.D1.key, false)).toEqual({ ok: false, reason: 'bad_signature' })
    // The main key as its own deny key is refused.
    expect(r.svc.journal().pairing.setDenyKey('p1', r.K.P1.pub)).toBe(false)
    expect(r.kinds().filter((k) => k === 'deny_key_set')).toHaveLength(2)
  })

  it('GAP D2a: a deny key in a confirm that fails setDenyKey (equal to the main key) still enrolls the device but answers malformed', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    expect(await r.enrollDevice(r.K.P1.pub)).toEqual({ ok: false, reason: 'malformed' })
    // Shield wants: refused before anything changes. Today the device is enrolled anyway.
    expect(r.svc.journal().device.device()).toBe(r.K.DEVK.pub)
  })

  it('D3: a Deny is bound to id, digest8 and answerId: replay, another Ask, another digest, after settle are refused or no-ops', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    const a = await r.phoneAsk(); const b = await r.phoneAsk()
    const answerId = aid()
    const body = { id: a.req.id, digest8: a.req.digest8, answerId, approved: false, holdMs: 2000, from: { phoneId: 'p1' }, phoneSignature: sig(r.K.D1.key, askAnswerMessage(false, a.req.id, a.req.digest8, answerId)) }
    // Moved to Ask b: signature over a's id.
    expect(await r.core.requests.ildra_ask_answer({ ...body, id: b.req.id, digest8: b.req.digest8 }, r.remote('ph1'))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.core.requests.ildra_ask_answer({ ...body, digest8: '00000000' }, r.remote('ph1'))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.core.requests.ildra_ask_answer({ ...body, answerId: aid() }, r.remote('ph1'))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.core.requests.ildra_ask_answer(body, r.remote('ph1'))).toEqual({ ok: true })
    expect(await a.p).toMatchObject({ approved: false })
    // Replay of the exact message after settle: nothing more is denied, nothing more is journaled as a deny-key Deny.
    const before = r.svc.journal().pairing.denyLog.length
    expect(await r.core.requests.ildra_ask_answer(body, r.remote('ph1'))).toMatchObject({ ok: false })
    expect(r.svc.journal().pairing.denyLog.length).toBe(before)
    // Ask b is untouched and still open.
    expect(r.svc.journal().ledger.toJSON().open.map((x) => x.id)).toContain(b.req.id)
  })

  it('D4: unpair and main-key rotation revoke the deny key in the same journal write; a restart does not bring it back', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub); await r.enrollDevice(r.K.D1.pub)
    // Rotation: p1 re-pairs with a new main key.
    const NEW = phoneKeyPair()
    r.pair('p1', NEW.pub)
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
    expect(r.readJ().pairing.denyKeys).toEqual({})
    expect(r.kinds().slice(-2)).toEqual(['deny_key_revoked', 'phone_rotated'])
    const r2 = reopen(r)
    expect(r2.svc.journal().pairing.denyKey('p1')).toBeNull()
    // Set again via p2, then unpair p2 through the locked_ask.
    await r2.core.requests.ildra_device_enroll({ devicePub: r.K.DEVK.pub }, r2.remote('dev'))
    expect(await r2.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r2.svc, r.K.P2.key, r.K.DEVK.pub, true, 'biometric', r.K.D2.pub), from: { phoneId: 'p2' } }, r2.remote('ph2'))).toEqual({ ok: true, state: 'enrolled' })
    const p = r2.unpair('p2', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' }); await tick()
    await r2.answer(r2.sent.at(-1)!, 'ph2', 'p2', true)
    expect(await p).toMatchObject({ ok: true, state: 'unpaired' })
    expect(r2.readJ().pairing.denyKeys).toEqual({})
    // A deny key edited back into the journal for an unpaired phone is not restored.
    const d = r2.readJ(); d.pairing.denyKeys = { p2: { pub: r.K.D2.pub, at: 1 } }; r2.writeJ(d)
    expect(reopen(r2).svc.journal().pairing.denyKey('p2')).toBeNull()
  })

  it('D5: every deny-key Deny is a ledger entry with source deny_key; more than 3 in 60 s gives one summary on the next phone open, then clears', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    for (let i = 0; i < 5; i++) { const { p, req } = await r.phoneAsk(); expect(await r.signed(req, r.K.D1.key, false)).toEqual({ ok: true }); await p; r.clock.t += 1000 }
    const denies = r.svc.journal().pairingLedger.all().filter((e) => e.kind === 'deny_key_deny')
    expect(denies).toHaveLength(5)
    for (const e of denies) expect(e).toMatchObject({ source: 'deny_key', phoneId: 'p1', via: 'phone' })
    const open1 = await r.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r.remote('ph1')) as { ok: true; denySummary: { count: number } | null }
    expect(open1.ok).toBe(true)
    expect(open1.denySummary!.count).toBeGreaterThan(3)
    expect(r.events.filter((e) => e.type === 'ildra.phone.deny_summary')).toHaveLength(1)
    expect(await r.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: true, denySummary: null })
    // Only the paired phone collects it.
    expect(await r.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r.remote('ph2'))).toMatchObject({ ok: false })
    expect(await r.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r.local())).toMatchObject({ ok: false })
  })

  it('D6: the deny key settles a locked_ask only as denied and has no device or voice path', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const lk = await r.phoneAsk('Brakes step')
    expect(lk.req).toMatchObject({ tier: 'locked_ask' })
    expect(await r.signed(lk.req, r.K.D1.key, true)).toEqual({ ok: false, reason: 'verifier_rejected' })
    // Off the phone path: the proven device sending a deny-key signature (touch) is verifier_rejected, logged.
    const t = await r.phoneAsk('Rename a file', ['touch'])
    expect(await r.signed(t.req, r.K.D1.key, false, { conn: 'dev' })).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(await r.core.requests.ildra_ask_answer({ id: t.req.id, digest8: t.req.digest8, answerId: aid(), approved: false, transcript: 'no', via: 'voice', phoneSignature: sig(r.K.D1.key, 'x') }, r.remote('dev'))).toMatchObject({ ok: false })
    expect(r.svc.journal().pairing.verifierLog.some((e) => e.verb.startsWith('answer.'))).toBe(true)
    expect(await r.signed(lk.req, r.K.D1.key, false)).toEqual({ ok: true })
    expect(await lk.p).toMatchObject({ approved: false })
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('Shield batch B: pairing ledger attacks (52977f9ac)', () => {
  const seeded = async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub); await r.enrollDevice(r.K.D1.pub)
    return r
  }

  it('GAP B1: truncating the tail (dropping the newest entries) is not detected: same phones, shorter ledger, recovered false', async () => {
    const r = await seeded()
    const d = r.readJ(); const n = d.pairingLedger.length
    d.pairingLedger = d.pairingLedger.slice(0, n - 2); r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(false)
    expect(r2.svc.journal().pairingLedger.all()).toHaveLength(n - 2)
    expect(r2.svc.journal().pairing.isPaired('p2')).toBe(true) // its phone_paired entry is gone
  })

  it('GAP B2: deleting the whole pairingLedger key is accepted silently (empty ledger, phones still paired)', async () => {
    const r = await seeded()
    const d = r.readJ(); delete d.pairingLedger; r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(false)
    expect(r2.svc.journal().pairingLedger.all()).toHaveLength(0)
    expect(r2.svc.journal().pairing.pairedCount()).toBe(2)
  })

  it('GAP B3: rewriting the tail and re-chaining from genesis needs no key and passes the chain check', async () => {
    const r = await seeded()
    const d = r.readJ()
    d.pairingLedger[d.pairingLedger.length - 1].phoneId = 'p9'
    d.pairingLedger = rechain(d.pairingLedger); r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(false)
    expect(r2.svc.journal().pairingLedger.all().at(-1)!.phoneId).toBe('p9')
  })

  it('GAP B4 (fork, App check): after a rewrite the phone gets a head that does not extend the head it read before; only the phone can tell', async () => {
    const r = await seeded()
    const first = await r.ledger() as { ok: true; head: { seq: number; hash: string } }
    const d = r.readJ(); d.pairingLedger[0].via = 'local_socket'; d.pairingLedger = rechain(d.pairingLedger); r.writeJ(d)
    const r2 = reopen(r)
    const later = await r2.ledger() as { ok: true; entries: PairingLedgerEntry[]; head: { seq: number; hash: string } }
    expect(later.head.seq).toBe(first.head.seq)
    expect(later.head.hash).not.toBe(first.head.hash) // same seq, other hash: a fork the daemon does not flag
    // An append-only reader that keeps (seq, hash) and asks since=seq gets entries whose first prev must equal its hash.
    r2.svc.journal().pairing.takeDenySummary('p1')
    const next = await r2.ledger(first.head.seq) as { entries: PairingLedgerEntry[] }
    expect(next.entries[0]!.prev).not.toBe(first.head.hash)
  })

  it('GAP B5: a broken chain "fails closed" only for voice: phones stay paired, the ledger restarts empty, and the unpair rate limit resets', async () => {
    const r = await seeded()
    for (let i = 0; i < UNPAIR_RATE; i++) { const p = r.unpair('p2', r.K.P1.key); await tick(); await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); await p; r.clock.t += 1000 }
    expect(await r.unpair('p2', r.K.P1.key)).toEqual({ ok: false, reason: 'rate_limited' })
    const d = r.readJ(); d.pairingLedger[1].phoneId = 'zz'; r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(true)
    expect(r2.svc.journal().pairing.pairedCount()).toBe(2)
    expect(r2.svc.journal().pairingLedger.all().length).toBeLessThan(3)
    const p = r2.unpair('p2', r.K.P1.key); await tick()
    expect(r2.sent.at(-1)).toMatchObject({ tier: 'locked_ask' }) // rate limit gone
    await r2.answer(r2.sent.at(-1)!, 'ph1', 'p1', false); await p
  })

  it('GAP B6: the ledger is not authoritative for state: a phone key added to the journal without a ledger entry is paired after restart', async () => {
    const r = await seeded()
    const EVIL = phoneKeyPair()
    const d = r.readJ(); d.pairing.phones.push('p9'); d.pairing.phoneKeys.p9 = EVIL.pub; r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(false)
    expect(r2.svc.journal().pairing.isPairedKey('p9', EVIL.pub)).toBe(true)
    expect(r2.svc.journal().pairingLedger.all().some((e) => e.phoneId === 'p9')).toBe(false)
  })

  it('rate limit holds across a restart and counts daemon-wide (p2 cannot add 3 more after p1 used 3)', async () => {
    const r = await seeded()
    for (let i = 0; i < UNPAIR_RATE; i++) { const p = r.unpair('p2', r.K.P1.key); await tick(); await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); await p }
    const r2 = reopen(r)
    expect(await r2.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' })).toEqual({ ok: false, reason: 'rate_limited' })
    r2.clock.t += 599_000
    expect(await r2.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' })).toEqual({ ok: false, reason: 'rate_limited' })
  })

  it('GAP B7 (Medium): two unpairs opened while two phones are paired both pass the last-owner check, so approving both leaves no phone and no touch proof was ever given', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub); await r.enrollDevice()
    const a = r.unpair('p2', r.K.P1.key); await tick(); const qa = r.sent.at(-1)!
    const b = r.unpair('p1', r.K.P1.key); await tick(); const qb = r.sent.at(-1)!
    expect(qa.id).not.toBe(qb.id)
    await r.answer(qa, 'ph1', 'p1', true); const ra = await a
    await r.answer(qb, 'ph1', 'p1', true); const rb = await b
    expect(ra).toMatchObject({ ok: true }); expect(rb).toMatchObject({ ok: true })
    expect(r.svc.journal().pairing.pairedCount()).toBe(0)
  })

  it('last owner: no device, a phone-made proof, a proof for another target or a stale at are refused; GAP B8: a valid touch proof is not single-use within 60 s', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice()
    const at = r.clock.t
    const proofTouch = sig(r.K.DEVK.key, unpairTouchMessage('p1', at))
    expect(await r.unpair('p1', r.K.P1.key, { at: at - 61_000, touchProof: sig(r.K.DEVK.key, unpairTouchMessage('p1', at - 61_000)) })).toEqual({ ok: false, reason: 'expired' })
    const p = r.unpair('p1', r.K.P1.key, { at, touchProof: proofTouch }); await tick()
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', true); expect(await p).toMatchObject({ ok: true })
    // Re-paired within the minute: the same captured proof opens another last-owner unpair.
    r.pair('p1', r.K.P1.pub)
    r.clock.t += 10_000
    const n = r.sent.length
    const q = r.unpair('p1', r.K.P1.key, { at, touchProof: proofTouch }); await tick()
    expect(r.sent.length).toBe(n + 1)
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); await q
  })

  it('only the paired phone reads the ledger and answered_by, or asks to unpair: observer, device, local socket, unknown connection refused', async () => {
    const r = await seeded()
    for (const asker of [r.remote('obs'), r.remote('dev'), r.local(), r.remote('nobody')]) {
      expect(await r.ledger(undefined, 'x', 'p1', asker)).toMatchObject({ ok: false })
      expect(await r.core.requests.ildra_ask_answered_by({ id: 'x', from: { phoneId: 'p1' } }, asker)).toMatchObject({ ok: false })
      expect(await r.core.requests.ildra_pairing_unpair({ phoneId: 'p2', at: r.clock.t, signature: sig(r.K.P1.key, unpairMessage('p2', r.clock.t)), from: { phoneId: 'p1' } }, asker)).toMatchObject({ ok: false })
    }
    expect(r.sent).toHaveLength(0)
  })

  it('SHARED-DATA: ledger and answered_by carry fingerprints, never raw keys, signatures or nonces', async () => {
    const r = await seeded()
    const { p, req } = await r.phoneAsk(); await r.signed(req, r.K.D1.key, false); await p
    const u = r.unpair('p2', r.K.P1.key); await tick(); await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); await u
    const got = await r.ledger() as { entries: PairingLedgerEntry[] }
    const page = JSON.stringify(got.entries.map(({ prev: _p, hash: _h, ...e }) => e))
    const ab = JSON.stringify(r.svc.journal().ledger.toJSON().answeredBy)
    for (const k of [r.K.P1, r.K.P2, r.K.D1, r.K.DEVK]) {
      expect(page).not.toContain(k.pub); expect(ab).not.toContain(k.pub)
      expect(page).toContain(deviceFingerprint(k.pub))
    }
    expect(page).not.toMatch(/[A-Za-z0-9+/]{43}=/) // no base64 32-byte value of any kind
    expect(page).not.toMatch(/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/) // no enroll nonce
    for (const e of (await r.ledger() as { entries: PairingLedgerEntry[] }).entries) for (const v of Object.values(e)) if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(64)
  })

  it('GAP B9 (Low): the ledger has no size bound; the device connection appends a verifier_rejected per message', async () => {
    const r = await seeded()
    const unproven = await r.core.requests.ildra_ask_answer({ id: aid(), digest8: '00000000', answerId: aid(), approved: false, holdMs: 2000, phoneSignature: 'AAAA' }, r.remote('dev'))
    expect(unproven).toMatchObject({ ok: false })
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const n = r.svc.journal().pairingLedger.all().length
    for (let i = 0; i < 300; i++) await r.core.requests.ildra_ask_answer({ id: aid(), digest8: '00000000', answerId: aid(), approved: false, holdMs: 2000, phoneSignature: 'AAAA' }, r.remote('dev'))
    expect(r.svc.journal().pairingLedger.all().length).toBe(n + 300)
    // And a pairing refusal stores the claimed phoneId at any length.
    r.svc.journal().pairing.offer('x'.repeat(5000), r.K.P2.pub, 'nope')
    expect(r.svc.journal().pairingLedger.all().at(-1)!.phoneId!.length).toBe(5000)
  })

  it('answered_by names the deny key for a deny-key Deny and the main key otherwise; a forged keyRole in the payload is ignored', async () => {
    const r = await seeded()
    const a = await r.phoneAsk()
    await r.core.requests.ildra_ask_answer({ id: a.req.id, digest8: a.req.digest8, answerId: aid(), approved: false, holdMs: 2000, from: { phoneId: 'p1' }, keyRole: 'deny_only' }, r.remote('ph1'))
    await a.p
    expect(r.svc.journal().ledger.answeredBy(a.req.id)).toMatchObject({ by: { kind: 'phone', key: 'main', fingerprint: deviceFingerprint(r.K.P1.pub) } })
    expect(r.svc.journal().pairing.denyLog).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// P-256 ECDSA phone keys (Build's next step). Prepared now; skips until core/ildraDeviceProof.ts exports verifyP256.
// Expected shape: verifyP256(pubBase64UncompressedPoint65, message, derSignatureBase64) => boolean, and
// PhonePairing.verifyPhone picking the algorithm from the stored key (never from the message).
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const verifyP256 = (proof as Record<string, unknown>).verifyP256 as ((pub: string, m: string, s: string) => boolean) | undefined
const p256 = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  return { pub: point.toString('base64'), point, key: privateKey }
}
const derInt = (v: bigint): Buffer => { let h = v.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b.length === 0) b = Buffer.from([0]); if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]) }
const der = (r: bigint, s: bigint): Buffer => { const body = Buffer.concat([derInt(r), derInt(s)]); return Buffer.concat([Buffer.from([0x30, body.length]), body]) }
const parseDer = (b: Buffer): { r: bigint; s: bigint } => {
  const rl = b[3]!; const r = BigInt('0x' + b.subarray(4, 4 + rl).toString('hex'))
  const sl = b[5 + rl]!; const s = BigInt('0x' + b.subarray(6 + rl, 6 + rl + sl).toString('hex'))
  return { r, s }
}
describe.skipIf(!verifyP256)('Shield P-256 phone keys (prepared; runs once Build exports verifyP256)', () => {
  const v = (pub: string, m: string, s: Buffer | string) => verifyP256!(pub, m, typeof s === 'string' ? s : s.toString('base64'))
  const M = 'ildra-ask-answer:v1|deny|id|00000000|answer'
  it('a normal signature verifies; another message or key does not', () => {
    const k = p256(); const s = sign('sha256', Buffer.from(M), k.key)
    expect(v(k.pub, M, s)).toBe(true)
    expect(v(k.pub, M + 'x', s)).toBe(false)
    expect(v(p256().pub, M, s)).toBe(false)
  })
  it('high-S is normalized and accepted (Apple does not promise low-S); both forms verify', () => {
    const k = p256(); const { r, s } = parseDer(sign('sha256', Buffer.from(M), k.key))
    const low = s > N / 2n ? N - s : s; const high = N - low
    expect(v(k.pub, M, der(r, low))).toBe(true)
    expect(v(k.pub, M, der(r, high))).toBe(true)
  })
  it.todo('high-S and low-S of one answer are the same answer: the second is replayed (single use keys on answerId, not signature bytes); needs Build\'s P-256 pairing helper')
  it('r or s equal to 0, equal to n or above n are refused', () => {
    const k = p256(); const { r, s } = parseDer(sign('sha256', Buffer.from(M), k.key))
    for (const [rr, ss] of [[0n, s], [r, 0n], [N, s], [r, N], [r + N, s], [r, s + N], [N + 1n, s]] as [bigint, bigint][]) expect(v(k.pub, M, der(rr, ss))).toBe(false)
  })
  it('strict DER: long-form length, non-minimal integers, a missing pad on a negative integer, trailing bytes, raw r||s and BER are refused', () => {
    const k = p256(); const good = sign('sha256', Buffer.from(M), k.key); const { r, s } = parseDer(good)
    const body = good.subarray(2)
    expect(v(k.pub, M, Buffer.concat([Buffer.from([0x30, 0x81, body.length]), body]))).toBe(false) // long-form length
    const pad = (x: bigint) => { const i = derInt(x); return Buffer.concat([Buffer.from([2, i[1]! + 1, 0]), i.subarray(2)]) }
    const np = Buffer.concat([pad(r), derInt(s)]); expect(v(k.pub, M, Buffer.concat([Buffer.from([0x30, np.length]), np]))).toBe(false) // extra 0x00
    expect(v(k.pub, M, Buffer.concat([good, Buffer.from([0])]))).toBe(false) // trailing byte
    const raw = Buffer.concat([Buffer.from(r.toString(16).padStart(64, '0'), 'hex'), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')])
    expect(v(k.pub, M, raw)).toBe(false) // IEEE P1363, not DER
    const rb = Buffer.from(r.toString(16).padStart(64, '0'), 'hex')
    if (rb[0]! & 0x80) { const neg = Buffer.concat([Buffer.from([2, 32]), rb, derInt(s)]); expect(v(k.pub, M, Buffer.concat([Buffer.from([0x30, neg.length]), neg]))).toBe(false) }
    expect(v(k.pub, M, Buffer.concat([Buffer.from([0x30, 0x80]), body, Buffer.from([0, 0])]))).toBe(false) // BER indefinite length
  })
  it('only a validated on-curve uncompressed point is a key: compressed, off-curve, infinity, wrong length and coordinates at or above p are refused', () => {
    const k = p256(); const s = sign('sha256', Buffer.from(M), k.key)
    const x = k.point.subarray(1, 33); const y = k.point.subarray(33)
    const comp = Buffer.concat([Buffer.from([2 + (y[31]! & 1)]), x])
    expect(v(comp.toString('base64'), M, s)).toBe(false)
    const off = Buffer.from(k.point); off[64] = off[64]! ^ 1
    expect(v(off.toString('base64'), M, s)).toBe(false)
    expect(v(Buffer.from([0]).toString('base64'), M, s)).toBe(false)
    expect(v(Buffer.alloc(65, 0).toString('base64'), M, s)).toBe(false)
    expect(v(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xff)]).toString('base64'), M, s)).toBe(false)
    expect(v(k.point.subarray(0, 64).toString('base64'), M, s)).toBe(false)
    expect(v(Buffer.concat([Buffer.from([6]), x, y]).toString('base64'), M, s)).toBe(false) // hybrid form
  })
  it('the algorithm is pinned to the stored key: an Ed25519 signature for a P-256 key and the reverse are refused', () => {
    const k = p256(); const ed = phoneKeyPair()
    expect(v(k.pub, M, sign(null, Buffer.from(M), ed.key))).toBe(false)
    expect(proof.verifyEd25519(ed.pub, M, sign('sha256', Buffer.from(M), k.key).toString('base64'))).toBe(false)
  })
})
