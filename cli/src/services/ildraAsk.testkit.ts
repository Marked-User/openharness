/**
 * Test helper (Shield R7-1): make the one device-role client of a test rig the enrolled Ildra device, as setup
 * does for real: an Ed25519 device key, its enrollment recorded and confirmed (in process here; on a daemon the
 * confirm comes only from the paired phone's key), then the connection signs a core nonce. Returns the device's
 * private key (a restarted core proves again with it), or null when the rig has no device-role client.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
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
export const phoneKeyPair = deviceKeyPair

/** Batch A: the signed `ildra.device.enroll.confirm` body for the journal's pending (or enrolled) enrollment. */
export function signedConfirm(svc: IldraAsk, phoneKey: KeyObject, devicePub: string, approved = true, uv: string = 'biometric', denyKey?: string): Record<string, unknown> {
  const d = svc.journal().device
  const nonce = d.pending()?.nonce ?? d.enrolled()?.nonce ?? 'none'
  const signature = sign(null, Buffer.from(enrollConfirmMessage(devicePub, nonce, approved, uv, denyKey), 'utf8'), phoneKey).toString('base64')
  return { devicePub, nonce, approved, uv, signature, ...(denyKey !== undefined ? { denyKey } : {}) }
}
