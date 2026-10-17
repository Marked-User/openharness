/**
 * Shield, on fork 52977f9ac (Build batch A deny key 91c70791c plus batch B pairing ledger and unpair).
 * D1 to D6: the phone deny key conditions, as real tests (were it.todo in approvals.shield-r7.spec.ts).
 * B: attacks on the pairing ledger and the unpair API. A test named GAP asserts a weakness Shield reported
 * that is still there; when Build fixes it, flip the assertion and rename it FIXED.
 * P-256: Build f1911b9b4 exports verifyP256; these run against it and the daemon path verifyPhoneSignature.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import * as proof from '../core/ildraDeviceProof.js'
import { askAnswerMessage, denySummaryAckMessage, ledgerAckMessage, deviceFingerprint, settingsSetMessage, unpairMessage, unpairTouchMessage } from '../core/ildraDeviceProof.js'
import { createIldraAsk, UNPAIR_RATE, UNPAIR_WINDOW_MS } from './ildraAsk.js'
import { deviceKeyPair, phoneKeyPair, proveBridge, signedConfirm } from './ildraAsk.testkit.js'
import { MAX_PAIRING_LEDGER, stampManifest, type ApprovalTemplate, type AskRequest, type PairingLedgerEntry } from './approvals.js'

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
  const order = ['seq', 'at', 'kind', 'phoneId', 'fingerprint', 'oldFingerprint', 'by', 'via', 'reason', 'askId', 'verb', 'uv', 'count', 'since', 'source', 'keyAlg', 'oldHead']
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

  it('FIXED D2a: a deny key that setDenyKey would refuse (equal to the main key) refuses the whole confirm; nothing is enrolled', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    expect(await r.enrollDevice(r.K.P1.pub)).toEqual({ ok: false, reason: 'malformed' })
    expect(r.svc.journal().device.device()).toBeNull()
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

  it('D5: every deny-key Deny is a ledger entry with source deny_key; more than 3 in 60 s gives the summary on each phone open until the phone acknowledges it with its main key (Shield S1; the deny-key ack is GAP S1b below)', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    for (let i = 0; i < 5; i++) { const { p, req } = await r.phoneAsk(); expect(await r.signed(req, r.K.D1.key, false)).toEqual({ ok: true }); await p; r.clock.t += 1000 }
    const denies = r.svc.journal().pairingLedger.all().filter((e) => e.kind === 'deny_key_deny')
    expect(denies).toHaveLength(5)
    for (const e of denies) expect(e).toMatchObject({ source: 'deny_key', phoneId: 'p1', via: 'phone' })
    const open1 = await r.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r.remote('ph1')) as { ok: true; denySummary: { count: number; since: number } | null }
    expect(open1.ok).toBe(true)
    expect(open1.denySummary!.count).toBeGreaterThan(3)
    expect(r.events.filter((e) => e.type === 'ildra.phone.deny_summary')).toHaveLength(1)
    // Shield S1 (k): sending it no longer clears it; it is resent on each phone open until the phone's signed ack.
    expect(await r.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual(open1)
    const ackAt = r.clock.t; const since = open1.denySummary!.since
    expect(await r.core.requests.ildra_deny_summary_ack({ since, at: ackAt, phoneSignature: sig(r.K.P1.key, denySummaryAckMessage(since, ackAt)), from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: true })
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

  it('FIXED B1: truncating the tail (dropping the newest entries) breaks the host-keyed MAC: fail closed with ledger_reset, recovered true', async () => {
    const r = await seeded()
    const d = r.readJ(); const n = d.pairingLedger.length
    d.pairingLedger = d.pairingLedger.slice(0, n - 2); r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(true)
    expect(r2.svc.journal().pairingLedger.all()[0]).toMatchObject({ kind: 'ledger_reset', reason: 'mac_mismatch' })
    expect(r2.svc.journal().pairing.changeRefusal()).toBe('ledger_locked')
  })

  it('FIXED B2: deleting the whole pairingLedger key is detected (MAC mismatch), never accepted silently', async () => {
    const r = await seeded()
    const d = r.readJ(); delete d.pairingLedger; r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(true)
    expect(r2.svc.journal().pairingLedger.all()[0]).toMatchObject({ kind: 'ledger_reset', reason: 'mac_mismatch' })
    expect(r2.svc.journal().pairing.pairedCount()).toBe(2)
  })

  it('FIXED B3: rewriting the tail and re-chaining from genesis fails the MAC (the key lives outside the journal)', async () => {
    const r = await seeded()
    const d = r.readJ()
    d.pairingLedger[d.pairingLedger.length - 1].phoneId = 'p9'
    d.pairingLedger = rechain(d.pairingLedger); r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(true)
    expect(r2.svc.journal().pairingLedger.all()[0]).toMatchObject({ kind: 'ledger_reset', reason: 'mac_mismatch' })
    expect(r2.svc.journal().pairingLedger.all().some((e) => e.phoneId === 'p9')).toBe(false)
  })

  it('FIXED B4: after a rewrite the daemon flags it itself: a new chain starting with ledger_reset (oldHead = the untrusted head) and an ildra.pairing.ledger_reset alert', async () => {
    const r = await seeded()
    const first = await r.ledger() as { ok: true; head: { seq: number; hash: string } }
    const d = r.readJ(); d.pairingLedger[0].via = 'local_socket'; d.pairingLedger = rechain(d.pairingLedger); r.writeJ(d)
    const r2 = reopen(r)
    const later = await r2.ledger() as { ok: true; entries: PairingLedgerEntry[]; head: { seq: number; hash: string } }
    expect(later.head.hash).not.toBe(first.head.hash)
    expect(later.entries[0]).toMatchObject({ seq: 1, kind: 'ledger_reset', reason: 'mac_mismatch' })
    expect(r2.events.some((e) => e.type === 'ildra.pairing.ledger_reset')).toBe(true)
  })

  it('FIXED B5: a broken chain fails closed: phones stay paired, the ledger starts with a ledger_reset (never empty), the rate limit holds, pairing changes are locked until the phone acks', async () => {
    const r = await seeded()
    for (let i = 0; i < UNPAIR_RATE; i++) { const p = r.unpair('p2', r.K.P1.key); await tick(); await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); await p; r.clock.t += 1000 }
    expect(await r.unpair('p2', r.K.P1.key)).toEqual({ ok: false, reason: 'rate_limited' })
    const d = r.readJ(); d.pairingLedger[1].phoneId = 'zz'; r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(true)
    expect(r2.svc.journal().pairing.pairedCount()).toBe(2)
    const all = r2.svc.journal().pairingLedger.all()
    expect(all[0]!.kind).toBe('ledger_reset')
    // The kept state is recorded on the new chain (via ledger_reset), so the next load can check it.
    expect(all.slice(1).every((e) => e.via === 'ledger_reset')).toBe(true)
    const n = r2.sent.length
    expect(await r2.unpair('p2', r.K.P1.key)).toMatchObject({ ok: false })
    expect(r2.sent.length).toBe(n) // no locked_ask: locked and rate limited
  })

  it('FIXED B6: the ledger is authoritative for state: a phone key added to the journal without a ledger entry is dropped at load, recorded, voice off', async () => {
    const r = await seeded()
    const EVIL = phoneKeyPair()
    const d = r.readJ(); d.pairing.phones.push('p9'); d.pairing.phoneKeys.p9 = EVIL.pub; r.writeJ(d)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(true)
    expect(r2.svc.journal().pairing.isPairedKey('p9', EVIL.pub)).toBe(false)
    expect(r2.svc.journal().pairing.isPaired('p1')).toBe(true)
    expect(r2.svc.journal().pairingLedger.all().at(-1)).toMatchObject({ kind: 'pair_refused', phoneId: 'p9', reason: 'not_in_ledger', by: 'daemon' })
  })

  it('rate limit holds across a restart and counts daemon-wide (p2 cannot add 3 more after p1 used 3)', async () => {
    const r = await seeded()
    for (let i = 0; i < UNPAIR_RATE; i++) { const p = r.unpair('p2', r.K.P1.key); await tick(); await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); await p }
    const r2 = reopen(r)
    expect(await r2.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' })).toEqual({ ok: false, reason: 'rate_limited' })
    r2.clock.t += 599_000
    expect(await r2.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' })).toEqual({ ok: false, reason: 'rate_limited' })
  })

  it('FIXED B7 (Medium): one unpair open at a time, and the last-owner check runs again right before the unpair, so two phones never end at zero without a touch proof', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub); await r.enrollDevice()
    const a = r.unpair('p2', r.K.P1.key); await tick(); const qa = r.sent.at(-1)!
    const n = r.sent.length
    expect(await r.unpair('p1', r.K.P1.key)).toEqual({ ok: false, reason: 'unpair_pending' })
    expect(r.sent.length).toBe(n) // no second locked_ask
    await r.answer(qa, 'ph1', 'p1', true); expect(await a).toMatchObject({ ok: true })
    // Now the last phone: without a touch proof it is refused before any Ask.
    expect(await r.unpair('p1', r.K.P1.key)).toEqual({ ok: false, reason: 'last_owner_channel' })
    expect(r.svc.journal().pairing.pairedCount()).toBe(1)
  })

  it('last owner: no device, a phone-made proof, a proof for another target or a stale at are refused; FIXED B8: a valid touch proof is single use', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice()
    const at = r.clock.t
    const proofTouch = sig(r.K.DEVK.key, unpairTouchMessage('p1', at))
    expect(await r.unpair('p1', r.K.P1.key, { at: at - 61_000, touchProof: sig(r.K.DEVK.key, unpairTouchMessage('p1', at - 61_000)) })).toEqual({ ok: false, reason: 'expired' })
    const p = r.unpair('p1', r.K.P1.key, { at, touchProof: proofTouch }); await tick()
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', true); expect(await p).toMatchObject({ ok: true })
    // FIXED B8: re-paired within the minute, the same captured proof is spent: refused, no Ask opened.
    r.pair('p1', r.K.P1.pub)
    r.clock.t += 10_000
    const n = r.sent.length
    expect(await r.unpair('p1', r.K.P1.key, { at, touchProof: proofTouch })).toEqual({ ok: false, reason: 'last_owner_channel' })
    expect(r.sent.length).toBe(n)
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

  it('FIXED B9 (Low): the ledger is bounded: verifier_rejected entries from the device connection are coalesced; a claimed phoneId over 64 is refused and cut in the ledger', async () => {
    const r = await seeded()
    const unproven = await r.core.requests.ildra_ask_answer({ id: aid(), digest8: '00000000', answerId: aid(), approved: false, holdMs: 2000, phoneSignature: 'AAAA' }, r.remote('dev'))
    expect(unproven).toMatchObject({ ok: false })
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const n = r.svc.journal().pairingLedger.all().length
    for (let i = 0; i < 300; i++) await r.core.requests.ildra_ask_answer({ id: aid(), digest8: '00000000', answerId: aid(), approved: false, holdMs: 2000, phoneSignature: 'AAAA' }, r.remote('dev'))
    expect(r.svc.journal().pairingLedger.all().length).toBeLessThanOrEqual(n + 5)
    r.svc.journal().pairing.offer('x'.repeat(5000), r.K.P2.pub, 'nope')
    expect(r.svc.journal().pairingLedger.all().at(-1)!.phoneId!.length).toBeLessThanOrEqual(64)
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
  it('high-S and low-S of one answer are the same answer: the second copy is refused (single use keys on answerId, not signature bytes)', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    const { p, req } = await r.phoneAsk()
    const answerId = aid()
    const m = askAnswerMessage(false, req.id, req.digest8, answerId)
    const d = parseDer(sign('sha256', Buffer.from(m), r.K.D1.key))
    const low = d.s > N / 2n ? N - d.s : d.s
    const body = (s: bigint) => ({ id: req.id, digest8: req.digest8, answerId, approved: false, holdMs: 2000, from: { phoneId: 'p1' }, phoneSignature: der(d.r, s).toString('base64') })
    expect(await r.core.requests.ildra_ask_answer(body(N - low), r.remote('ph1'))).toEqual({ ok: true })
    await p
    expect(await r.core.requests.ildra_ask_answer(body(low), r.remote('ph1'))).toMatchObject({ ok: false })
    expect(r.svc.journal().pairing.denyLog).toHaveLength(1)
  })
  it('the daemon phone path (verifyPhoneSignature) follows the same rules, and also takes raw r||s', () => {
    const vps = (proof as Record<string, unknown>).verifyPhoneSignature as (p: string, m: string, s: string) => boolean
    const k = p256(); const pub = k.point.toString('base64url'); const { r, s } = parseDer(sign('sha256', Buffer.from(M), k.key))
    const low = s > N / 2n ? N - s : s
    expect(vps(pub, M, der(r, low).toString('base64'))).toBe(true)
    expect(vps(pub, M, der(r, N - low).toString('base64'))).toBe(true)
    expect(vps(pub, M, Buffer.concat([Buffer.from(r.toString(16).padStart(64, '0'), 'hex'), Buffer.from((N - low).toString(16).padStart(64, '0'), 'hex')]).toString('base64'))).toBe(true)
    for (const [rr, ss] of [[0n, s], [r, 0n], [N, s], [r, N]] as [bigint, bigint][]) expect(vps(pub, M, der(rr, ss).toString('base64'))).toBe(false)
    const off = Buffer.from(k.point); off[64] = off[64]! ^ 1
    expect(vps(off.toString('base64url'), M, der(r, low).toString('base64'))).toBe(false)
    expect(vps(k.point.toString('base64'), M, der(r, low).toString('base64'))).toBe(false) // stored keys are base64url only
    const ed = phoneKeyPair()
    expect(vps(pub, M, sign(null, Buffer.from(M), deviceKeyPair().key).toString('base64'))).toBe(false)
    void ed
  })
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

// ---------------------------------------------------------------------------------------------------------------
describe('Shield batch B round 2: attacks on the fixes (b5279a562)', () => {
  const seeded = async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub); await r.enrollDevice(r.K.D1.pub)
    return r
  }
  /** Append n state entries fast (no journal write per entry), then one write. */
  const fill = (r: ReturnType<typeof rig>, n: number, kind: 'phone_open' = 'phone_open') => {
    const L = r.svc.journal().pairingLedger; const oc = L.onChange; L.onChange = undefined
    for (let i = 0; i < n; i++) L.append({ kind, phoneId: 'p1', by: 'p1', via: 'phone' })
    L.onChange = oc; oc?.()
  }
  const reset = async () => {
    const r = await seeded(); const d = r.readJ(); d.pairingLedger[1].phoneId = 'zz'; r.writeJ(d)
    return reopen(r)
  }
  const ack = (r: ReturnType<typeof rig>, key = r.K.P1.key, phoneId = 'p1', conn = 'ph1') => {
    const e = r.svc.journal().pairingLedger.pendingReset()!
    return r.core.requests.ildra_pairing_ledger_ack({ seq: e.seq, hash: e.hash, signature: sig(key, ledgerAckMessage(e.seq, e.hash)), from: { phoneId } }, r.remote(conn))
  }

  // --- HMAC key ---
  it('GAP R1 (Medium): rolling the whole journal back to an older copy passes the chain and the MAC (the MAC binds the head, not its freshness): an unpaired phone comes back, no ledger_reset, recovered false', async () => {
    const r = await seeded()
    const old = readFileSync(r.path, 'utf8')
    const p = r.unpair('p2', r.K.P1.key); await tick(); await r.answer(r.sent.at(-1)!, 'ph1', 'p1', true); expect(await p).toMatchObject({ ok: true })
    expect(r.svc.journal().pairing.isPaired('p2')).toBe(false)
    writeFileSync(r.path, old)
    const r2 = reopen(r)
    expect(r2.svc.journal().recovered).toBe(false)
    expect(r2.svc.journal().pairing.isPaired('p2')).toBe(true)
    expect(r2.kinds()).not.toContain('ledger_reset')
  })

  it('HOLDS: key deleted with pairings present gives ledger_key_missing; a key moved away (another ledgerKeyPath) is the same; a non-hex or short MAC is mac_mismatch, never a throw', async () => {
    const r = await seeded()
    const { rmSync } = await import('node:fs')
    rmSync(join(r.dir, 'm', 'x.installed.ledger-key'))
    const r2 = reopen(r)
    expect(r2.svc.journal().pairingLedger.all()[0]).toMatchObject({ kind: 'ledger_reset', reason: 'ledger_key_missing' })
    expect(r2.svc.journal().pairing.changeRefusal()).toBe('ledger_locked')
    for (const mac of ['zz', 'ab', 'A'.repeat(64), 12345, null]) {
      const r3 = await seeded(); const d = r3.readJ(); d.pairingLedgerMac = mac; r3.writeJ(d)
      expect(reopen(r3).svc.journal().pairingLedger.all()[0]).toMatchObject({ kind: 'ledger_reset', reason: 'mac_mismatch' })
    }
  })

  it('NOTE: with the ledger, the pairings and the key all deleted (marker kept) the journal-missing path resets; with the marker also deleted it is a fresh install (no history to protect)', async () => {
    const r = await seeded()
    const { rmSync } = await import('node:fs')
    rmSync(join(r.dir, 'j'), { recursive: true }); rmSync(join(r.dir, 'm', 'x.installed.ledger-key'))
    expect(reopen(r).svc.journal().pairingLedger.all()[0]).toMatchObject({ kind: 'ledger_reset', reason: 'journal_missing' })
  })

  it('HOLDS: no reset loop: a restart after a reset (nothing tampered) does not reset again; the lock persists until the main-key ack, then clears', async () => {
    const r2 = await reset()
    const before = r2.svc.journal().pairingLedger.all().length
    const r3 = reopen(r2)
    expect(r3.svc.journal().pairingLedger.all().slice(before)).toEqual([])
    expect(r3.kinds().filter((k) => k === 'ledger_reset')).toHaveLength(1)
    expect(r3.svc.journal().recovered).toBe(false)
    expect(r3.svc.journal().pairing.changeRefusal()).toBe('ledger_locked')
    expect(await ack(r3, r3.K.D1.key)).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(await ack(r3)).toEqual({ ok: true })
    expect(reopen(r3).svc.journal().pairing.changeRefusal()).toBeNull()
  })

  it('HOLDS: the B5 lock never blocks Deny: a main-key Deny and a deny-key Deny settle while ledger_locked', async () => {
    const r2 = await reset()
    expect(r2.svc.journal().pairing.changeRefusal()).toBe('ledger_locked')
    const a = await r2.phoneAsk(); expect(await r2.answer(a.req, 'ph1', 'p1', false)).toEqual({ ok: true }); expect(await a.p).toMatchObject({ approved: false })
    const b = await r2.phoneAsk(); expect(await r2.signed(b.req, r2.K.D1.key, false)).toEqual({ ok: true }); expect(await b.p).toMatchObject({ approved: false })
  })

  it('GAP RULING-1 (new ruling to Build): after a reset every phone is Deny only until re-confirmed with a fresh device presence bound to its fingerprint; today an Approve still settles', async () => {
    const r2 = await reset()
    const a = await r2.phoneAsk()
    expect(await r2.answer(a.req, 'ph1', 'p1', true)).toEqual({ ok: true }) // ruling: { ok: false, reason: 'phone_suspended' }
    expect(await a.p).toMatchObject({ approved: true })
  })

  it('GAP RULING-2 (new ruling to Build): ledger_ack needs device presence too; today the main-key signature alone clears the lock, and any paired phone (also a stolen one) may send it', async () => {
    const r2 = await reset()
    expect(await ack(r2, r2.K.P2.key, 'p2', 'ph2')).toEqual({ ok: true }) // ruling: presence_missing until a device presence for p2's fingerprint
    expect(r2.svc.journal().pairing.changeRefusal()).toBeNull()
    expect(r2.kinds()).not.toContain('device_presence')
  })

  // --- B7 ---
  it('HOLDS B7: two unpairs fired in the same tick: exactly one opens an Ask, the other is unpair_pending (check and set have no await between them)', async () => {
    const r = await seeded()
    const n = r.sent.length
    const a = r.unpair('p2', r.K.P1.key); const b = r.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' })
    expect(await b).toEqual({ ok: false, reason: 'unpair_pending' })
    await tick(); expect(r.sent.length).toBe(n + 1)
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); expect(await a).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(r.svc.journal().pairing.pairedCount()).toBe(2)
  })

  it('GAP B7b (Medium): a paired phone (say a stolen one) blocks its own removal: its unpair requests, each denied, use the daemon-wide limit, so the owner phone is rate_limited (and unpair_pending while one is open); there is no other revoke path', async () => {
    const r = await seeded()
    for (let i = 0; i < UNPAIR_RATE; i++) {
      const p = r.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' }); await tick()
      if (i === 0) expect(await r.unpair('p2', r.K.P1.key)).toEqual({ ok: false, reason: 'unpair_pending' })
      await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); await p; r.clock.t += 1000
    }
    expect(await r.unpair('p2', r.K.P1.key)).toEqual({ ok: false, reason: 'rate_limited' })
    r.clock.t += UNPAIR_WINDOW_MS
    // Next window: the stolen phone goes first again.
    const p = r.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' }); await tick()
    expect(await r.unpair('p2', r.K.P1.key)).toEqual({ ok: false, reason: 'unpair_pending' })
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); await p
    expect(r.svc.journal().pairing.isPaired('p2')).toBe(true)
  })

  // --- D2a ---
  it('GAP D2a-2 (Low): with the ledger three short of full, a confirm carrying a deny key enrolls the device, then setDenyKey hits ledger_full: the reply is malformed but the device stays enrolled with no deny key', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    fill(r, MAX_PAIRING_LEDGER - 3 - r.svc.journal().pairingLedger.all().length)
    expect(await r.enrollDevice(r.K.D1.pub)).toEqual({ ok: false, reason: 'malformed' })
    expect(r.svc.journal().device.device()).not.toBeNull() // fix: null (check room for both entries first, or set the deny key before the device)
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
  })

  // --- B8 ---
  it('HOLDS B8: a spent touch proof is refused on a new connection and after a restart; one signed before a ledger reset is refused', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice()
    const at = r.clock.t; const tp = sig(r.K.DEVK.key, unpairTouchMessage('p1', at))
    const p = r.unpair('p1', r.K.P1.key, { at, touchProof: tp }); await tick(); await r.answer(r.sent.at(-1)!, 'ph1', 'p1', true); expect(await p).toMatchObject({ ok: true })
    r.pair('p1', r.K.P1.pub); r.clock.t += 5000
    const r2 = reopen(r)
    expect(await r2.unpair('p1', r.K.P1.key, { at, touchProof: tp })).toEqual({ ok: false, reason: 'last_owner_channel' })
    // A proof never used, signed before a reset.
    const at2 = r2.clock.t; const tp2 = sig(r2.K.DEVK.key, unpairTouchMessage('p1', at2))
    r2.clock.t += 1000
    const d = r2.readJ(); d.pairingLedger[0].at += 1; r2.writeJ(d)
    const r3 = reopen(r2); await ack(r3)
    expect(await r3.unpair('p1', r3.K.P1.key, { at: at2, touchProof: tp2 })).toMatchObject({ ok: false })
  })

  // --- B9 ---
  it('HOLDS B9: a proven device connection claiming a new phoneId each time is still coalesced (the key does not follow the claimed phoneId)', async () => {
    const r = await seeded()
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const n = r.svc.journal().pairingLedger.all().length
    for (let i = 0; i < 200; i++) await r.core.requests.ildra_ask_answer({ id: aid(), digest8: '00000000', answerId: aid(), approved: false, holdMs: 2000, phoneSignature: 'AAAA', from: { phoneId: `x${i}` } }, r.remote('dev'))
    expect(r.svc.journal().pairingLedger.all().length - n).toBeLessThanOrEqual(5)
  })

  it('GAP B9c (Medium): the ledger never compacts: every phone open is a state entry, so ordinary use reaches ledger_full and then the owner cannot unpair a lost phone', async () => {
    const r = await seeded()
    fill(r, MAX_PAIRING_LEDGER - 2 - r.svc.journal().pairingLedger.all().length)
    expect(r.svc.journal().pairing.changeRefusal()).toBe('ledger_full')
    expect(await r.unpair('p2', r.K.P1.key)).toEqual({ ok: false, reason: 'ledger_full' })
  })

  it('HOLDS B9: a noise flood near the cap cannot evict state (the ledger is append only) and stops at MAX - reserve; Deny by the deny key still settles at the noise cap', async () => {
    const r = await seeded()
    const L = r.svc.journal().pairingLedger
    const oc = L.onChange; L.onChange = undefined
    for (let i = 0; L.all().length < MAX_PAIRING_LEDGER - 1000; i++) L.append({ kind: 'pair_refused', phoneId: `n${i}`, by: 'daemon', reason: 'bad_code' })
    expect(L.append({ kind: 'pair_refused', phoneId: 'late', by: 'daemon', reason: 'bad_code' })).toBeNull()
    L.onChange = oc
    expect(L.all().slice(0, 3).map((e) => e.kind)).toEqual(r.kinds().slice(0, 3))
    const { p, req } = await r.phoneAsk(); expect(await r.signed(req, r.K.D1.key, false)).toEqual({ ok: true }); expect(await p).toMatchObject({ approved: false })
    expect(r.kinds().at(-1)).toBe('deny_key_deny')
  })

  it('Deny at a full ledger: the deny-key Deny settles even when its deny_key_deny entry cannot be written', async () => {
    const r = await seeded()
    const { p, req } = await r.phoneAsk()
    fill(r, MAX_PAIRING_LEDGER - r.svc.journal().pairingLedger.all().length)
    const res = await r.signed(req, r.K.D1.key, false)
    expect(res).toEqual({ ok: true })
    expect(await p).toMatchObject({ approved: false })
  })

  // --- S3 paging ---
  it('HOLDS S3: paging always ends: nextSeq strictly grows, more is false on the last page, since past the head is empty with more false', async () => {
    const r = await seeded(); fill(r, 1234)
    const L = r.svc.journal().pairingLedger
    let since = 0; let pages = 0; let got = 0
    for (;;) {
      const pg = L.page(since); pages++; got += pg.entries.length
      if (!pg.more) { expect(pg.nextSeq).toBeUndefined(); break }
      expect(pg.nextSeq!).toBeGreaterThan(since); since = pg.nextSeq!
      expect(pages).toBeLessThan(10)
    }
    expect(got).toBe(L.head().seq)
    expect(L.page(L.head().seq + 50)).toMatchObject({ entries: [], more: false })
    expect(L.page(-5).entries[0]!.seq).toBe(1)
  })

  // --- S1 ack ---
  it('GAP S1b (Medium): the deny-only key can acknowledge the deny summary, so whoever holds it can Deny in a burst and then clear the warning the owner was meant to see', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    for (let i = 0; i < 5; i++) { const { p, req } = await r.phoneAsk(); await r.signed(req, r.K.D1.key, false); await p; r.clock.t += 1000 }
    const s = r.svc.journal().pairing.peekDenySummary('p1')!
    expect(await r.core.requests.ildra_deny_summary_ack({ since: s.since, at: r.clock.t, phoneSignature: sig(r.K.D1.key, denySummaryAckMessage(s.since, r.clock.t)), from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: true }) // fix: verifier_rejected
    expect(r.svc.journal().pairing.peekDenySummary('p1')).toBeNull()
  })

  it('GAP S1c (Low): an ack is not bound to the burst it saw (count, at) and its at is never checked, so a replay of an old ack clears a burst that kept going inside the same 60 s window (same since)', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    for (let i = 0; i < 5; i++) { const { p, req } = await r.phoneAsk(); await r.signed(req, r.K.D1.key, false); await p; r.clock.t += 1000 }
    const s = r.svc.journal().pairing.peekDenySummary('p1')!
    const msg = { since: s.since, at: r.clock.t, phoneSignature: sig(r.K.P1.key, denySummaryAckMessage(s.since, r.clock.t)), from: { phoneId: 'p1' } }
    expect(await r.core.requests.ildra_deny_summary_ack(msg, r.remote('ph1'))).toEqual({ ok: true })
    for (let i = 0; i < 5; i++) { const { p, req } = await r.phoneAsk(); await r.signed(req, r.K.D1.key, false); await p; r.clock.t += 1000 }
    const s2 = r.svc.journal().pairing.peekDenySummary('p1')!
    expect(s2.since).toBe(s.since); expect(s2.count).toBeGreaterThan(s.count)
    expect(await r.core.requests.ildra_deny_summary_ack(msg, r.remote('ph1'))).toEqual({ ok: true }) // fix: stale (bind count and at, or refuse at older than the burst's at)
    expect(r.svc.journal().pairing.peekDenySummary('p1')).toBeNull()
  })
})
