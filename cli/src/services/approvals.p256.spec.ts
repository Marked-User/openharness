/**
 * P-256 move (Shield rules on the Secure Enclave phone keys): phone keys (main and deny) are ECDSA P-256 / SHA-256,
 * device keys stay Ed25519. The algorithm is pinned to the stored key role. Keys are stored only as a parsed,
 * on-curve 65-byte uncompressed point. Signatures: raw r||s or strict DER, base64 or base64url; r, s in [1, n-1];
 * high S normalized (not refused), and single use still stops a high-S copy.
 */
import { createECDH, createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { askAnswerMessage, deviceFingerprint, enrollConfirmMessage, normalizePhoneSignature, rawPhoneKey, settingsSetMessage, unpairTouchMessage, verifyDeviceProof, verifyEd25519, verifyPhoneSignature } from '../core/ildraDeviceProof.js'
import { createIldraAsk } from './ildraAsk.js'
import { deviceKeyPair, phoneKeyPair, phoneSignRaw, proveBridge } from './ildraAsk.testkit.js'
import { PhonePairing, stampManifest, type ApprovalTemplate, type AskRequest } from './approvals.js'

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const hex32 = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(64, '0'), 'hex')
const big = (b: Buffer): bigint => BigInt('0x' + b.toString('hex'))
const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file'], locked_ask: ['Brakes step'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); for (let i = 0; i < 20; i++) await Promise.resolve() }

/** raw r||s (low S as signed, or forced) from a key. */
const rawSig = (key: KeyObject, m: string): Buffer => sign('sha256', Buffer.from(m, 'utf8'), { key, dsaEncoding: 'ieee-p1363' })
const lowRaw = (key: KeyObject, m: string): Buffer => { const r = rawSig(key, m); const s = big(r.subarray(32)); return s > N >> 1n ? Buffer.concat([r.subarray(0, 32), hex32(N - s)]) : r }
const flipS = (r: Buffer): Buffer => Buffer.concat([r.subarray(0, 32), hex32(N - big(r.subarray(32)))])
const highRaw = (key: KeyObject, m: string): Buffer => flipS(lowRaw(key, m))
const derInt = (b: Buffer): Buffer => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.subarray(i); if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]); return Buffer.concat([Buffer.from([2, v.length]), v]) }
const toDer = (raw: Buffer): Buffer => { const body = Buffer.concat([derInt(raw.subarray(0, 32)), derInt(raw.subarray(32))]); return Buffer.concat([Buffer.from([0x30, body.length]), body]) }

function rig() {
  const MAIN = phoneKeyPair(); const DENY = phoneKeyPair()
  const clock = { t: 1_000_000 }
  const dir = mkdtempSync(join(tmpdir(), 'build-p256-'))
  const clients: Record<string, IldraAskClient> = { ph: { identity: MAIN.pub, role: 'web' }, dev: { identity: DEV, role: 'device' } }
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:'), now: () => clock.t })
  const svc = createIldraAsk({ inputs: core, journalPath: join(dir, 'j', 'a.json'), markerPath: join(dir, 'm', 'x.installed'), now: () => clock.t })
  const sent: AskRequest[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  svc.events = () => {}
  const remote = (connection: string) => ({ local: false, owner: false, connection })
  const pair = (key = MAIN.pub) => { const p = svc.journal().pairing; const { code } = p.begin('touch'); return [p.offer('p1', key, code), p.confirm('p1', 'touch', true)] as const }
  const enroll = async (dev = deviceKeyPair()) => { await core.requests.ildra_device_enroll({ devicePub: dev.pub }, remote('dev')); return dev }
  const confirm = (dev: { pub: string }, signature: string, denyKey?: string) => {
    const d = svc.journal().device; const nonce = d.pending()?.nonce ?? d.enrolled()?.nonce ?? 'none'
    return { body: { devicePub: dev.pub, nonce, approved: true, uv: 'biometric', signature, ...(denyKey ? { denyKey } : {}), from: { phoneId: 'p1' } }, message: enrollConfirmMessage(dev.pub, nonce, true, 'biometric', denyKey) }
  }
  const answer = (req: AskRequest, approved: boolean, signature: string, answerId: string) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId, approved, holdMs: 2000, from: { phoneId: 'p1' }, phoneSignature: signature }, remote('ph'))
  const phoneAsk = () => svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['phone'] })
  return { dir, clock, core, svc, sent, remote, pair, enroll, confirm, answer, phoneAsk, MAIN, DENY, journal: () => readFileSync(join(dir, 'j', 'a.json'), 'utf8') }
}

