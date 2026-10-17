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
  const h = createHash('sha256').update(rawDeviceKey(pub) ?? Buffer.alloc(0)).digest()
  return (h.readBigUInt64BE(0) % 10_000_000_000_000_000n).toString().padStart(16, '0')
}
/** Batch A (Design Q55): how the paired phone verified its user for an enrollment confirm. */
export const ENROLL_UV = ['biometric', 'passcode'] as const
export type EnrollUv = (typeof ENROLL_UV)[number]
/**
 * Batch A: what the paired phone signs (Ed25519, its paired key, a key that needs user presence) to confirm or
 * decline a pending device enrollment. Every field is fixed-format, so '|' cannot be ambiguous.
 */
export function enrollConfirmMessage(devicePub: string, nonce: string, approved: boolean, uv: string): string {
  return `ildra-enroll-confirm:v1|${devicePub}|${nonce}|${approved ? 'approve' : 'decline'}|${uv}`
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

