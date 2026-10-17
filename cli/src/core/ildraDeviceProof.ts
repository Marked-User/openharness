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
/** Short fingerprint of a device key, shown on the device and the phone to compare (first 16 hex of SHA-256). */
export function deviceFingerprint(pub: string): string {
  return createHash('sha256').update(rawDeviceKey(pub) ?? Buffer.alloc(0)).digest('hex').slice(0, 16)
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

