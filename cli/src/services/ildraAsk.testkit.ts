/**
 * Test helper (Shield R7-1): make the one device-role client of a test rig the enrolled Ildra device, as setup
 * does for real: an Ed25519 device key, its enrollment recorded and confirmed (in process here; on a daemon the
 * confirm comes only from the paired phone's key), then the connection signs a core nonce. Returns the device's
 * private key (a restarted core proves again with it), or null when the rig has no device-role client.
 */
import { createECDH, createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { deviceProofMessage, enrollConfirmMessage } from '../core/api.js'
import type { IldraAsk } from './ildraAsk.js'

/** The two core calls a bridge uses to prove its key (core/ildraAsk.ts IldraAskCore). */
interface DeviceProver { challengeDevice(connId: string): string | null; proveDevice(connId: string, signature: unknown): boolean }

export function deviceKeyPair(): { pub: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { pub: der.subarray(der.length - 32).toString('base64'), key: privateKey }
}

/** Sign the core's nonce for `connId` with `key`; true when the core accepted the proof. */
export function proveBridge(core: DeviceProver, connId: string, key: KeyObject): boolean {
  const nonce = core.challengeDevice(connId)
  if (!nonce) return false
  return core.proveDevice(connId, sign(null, Buffer.from(deviceProofMessage(nonce), 'utf8'), key).toString('base64'))
}

export function enrollBridge(core: DeviceProver, svc: IldraAsk, clients: Record<string, { role?: string; identity?: string; shared?: boolean } | null>): KeyObject | null {
  const dev = Object.entries(clients).find(([, c]) => c?.role === 'device')
  if (!dev) return null
  const { pub, key } = deviceKeyPair()
  const j = svc.journal()
  const p = j.device.begin(pub)
  if (!p || j.device.confirm(pub, p.nonce, true, { uv: 'biometric', phoneId: 'testkit' }) !== 'enrolled') throw new Error('enrollBridge: enroll failed')
  if (!proveBridge(core, dev[0], key)) throw new Error('enrollBridge: proof failed')
  return key
}

/** Batch A: a real Ed25519 phone key (the paired phone signs enroll confirms with it). Same shape as deviceKeyPair. */
/**
 * P-256 move: a phone key (main or deny) as the phone sends it: the uncompressed SEC1 point (0x04 || X || Y),
 * base64url without padding. crypto.sign(null, data, key) with it gives an ECDSA P-256 / SHA-256 DER signature.
 */
export function phoneKeyPair(): { pub: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const j = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  return { pub: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url'), key: privateKey }
}
/**
 * P-256 move: a fixed, valid phone key for a fixture label (a P-256 point the pairing accepts, derived from the
 * label), replacing opaque placeholder keys such as 'pub1' that the pairing now refuses. Signs nothing.
 */
export function fixturePhonePub(label: string): string {
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
  const d = (BigInt('0x' + createHash('sha256').update(`ildra-fixture-phone|${label}`).digest('hex')) % (n - 1n)) + 1n
  const e = createECDH('prime256v1'); e.setPrivateKey(Buffer.from(d.toString(16).padStart(64, '0'), 'hex'))
  return e.getPublicKey().toString('base64url')
}
/** A raw r||s (IEEE P1363, 64 bytes) P-256 signature in base64, the other accepted encoding. */
export function phoneSignRaw(key: KeyObject, message: string): string {
  return sign('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }).toString('base64')
}

/** Batch A: the signed `ildra.device.enroll.confirm` body for the journal's pending (or enrolled) enrollment. */
export function signedConfirm(svc: IldraAsk, phoneKey: KeyObject, devicePub: string, approved = true, uv: string = 'biometric', denyKey?: string): Record<string, unknown> {
  const d = svc.journal().device
  const nonce = d.pending()?.nonce ?? d.enrolled()?.nonce ?? 'none'
  const signature = sign(null, Buffer.from(enrollConfirmMessage(devicePub, nonce, approved, uv, denyKey), 'utf8'), phoneKey).toString('base64')
  return { devicePub, nonce, approved, uv, signature, ...(denyKey !== undefined ? { denyKey } : {}) }
}
