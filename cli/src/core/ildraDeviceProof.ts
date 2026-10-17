/**
 * Shield R7-1: the Ildra device key proof, shared by the core (core/ildraAsk.ts verifies it on the device
 * connection) and the Ask service (approvals.ts keeps the enrolled key). Ed25519, raw 32-byte public key in base64.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
export function rawDeviceKey(pub: unknown): Buffer | null {
  if (typeof pub !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(pub)) return null
  const b = Buffer.from(pub, 'base64')
  return b.length === 32 ? b : null
}
/**
 * Batch A: the device key's human-comparable code, shown on the unit and the phone ("do these match"):
 * SHA-256 over the raw 32-byte key, its first 8 bytes as a big-endian unsigned integer, mod 10^16, as 16
 * decimal digits (zero-padded), e.g. "0412993752801146". Surfaces show it as 4 groups of 4 ("0412 9937 5280 1146").
 */
export function deviceFingerprint(pub: string): string {
  // P-256 move: the same code for a phone key, over its raw 65-byte uncompressed point.
  const h = createHash('sha256').update(rawDeviceKey(pub) ?? rawPhoneKey(pub) ?? Buffer.alloc(0)).digest()
  return (h.readBigUInt64BE(0) % 10_000_000_000_000_000n).toString().padStart(16, '0')
}
/** Batch A (Design Q55): how the paired phone verified its user for an enrollment confirm. */
export const ENROLL_UV = ['biometric', 'passcode'] as const
export type EnrollUv = (typeof ENROLL_UV)[number]
/**
 * Batch A: what the paired phone signs (Ed25519, its paired key, a key that needs user presence) to confirm or
 * decline a pending device enrollment. Every field is fixed-format, so '|' cannot be ambiguous.
 */
export function enrollConfirmMessage(devicePub: string, nonce: string, approved: boolean, uv: string, denyKey?: string): string {
  // Shield deny-key condition 2: a deny key is accepted only inside a main-key-signed confirm, so it is signed too.
  return `ildra-enroll-confirm:v1|${devicePub}|${nonce}|${approved ? 'approve' : 'decline'}|${uv}${denyKey !== undefined ? `|deny=${denyKey}` : ''}`
}
/**
 * Shield deny key: what a phone key signs for an answer to one Ask. Bound to the request id, digest8 and the
 * single-use answerId (condition 3), so it cannot be replayed or moved to another Ask.
 */
export function askAnswerMessage(approved: boolean, id: string, digest8: string, answerId: string): string {
  return `ildra-ask-answer:v1|${approved ? 'approve' : 'deny'}|${id}|${digest8}|${answerId}`
}
/** Shield deny key: what a phone key signs for `ildra.settings.set` (optional today; the deny key never may). */
export function settingsSetMessage(key: string, value: unknown): string {
  return `ildra-settings-set:v1|${key}|${JSON.stringify(value)}`
}
/**
 * Shield deny key condition 1: every verb a phone key may sign. A deny-only key is valid for exactly one,
 * 'ask.deny' (on a pending Ask); every other verb, and any verb not listed here, is verifier_rejected.
 */
/** Batch B: what the requesting phone's main key signs to ask for an unpair (`at` within 60 s of the daemon's clock). */
export function unpairMessage(phoneId: string, at: number): string {
  return `ildra-pairing-unpair:v1|${phoneId}|${at}`
}
/** Batch B: what the enrolled device key signs after a physical touch to allow removing the last paired phone. */
export function unpairTouchMessage(phoneId: string, at: number): string {
  return `ildra-unpair-touch:v1|${phoneId}|${at}`
}
/** Shield B5: what the paired phone's main key signs to acknowledge a ledger_reset (its seq and hash). */
export function ledgerAckMessage(seq: number, hash: string): string {
  return `ildra-pairing-ledger-ack:v1|${seq}|${hash}`
}
export const PHONE_VERBS = ['ask.deny', 'ask.approve', 'settings.set', 'pairing.unpair', 'device.enroll.confirm', 'deny_key.set', 'main_key.rotate', 'pairing.ledger_ack'] as const
export type PhoneVerb = (typeof PHONE_VERBS)[number]
// ---- P-256 move: phone keys (main and deny) are Secure Enclave ECDSA P-256 with SHA-256 ----
// The algorithm is pinned to the stored key role, never read from a message: phone keys are P-256 only
// (verifyPhoneSignature), device keys Ed25519 only (verifyEd25519, verifyDeviceProof).
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const P256_HALF_N = P256_N >> 1n
const toBig = (b: Buffer): bigint => (b.length === 0 ? 0n : BigInt('0x' + b.toString('hex')))
const toBuf32 = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(64, '0'), 'hex')
const modP = (n: bigint): bigint => ((n % P256_P) + P256_P) % P256_P
/** Strict base64url, no padding, canonical (re-encodes to the same text). */
const b64url = (s: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  const b = Buffer.from(s, 'base64url')
  return b.toString('base64url') === s ? b : null
}
/** Strict standard base64 with padding, or strict base64url without; canonical either way. */
const b64any = (s: string): Buffer | null => {
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(s)) { const b = Buffer.from(s, 'base64'); if (b.toString('base64') === s) return b }
  return b64url(s)
}
/**
 * A phone public key: the uncompressed SEC1 point (0x04 || X || Y, 65 bytes) in base64url without padding
 * (87 characters). X and Y must be below p and on the curve (y^2 = x^3 - 3x + b mod p); the point at
 * infinity has no 65-byte form. Compressed (0x02/0x03), SPKI or any other wrapping is refused.
 */