describe('P-256 keys: only a parsed, on-curve, 65-byte uncompressed point (Shield rule 3)', () => {
  it('accepts the uncompressed SEC1 point in base64url; refuses compressed, SPKI, base64 padding, off-curve, x or y >= p, infinity, Ed25519', () => {
    const k = phoneKeyPair()
    const raw = Buffer.from(k.pub, 'base64url')
    expect(raw.length).toBe(65); expect(raw[0]).toBe(4); expect(k.pub).toMatch(/^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/)
    expect(rawPhoneKey(k.pub)?.equals(raw)).toBe(true)
    const e = createECDH('prime256v1'); e.generateKeys()
    expect(rawPhoneKey((e.getPublicKey(null as never, 'compressed') as Buffer).toString('base64url'))).toBeNull()
    expect(rawPhoneKey((e.getPublicKey(null as never, 'hybrid') as Buffer).toString('base64url'))).toBeNull()
    const spki = (generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    expect(rawPhoneKey(spki.toString('base64url'))).toBeNull()
    expect(rawPhoneKey(spki.subarray(spki.length - 65).toString('base64'))).toBeNull() // standard base64, padded
    const off = Buffer.from(raw); off[64] ^= 1
    expect(rawPhoneKey(off.toString('base64url'))).toBeNull()
    const big = Buffer.concat([Buffer.from([4]), hex32(P), raw.subarray(33)])
    expect(rawPhoneKey(big.toString('base64url'))).toBeNull()
    expect(rawPhoneKey(Buffer.alloc(65).toString('base64url'))).toBeNull() // 0x00..., and (0,0) is not on the curve
    expect(rawPhoneKey(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url'))).toBeNull()
    expect(rawPhoneKey(Buffer.from([0]).toString('base64url'))).toBeNull() // the point at infinity
    expect(rawPhoneKey(deviceKeyPair().pub)).toBeNull()
  })
  it('pairing refuses an Ed25519 phone key, a compressed point, a wrong-curve (secp256k1) point and SPKI with bad_phone_key; a P-256 point pairs, keyAlg p256 set by the daemon', () => {
    const p = new PhonePairing()
    const k1 = createECDH('secp256k1'); k1.generateKeys()
    const e = createECDH('prime256v1'); e.generateKeys()
    const spki = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer
    for (const bad of [deviceKeyPair().pub, (e.getPublicKey(null as never, 'compressed') as Buffer).toString('base64url'), (k1.getPublicKey() as Buffer).toString('base64url'), spki.toString('base64url'), spki.toString('base64')]) {
      const { code } = p.begin('touch')
      expect(p.offer('p1', bad, code)).toEqual({ ok: false, reason: 'bad_phone_key' })
    }
    expect(p.isPaired('p1')).toBe(false)
    const k = phoneKeyPair(); const { code } = p.begin('touch')
    expect(p.offer('p1', k.pub, code).ok).toBe(true); expect(p.confirm('p1', 'touch', true)).toBe(true)
    expect(p.ledger.all().at(-1)).toMatchObject({ kind: 'phone_paired', keyAlg: 'p256', fingerprint: deviceFingerprint(k.pub) })
    expect(p.toJSON().keyAlg).toBe('p256')
  })
  it('a journal from before (an Ed25519 phone key) restores the phone as listed but unable to answer or sign; keyAlg in the record is never read back', () => {
    const old = deviceKeyPair()
    const p = new PhonePairing()
    p.restore({ phones: ['p1'], phoneKeys: { p1: old.pub }, keyAlg: 'ed25519' } as never)
    expect(p.isPaired('p1')).toBe(true)
    expect(p.isPairedKey('p1', old.pub)).toBe(false)
    const m = 'msg'; expect(p.verifyPhone('p1', 'ask.approve', m, sign(null, Buffer.from(m), old.key).toString('base64'))).toEqual({ ok: false, reason: 'unpaired_phone' })
  })
  it('the fingerprint is the same 16-digit code over the 65 raw bytes', () => {
    const k = phoneKeyPair()
    const h = createHash('sha256').update(Buffer.from(k.pub, 'base64url')).digest()
    expect(deviceFingerprint(k.pub)).toBe((h.readBigUInt64BE(0) % 10_000_000_000_000_000n).toString().padStart(16, '0'))
  })
})

describe('P-256 signatures: encodings, strict DER, r and s range, high S normalized (Shield rules 1, 4, 5)', () => {
  const k = phoneKeyPair(); const m = 'ildra-ask-answer:v1|deny|id|0011aabb|aid'
  it('raw r||s and DER, each in base64 and base64url, all verify over the exact UTF-8 bytes with SHA-256', () => {
    const raw = lowRaw(k.key, m); const der = toDer(raw)
    for (const s of [raw.toString('base64'), raw.toString('base64url'), der.toString('base64'), der.toString('base64url'), sign(null, Buffer.from(m), k.key).toString('base64'), phoneSignRaw(k.key, m)]) {
      expect(verifyPhoneSignature(k.pub, m, s), s).toBe(true)
    }
    expect(verifyPhoneSignature(k.pub, m + ' ', raw.toString('base64'))).toBe(false)
    expect(verifyPhoneSignature(k.pub, m, sign('sha512', Buffer.from(m), { key: k.key, dsaEncoding: 'ieee-p1363' }).toString('base64'))).toBe(false) // SHA-256 only
  })
  it('high S is accepted and normalized to n - s, in raw and DER; both normalize to the same 64 bytes', () => {
    const lo = lowRaw(k.key, m); const hi = flipS(lo)
    expect(big(hi.subarray(32)) > N >> 1n).toBe(true)
    expect(verifyPhoneSignature(k.pub, m, hi.toString('base64'))).toBe(true)
    expect(verifyPhoneSignature(k.pub, m, toDer(hi).toString('base64'))).toBe(true)
    expect(normalizePhoneSignature(hi.toString('base64'))!.equals(lo)).toBe(true)
    expect(normalizePhoneSignature(toDer(hi).toString('base64url'))!.equals(lo)).toBe(true)
  })
  it('r or s equal to 0 or at least n is bad, raw and DER', () => {
    const lo = lowRaw(k.key, m); const r = lo.subarray(0, 32); const s = lo.subarray(32)
    for (const [rr, ss] of [[hex32(0n), s], [r, hex32(0n)], [hex32(N), s], [r, hex32(N)], [hex32(N + 1n), s], [r, Buffer.alloc(32, 0xff)]] as const) {
      const raw = Buffer.concat([rr, ss])
      expect(normalizePhoneSignature(raw.toString('base64'))).toBeNull()
      expect(normalizePhoneSignature(toDer(raw).toString('base64'))).toBeNull()
      expect(verifyPhoneSignature(k.pub, m, raw.toString('base64'))).toBe(false)
    }
  })
  it('non-strict DER is bad: trailing bytes, long-form lengths, extra leading zero, negative integer, wrong lengths, other tags; also non-canonical base64 and other sizes', () => {
    const der = toDer(lowRaw(k.key, m))
    const r = derInt(lowRaw(k.key, m).subarray(0, 32)); const s = derInt(lowRaw(k.key, m).subarray(32))
    const seq = (body: Buffer, lenBytes?: Buffer) => Buffer.concat([Buffer.from([0x30]), lenBytes ?? Buffer.from([body.length]), body])
    const pad0 = (i: Buffer) => Buffer.concat([Buffer.from([2, i[1]! + 1, 0]), i.subarray(2)])
    const neg = (i: Buffer) => { const v = Buffer.from(i.subarray(2)); const body = v[0] === 0 ? v.subarray(1) : v; const b = Buffer.from(body); b[0] |= 0x80; return Buffer.concat([Buffer.from([2, b.length]), b]) }
    const bad = [
      Buffer.concat([der, Buffer.from([0])]), // trailing byte
      seq(Buffer.concat([r, s]), Buffer.from([0x81, r.length + s.length])), // long-form SEQUENCE length
      seq(Buffer.concat([Buffer.from([2, 0x81, r[1]!]), r.subarray(2), s])), // long-form INTEGER length
      seq(Buffer.concat([pad0(r), s])), // extra leading zero on r
      seq(Buffer.concat([r, pad0(s)])), // extra leading zero on s
      seq(Buffer.concat([neg(r), s])), // negative r
      seq(Buffer.concat([r, s, Buffer.from([2, 1, 1])])), // a third INTEGER inside
      Buffer.concat([Buffer.from([0x30, der[1]! + 1]), der.subarray(2)]), // length says more than there is
      Buffer.concat([Buffer.from([0x31]), der.subarray(1)]), // SET, not SEQUENCE
      seq(Buffer.concat([Buffer.from([3]), r.subarray(1), s])), // BIT STRING, not INTEGER
      lowRaw(k.key, m).subarray(0, 63), Buffer.concat([lowRaw(k.key, m), Buffer.from([0])]), // 63 and 65 raw bytes
    ]
    for (const b of bad) {
      expect(normalizePhoneSignature(b.toString('base64')), b.toString('hex')).toBeNull()
      expect(verifyPhoneSignature(k.pub, m, b.toString('base64'))).toBe(false)
    }
    const good = lowRaw(k.key, m).toString('base64')
    for (const s2 of [good.replace(/=+$/, ''), good + '=', ` ${good}`, good.replace(/\+/g, '-'), '', 'x'.repeat(200)]) {
      if (s2 === good.replace(/\+/g, '-') && !good.includes('+')) continue
      expect(verifyPhoneSignature(k.pub, m, s2), s2).toBe(false)
    }
    expect(verifyPhoneSignature(k.pub, m, Buffer.from(lowRaw(k.key, m)) as never)).toBe(false) // not a string
  })
})

describe('P-256 algorithm pinned to the stored key role (Shield rule 2)', () => {
  it('an Ed25519 signature against a phone key is bad_signature; a P-256 signature against the device key is refused (proof and touch proof)', () => {
    const main = phoneKeyPair(); const ed = deviceKeyPair()
    const p = new PhonePairing(); const { code } = p.begin('touch'); p.offer('p1', main.pub, code); p.confirm('p1', 'touch', true)
    const msg = askAnswerMessage(true, 'id', '0011aabb', 'aid')
    expect(p.verifyPhone('p1', 'ask.approve', msg, sign(null, Buffer.from(msg), ed.key).toString('base64'))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(p.verifyPhone('p1', 'ask.approve', msg, lowRaw(main.key, msg).toString('base64'))).toEqual({ ok: true, role: 'main' })
    // A P-256 key cannot stand in for a device key, nor a P-256 signature for an Ed25519 one.
    const tm = unpairTouchMessage('p1', 5)
    expect(verifyEd25519(main.pub, tm, lowRaw(main.key, tm).toString('base64'))).toBe(false)
    expect(verifyEd25519(ed.pub, tm, lowRaw(main.key, tm).toString('base64'))).toBe(false)
    expect(verifyDeviceProof(main.pub, 'n', lowRaw(main.key, 'ildra-device-proof:v1:n').toString('base64'))).toBe(false)
    // and an Ed25519 key cannot be a phone key, whatever signs
    expect(verifyPhoneSignature(ed.pub, tm, sign(null, Buffer.from(tm), ed.key).toString('base64'))).toBe(false)
  })
  it('a signature by a secp256k1 key (wrong curve) over the same bytes is bad_signature', () => {
    const main = phoneKeyPair(); const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey
    const p = new PhonePairing(); const { code } = p.begin('touch'); p.offer('p1', main.pub, code); p.confirm('p1', 'touch', true)
    const msg = settingsSetMessage('ask.deviceWindowSec', 45)
    expect(p.verifyPhone('p1', 'settings.set', msg, sign('sha256', Buffer.from(msg), { key: k1, dsaEncoding: 'ieee-p1363' }).toString('base64'))).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('a device enroll with a P-256 key is malformed; a deny key that is Ed25519 is malformed and nothing is installed', async () => {
    const r = rig(); r.pair()
    expect(await r.core.requests.ildra_device_enroll({ devicePub: phoneKeyPair().pub }, r.remote('dev'))).toMatchObject({ ok: false })
    const dev = await r.enroll()
    const edDeny = deviceKeyPair().pub
    const c = r.confirm(dev, '', edDeny); c.body.signature = lowRaw(r.MAIN.key, c.message).toString('base64')
    expect(await r.core.requests.ildra_device_enroll_confirm(c.body, r.remote('ph'))).toEqual({ ok: false, reason: 'malformed' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
  })
})

describe('P-256 runtime: confirm, answers, deny key; single use stops a high-S copy (Shield rule 1)', () => {
  it('enroll.confirm signed raw r||s (base64url) installs a P-256 deny key; a high-S copy of the spent confirm is refused (nonce single use)', async () => {
    const r = rig(); r.pair()
    const dev = await r.enroll()
    const c = r.confirm(dev, '', r.DENY.pub)
    const lo = lowRaw(r.MAIN.key, c.message)
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...c.body, signature: lo.toString('base64url') }, r.remote('ph'))).toEqual({ ok: true, state: 'enrolled' })
    expect(r.svc.journal().pairing.denyKey('p1')).toBe(r.DENY.pub)
    expect(r.svc.journal().pairing.ledger.all().find((e) => e.kind === 'deny_key_set')).toMatchObject({ keyAlg: 'p256', fingerprint: deviceFingerprint(r.DENY.pub) })
    expect(r.svc.journal().pairing.ledger.all().find((e) => e.kind === 'device_enrolled')).toMatchObject({ keyAlg: 'ed25519' })
    const hi = highRaw(r.MAIN.key, c.message)
    const again = await r.core.requests.ildra_device_enroll_confirm({ ...c.body, signature: toDer(hi).toString('base64') }, r.remote('ph'))
    expect(again).toEqual({ ok: false, reason: 'unknown_id' })
    expect(r.svc.journal().device.enrolled()?.pub).toBe(dev.pub)
  })
  it('a phone answer with a high-S DER signature settles; the high-S copy of a used answer (same answerId) is replayed, never a second settle', async () => {
    const r = rig(); r.pair()
    const pa = r.phoneAsk(); await tick()
    const req = r.sent.at(-1)!
    const answerId = aid()
    const msg = askAnswerMessage(true, req.id, req.digest8, answerId)
    const lo = lowRaw(r.MAIN.key, msg); const hi = flipS(lo)
    expect(await r.answer(req, true, toDer(hi).toString('base64'), answerId)).toEqual({ ok: true })
    expect(await pa).toMatchObject({ approved: true })
    // Both forms of the spent answer: replayed, never a second outcome.
    for (const s of [hi.toString('base64'), lo.toString('base64url'), toDer(lo).toString('base64')]) {
      expect(await r.answer(req, true, s, answerId)).toEqual({ ok: false, reason: 'replayed' })
    }
    // On a fresh Ask that is still open, the high-S copy of the first answer cannot settle it either (bound to id and answerId).
    const pb = r.phoneAsk(); await tick()
    const req2 = r.sent.at(-1)!
    expect(await r.answer(req2, true, hi.toString('base64'), answerId)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(r.svc.journal().ledger.pending()).toBe(1)
    const a2 = aid()
    expect(await r.answer(req2, false, lowRaw(r.MAIN.key, askAnswerMessage(false, req2.id, req2.digest8, a2)).toString('base64'), a2)).toMatchObject({ ok: true })
    await pb
  })
  it('a deny-key Deny with a high-S raw signature settles once; its high-S and low-S copies with the same answerId do not settle again', async () => {
    const r = rig(); r.pair()
    const dev = await r.enroll()
    const c = r.confirm(dev, '', r.DENY.pub)
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...c.body, signature: toDer(lowRaw(r.MAIN.key, c.message)).toString('base64') }, r.remote('ph'))).toEqual({ ok: true, state: 'enrolled' })
    await proveBridge(r.core, 'dev', dev.key)
    const pa = r.phoneAsk(); await tick()
    const req = r.sent.at(-1)!
    const answerId = aid()
    const msg = askAnswerMessage(false, req.id, req.digest8, answerId)
    expect(await r.answer(req, false, highRaw(r.DENY.key, msg).toString('base64'), answerId)).toEqual({ ok: true })
    expect(await pa).toMatchObject({ approved: false })
    expect(r.svc.journal().pairing.denyLog).toHaveLength(1)
    for (const s of [lowRaw(r.DENY.key, msg).toString('base64'), highRaw(r.DENY.key, msg).toString('base64url')]) expect(await r.answer(req, false, s, answerId)).toEqual({ ok: false, reason: 'replayed' })
    expect(r.svc.journal().pairing.denyLog).toHaveLength(1)
    // The deny key never approves, in any encoding.
    const pb = r.phoneAsk(); await tick()
    const req2 = r.sent.at(-1)!; const a2 = aid()
    const am = askAnswerMessage(true, req2.id, req2.digest8, a2)
    expect(await r.answer(req2, true, highRaw(r.DENY.key, am).toString('base64'), a2)).toEqual({ ok: false, reason: 'verifier_rejected' })
    const a3 = aid()
    expect(await r.answer(req2, false, lowRaw(r.MAIN.key, askAnswerMessage(false, req2.id, req2.digest8, a3)).toString('base64'), a3)).toMatchObject({ ok: true })
    await pb
  })
  it('the journal keeps the P-256 key, the session binding and keyAlg p256; a restored pairing still verifies the phone', async () => {
    const r = rig(); r.pair()
    const text = r.journal()
    expect(text).toContain(r.MAIN.pub)
    expect(text).toContain('"keyAlg":"p256"')
    const j = JSON.parse(text) as { pairing: Parameters<PhonePairing['restore']>[0] }
    const p = new PhonePairing(); p.restore(j.pairing)
    expect(p.isPairedKey('p1', r.MAIN.pub)).toBe(true)
    const m = settingsSetMessage('ask.deviceWindowSec', 60)
    expect(p.verifyPhone('p1', 'settings.set', m, highRaw(r.MAIN.key, m).toString('base64'))).toEqual({ ok: true, role: 'main' })
  })
})

describe('P-256 wire', () => {
  it('PhonePub and PhoneSignature in the schema: P-256 points only, raw or DER in base64 or base64url; keyAlg is not an input', () => {
    const Ajv2020Module = require('ajv/dist/2020.js') as { default?: unknown }
    const Ajv2020 = (Ajv2020Module.default ?? Ajv2020Module) as new (o: object) => import('ajv').default
    const schema = JSON.parse(readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true }); ajv.addSchema(schema)
    const env = (type: string, body: unknown): boolean => ajv.getSchema(schema.$id)!({ type, proto: 1, body }) as boolean
    const k = phoneKeyPair(); const m = 'x'
    const raw = lowRaw(k.key, m); const der = toDer(raw)
    expect(env('ildra.pairing.offer', { phoneId: 'p1', phonePub: k.pub, code: '123456' })).toBe(true)
    expect(env('ildra.pairing.offer', { phoneId: 'p1', phonePub: k.pub, code: '123456', keyAlg: 'p256' })).toBe(false)
    expect(env('ildra.pairing.offer', { phoneId: 'p1', phonePub: deviceKeyPair().pub, code: '123456' })).toBe(false)
    for (const s of [raw.toString('base64'), raw.toString('base64url'), der.toString('base64'), der.toString('base64url')]) {
      expect(env('ildra.pairing.unpair', { phoneId: 'p2', at: 1, signature: s }), s).toBe(true)
    }
    expect(env('ildra.pairing.unpair', { phoneId: 'p2', at: 1, signature: 'not base64!' })).toBe(false)
    expect(schema.$defs.PairingRefusalReason.enum).toContain('bad_phone_key')
    expect(schema.$defs.PairingLedgerEntry.properties.keyAlg.enum).toEqual(['p256', 'ed25519'])
  })
})