export function rawPhoneKey(pub: unknown): Buffer | null {
  if (typeof pub !== 'string' || pub.length !== 87) return null
  const b = b64url(pub)
  return b ? phonePoint(b) : null
}
/** The 65-byte uncompressed point check shared by rawPhoneKey and verifyP256. */
function phonePoint(b: Buffer): Buffer | null {
  if (b.length !== 65 || b[0] !== 0x04) return null
  const x = toBig(b.subarray(1, 33)); const y = toBig(b.subarray(33, 65))
  if (x >= P256_P || y >= P256_P) return null
  if (modP(y * y) !== modP(x * x * x - 3n * x + P256_B)) return null
  return b
}
/** Strict DER ECDSA signature (no raw form): the shared parser behind normalizePhoneSignature. */
function parseDerSig(b: Buffer): { r: bigint; s: bigint } | null {
  if (b.length < 8 || b[0] !== 0x30 || b[1]! >= 0x80 || b[1] !== b.length - 2) return null
  const ri = derInt(b, 2); if (!ri) return null
  const si = derInt(b, ri.next); if (!si || si.next !== b.length) return null
  return { r: ri.v, s: si.v }
}
/** Strict DER INTEGER at `at`: short-form length 1..33, non-negative, no superfluous leading zero. */
function derInt(b: Buffer, at: number): { v: bigint; next: number } | null {
  if (b[at] !== 0x02) return null
  const len = b[at + 1]
  if (len === undefined || len < 1 || len > 33 || at + 2 + len > b.length) return null
  const body = b.subarray(at + 2, at + 2 + len)
  if (body[0]! & 0x80) return null
  if (body[0] === 0x00 && (len === 1 || !(body[1]! & 0x80))) return null
  return { v: toBig(body), next: at + 2 + len }
}
/**
 * Accept a phone signature as raw r||s (64 bytes) or strict DER (SEQUENCE of two INTEGERs, short-form lengths,
 * minimal integers, no trailing bytes), in base64 or base64url. Refuse r or s equal to 0 or at least n.
 * A high S (s > n/2) is normalized to n - s (Apple does not promise low-S), so both forms verify the same and
 * single-use (nonce, answerId) still stops a replayed copy. Returns the 64-byte low-S r||s, or null.
 */
export function normalizePhoneSignature(signature: unknown): Buffer | null {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 100) return null
  const b = b64any(signature)
  if (!b) return null
  let r: bigint; let s: bigint
  if (b.length === 64) { r = toBig(b.subarray(0, 32)); s = toBig(b.subarray(32)) }
  else { const d = parseDerSig(b); if (!d) return null; r = d.r; s = d.s }
  if (r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) return null
  if (s > P256_HALF_N) s = P256_N - s
  return Buffer.concat([toBuf32(r), toBuf32(s)])
}
/** True when `signature` is the stored phone key `pub`'s ECDSA P-256 / SHA-256 signature over the UTF-8 bytes of `message`. */
export function verifyPhoneSignature(pub: unknown, message: string, signature: unknown): boolean {
  return p256Verify(rawPhoneKey(pub), message, normalizePhoneSignature(signature))
}
/**
 * Shield's P-256 primitive: `pub` a 65-byte uncompressed point in canonical base64 or base64url (checked on the
 * curve like rawPhoneKey), `signature` strict DER only (base64 or base64url), r and s in [1, n-1], high S
 * normalized. The daemon's phone path (verifyPhoneSignature) also accepts raw r||s (Shield rule 4); stored keys
 * are always the base64url form.
 */
export function verifyP256(pub: unknown, message: string, signature: unknown): boolean {
  const pb = typeof pub === 'string' && pub.length <= 88 ? b64any(pub) : null
  const sb = typeof signature === 'string' && signature.length <= 100 ? b64any(signature) : null
  if (!pb || !sb || sb.length === 64) return false
  return p256Verify(phonePoint(pb), message, normalizePhoneSignature(sb.toString('base64')))
}
function p256Verify(raw: Buffer | null, message: string, sig: Buffer | null): boolean {
  if (!raw || !sig) return false
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' })
    return cryptoVerify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig)
  } catch { return false }
}

/** True when `signature` (base64) is `pub`'s Ed25519 signature over the UTF-8 bytes of `message`. */
export function verifyEd25519(pub: unknown, message: string, signature: unknown): boolean {
  const raw = rawDeviceKey(pub)
  if (!raw || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' })
    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'))
  } catch { return false }
}
/** What the device signs to prove it holds the enrolled key (Ed25519 over these UTF-8 bytes). */
export function deviceProofMessage(nonce: string): string { return `ildra-device-proof:v1:${nonce}` }
/** True when `signature` (base64) is the Ed25519 signature of deviceProofMessage(nonce) by `pub`. */
export function verifyDeviceProof(pub: string, nonce: string, signature: unknown): boolean {
  const raw = rawDeviceKey(pub)
  if (!raw || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' })
    return cryptoVerify(null, Buffer.from(deviceProofMessage(nonce), 'utf8'), key, Buffer.from(signature, 'base64'))
  } catch { return false }
}

