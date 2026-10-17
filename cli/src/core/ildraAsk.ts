/**
 * Ildra Asks, the core's half: Shield F12 and F13 in the daemon's own input paths (security/FINDINGS.md).
 *
 * - `ildra_ask_answer` (core/api.ts ILDRA_ASK_REQUESTS): the origin of an answer is the connection the gateway
 *   authenticated (RemoteClient.identity, and `shared` from gateway/sharedTrust.ts), never the payload. A
 *   payload's `from.machinePub` and `from.shared` are dropped; only a phone id is kept, which the ledger checks
 *   against the journal's pairing. A connection the core does not know answers nothing. F12.
 * - `guard`: the terminal input path (lib/terminalStreamManager.ts `askPanes`) drops remote keystrokes and
 *   pastes to a pane while its agent waits on an Ask. F13.
 *
 * The Ask (ledger, journal, gate) is services/ildraAsk.ts; it reaches this through CoreApi.ildraAsk.
 */
import { randomBytes } from 'node:crypto'
import type { Asker, IldraAnswerOrigin, IldraAskInputs, IldraPaneGuard, ServiceRequest } from './api.js'
import { stampChannel } from './ildraChannel.js'
import { verifyDeviceProof } from './ildraDeviceProof.js'

export interface IldraAskClient {
  identity: string
  role: string
  shared?: boolean
}

/** Same behaviour as services/approvals.ts AskPaneGuard (the core may not load a service's code). */
class PaneGuard implements IldraPaneGuard {
  private readonly open_ = new Map<string, string>()
  open(paneId: string, requestId: string): void { this.open_.set(paneId, requestId) }
  close(paneId: string): void { this.open_.delete(paneId) }
  requestFor(paneId: string): string | null { return this.open_.get(paneId) ?? null }
  filterInput(paneId: string, from: 'local' | 'remote'): 'pass' | 'block' { return from === 'remote' && this.open_.has(paneId) ? 'block' : 'pass' }
}

/**
 * The reply to the answering connection. Every reason is an AskRejectionReason (protocol schema). no_authority:
 * the connection may not answer at all (local socket, observer, or a connection the core does not know); refused
 * here, before the ledger, so nothing is recorded. The ledger's own rejections reach the surface as
 * ildra.ask.attempt / ildra.ask.outcome events.
 */
export type IldraAnswerReply = { ok: true } | { ok: false; reason: 'malformed' | 'unknown_id' | 'no_authority' | 'stale_channel' | 'replayed' | 'busy' | 'verifier_rejected' | 'bad_signature' }
export type IldraSettingsReply = { ok: true; key: string; value: number } | { ok: false; reason: string }

export interface IldraAskCore extends IldraAskInputs {
  readonly requests: {
    ildra_ask_answer: (payload: Record<string, unknown>, asker: Asker) => Promise<IldraAnswerReply>
    ildra_settings_set: (payload: Record<string, unknown>, asker: Asker) => Promise<IldraSettingsReply>
    ildra_device_enroll: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true; devicePub: string; fingerprint: string; nonce: string; expiresAt: number } | { ok: false; reason: string }>
    ildra_device_enroll_confirm: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true; state: string } | { ok: false; reason: string }>
    ildra_phone_open: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true; denySummary: { count: number; since: number; at: number } | null } | { ok: false; reason: string }>
    ildra_pairing_ledger: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true; entries: unknown[]; pageHead: string; more: boolean; nextSeq?: number; head: { seq: number; hash: string } } | { ok: false; reason: string }>
    ildra_pairing_unpair: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true; state: 'unpaired'; askId: string } | { ok: false; reason: string }>
    ildra_ask_answered_by: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true; answeredBy: unknown } | { ok: false; reason: string }>
    ildra_pairing_ledger_ack: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true } | { ok: false; reason: string }>
    ildra_ledger_confirm: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true; head: string; seq: number; at: number } | { ok: false; reason: string }>
    ildra_deny_summary_ack: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true } | { ok: false; reason: string }>
    ildra_device_challenge: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: true; nonce: string } | { ok: false; reason: string }>
    ildra_device_prove: (payload: Record<string, unknown>, asker: Asker) => Promise<{ ok: boolean; reason?: string }>
  } & Record<string, ServiceRequest>
  /** R7-1: a fresh nonce for a device-role connection to sign (what `ildra_device_challenge` does); null if refused. */
  challengeDevice(connId: string): string | null
  /** R7-1: the connection's Ed25519 signature over that nonce by the enrolled device key (`ildra_device_prove`). */
  proveDevice(connId: string, signature: unknown): boolean
  /** Audit and test hook: the answer as handed to the gate, origin already rewritten. */
  onAnswer?: (id: string, answer: Record<string, unknown>) => void
}

export function createIldraAskCore(deps: {
  clientOf: (connId: string) => IldraAskClient | null
  isLoopback: (connId: string) => boolean
  now?: () => number
}): IldraAskCore {
  const now = deps.now ?? Date.now
  const guard = new PaneGuard()
  const waiting = new Map<string, (answer: Record<string, unknown> | null) => void>()
  /** The gateway's word on each identity key that has answered. */
  const sharedByPub = new Map<string, boolean>()
  /** R7-1: device-role connections that proved the enrolled device key, with that key. */
  const bridges = new Map<string, string>()
  /** R7-1: one outstanding nonce per device-role connection (60 s, single use). */
  const nonces = new Map<string, { nonce: string; until: number }>()
  const deviceRole = (connId: string | undefined): IldraAskClient | null => {
    if (!connId || deps.isLoopback(connId)) return null
    const client = deps.clientOf(connId)
    return client && client.role === 'device' && typeof client.identity === 'string' && client.identity ? client : null
  }

  /**
   * Shield R5-1: who may answer, from the connection alone.
   * - A connection the core does not know has no answer authority (no_authority, v3.3; was no_connection).
 * - The loopback / local socket has no answer authority (the agent itself runs there).
   * - Observers never answer.
   * - The device bridge session answers on touch only, and only when it proved the enrolled Ildra device key
   *   (Shield R7-1): role 'device' (never the loopback), and an Ed25519 signature over a fresh core nonce by the
   *   key the paired phone confirmed at enrollment, still enrolled. A gateway pairing alone (`harness pair`,
   *   any device-role identity) answers nothing. Any phone id it claims is dropped.
   * - Any other remote session answers as a phone: the ledger accepts it only when its authenticated key
   *   (machinePub) is the key the claimed phone paired with (PhonePairing.isPairedKey).
   */
  type Origin = { from: IldraAnswerOrigin; via: 'touch' | 'phone' } | 'no_authority'
  const originOf = (connId: string | undefined, claimed: unknown): Origin => {
    if (!connId) return 'no_authority'
    if (deps.isLoopback(connId)) return 'no_authority'
    const client = deps.clientOf(connId)
    if (!client || typeof client.identity !== 'string' || !client.identity) return 'no_authority'
    sharedByPub.set(client.identity, client.shared === true)
    if (client.role === 'observer') return 'no_authority'
    if (client.role === 'device') {
      const key = bridges.get(connId)
      const enrolled = key !== undefined && core.deviceKey?.() === key
      return enrolled ? { from: { machinePub: client.identity }, via: 'touch' } : 'no_authority'
    }
    const c = claimed && typeof claimed === 'object' ? (claimed as Record<string, unknown>) : {}
    const phoneId = typeof c.phoneId === 'string' && c.phoneId ? c.phoneId : undefined
    return { from: { machinePub: client.identity, ...(phoneId ? { phoneId } : {}) }, via: 'phone' }
  }

  const core: IldraAskCore = {
    guard,
    challengeDevice: (connId) => {
      if (!deviceRole(connId) || !core.deviceKey?.()) return null
      const nonce = randomBytes(32).toString('base64url')
      nonces.set(connId, { nonce, until: now() + 60_000 })
      return nonce
    },
    proveDevice: (connId, signature) => {
      const n = nonces.get(connId)
      nonces.delete(connId)
      const key = core.deviceKey?.() ?? null
      if (!deviceRole(connId) || !n || now() >= n.until || !key || !verifyDeviceProof(key, n.nonce, signature)) { bridges.delete(connId); return false }
      bridges.set(connId, key)
      return true
    },
    isShared: (o) => typeof o.machinePub === 'string' && sharedByPub.get(o.machinePub) !== false,
    cancel: (id) => { waiting.get(id)?.(null) },
    awaitAnswer: (req, pane, deliver) => new Promise((resolve) => {
      guard.open(pane, req.id)
      const finish = (answer: Record<string, unknown> | null): void => {
        clearTimeout(timer)
        waiting.delete(req.id)
        if (guard.requestFor(pane) === req.id) guard.close(pane)
        resolve(answer)
      }
      const timer = setTimeout(() => finish(null), Math.max(0, req.expiresAt - now()))
      timer.unref?.()
      waiting.set(req.id, finish)
      try { deliver() } catch { finish(null) }
    }),
    requests: {
      ildra_ask_answer: async (payload, asker) => {
        if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || typeof payload.digest8 !== 'string') return { ok: false, reason: 'malformed' }
        const origin = originOf(asker.connection, payload.from)
        if (typeof origin === 'string') return { ok: false, reason: origin }
        const answer: Record<string, unknown> = {
          id: payload.id, digest8: payload.digest8, answerId: payload.answerId /* checked by the ledger (malformed) */, approved: payload.approved === true,
          from: origin.from, via: origin.via,
          ...(typeof payload.holdMs === 'number' ? { holdMs: payload.holdMs } : {}),
          ...(typeof payload.transcript === 'string' ? { transcript: payload.transcript } : {}),
          ...(typeof payload.signature === 'string' ? { signature: payload.signature } : {}),
          ...(payload.phoneSignature !== undefined ? { phoneSignature: payload.phoneSignature } : {}),
        }
        // Shield R7 ledger via rule: the channel layer's stamp, which a production ledger requires.
        stampChannel(answer, origin.via)
        // Shield deny key: the service checks a phone-key signature (role from the stored key) before anything else.
        const refused = core.checkAnswer?.(answer) ?? null
        if (refused !== null) return { ok: false, reason: refused === 'verifier_rejected' ? 'verifier_rejected' : refused === 'bad_signature' ? 'bad_signature' : 'malformed' }
        const finish = waiting.get(payload.id)
        // No open Ask waits for it: nothing to approve. v3.3: the service may still record it (a device answer
        // after a handoff is stale_channel); that path never approves and never spends an open Ask.
        if (!finish) {
          const why = core.onUnclaimed?.(answer) ?? null
          return { ok: false, reason: why === 'stale_channel' || why === 'replayed' || why === 'busy' ? why : 'unknown_id' }
        }
        core.onAnswer?.(payload.id, answer)
        finish(answer)
        return { ok: true }
      },
      // v3.3: `ildra.settings.set {key, value}`. Same origin rules as answers; the service accepts it only from
      // the paired phone's key (R5-1), so the device, the local socket and observers can never change a setting.
      ildra_settings_set: async (payload, asker) => {
        if (!payload || typeof payload !== 'object' || typeof payload.key !== 'string') return { ok: false, reason: 'malformed' }
        const origin = originOf(asker.connection, payload.from)
        if (typeof origin === 'string') return { ok: false, reason: origin }
        if (origin.via !== 'phone') return { ok: false, reason: 'no_authority' }
        if (!core.onSettings) return { ok: false, reason: 'unavailable' }
        return core.onSettings({ key: payload.key, value: payload.value, ...(payload.signature !== undefined ? { signature: payload.signature } : {}) }, origin.from)
      },
      // Shield R7-1: enrolling the Ildra device. Asking only records a pending key (any device-role connection
      // or local owner may ask; it grants nothing). Only the paired phone's key confirms it, by
      // `ildra.device.enroll.confirm` (ildra_device_enroll_confirm, checked by the service).
      ildra_device_enroll: async (payload, asker) => {
        const local = asker.local && asker.owner
        if (!local && !deviceRole(asker.connection)) return { ok: false, reason: 'no_authority' }
        if (!core.onDeviceEnroll) return { ok: false, reason: 'unavailable' }
        return core.onDeviceEnroll(payload?.devicePub, local ? 'local_socket' : 'device')
      },
      ildra_device_enroll_confirm: async (payload, asker) => {
        const origin = originOf(asker.connection, payload?.from)
        if (typeof origin === 'string' || origin.via !== 'phone') return { ok: false, reason: 'no_authority' }
        if (!core.onDeviceConfirm) return { ok: false, reason: 'unavailable' }
        const r = core.onDeviceConfirm({ devicePub: payload?.devicePub, nonce: payload?.nonce, approved: payload?.approved, uv: payload?.uv, signature: payload?.signature, ...(payload?.denyKey !== undefined ? { denyKey: payload.denyKey } : {}) }, origin.from)
        if (r.ok && r.state !== 'enrolled') bridges.clear()
        return r
      },
      // Shield deny key condition 6: the paired phone opening the app collects the 'denied from this phone' summary.
      ildra_phone_open: async (payload, asker) => {
        const origin = originOf(asker.connection, payload?.from)
        if (typeof origin === 'string' || origin.via !== 'phone') return { ok: false, reason: 'no_authority' }
        if (!core.onPhoneOpen) return { ok: false, reason: 'unavailable' }
        return core.onPhoneOpen(origin.from)
      },
      // Batch B: the pairing ledger read API, the unpair API (locked_ask) and the answered-by read, all phone-only.
      ildra_pairing_ledger: async (payload, asker) => {
        const origin = originOf(asker.connection, payload?.from)
        if (typeof origin === 'string' || origin.via !== 'phone') return { ok: false, reason: 'no_authority' }
        if (!core.onPairingLedger) return { ok: false, reason: 'unavailable' }
        return core.onPairingLedger(payload?.since, origin.from)
      },
      ildra_pairing_unpair: async (payload, asker) => {
        const origin = originOf(asker.connection, payload?.from)
        if (typeof origin === 'string' || origin.via !== 'phone') return { ok: false, reason: 'no_authority' }
        if (!core.onPairingUnpair) return { ok: false, reason: 'unavailable' }
        return core.onPairingUnpair({ phoneId: payload?.phoneId, at: payload?.at, signature: payload?.signature, ...(payload?.touchProof !== undefined ? { touchProof: payload.touchProof } : {}) }, origin.from)
      },
      ildra_ask_answered_by: async (payload, asker) => {
        const origin = originOf(asker.connection, payload?.from)
        if (typeof origin === 'string' || origin.via !== 'phone') return { ok: false, reason: 'no_authority' }
        if (!core.onAnsweredBy) return { ok: false, reason: 'unavailable' }
        return core.onAnsweredBy(payload?.id, origin.from)
      },
      // Shield B5: the paired phone acknowledges a ledger_reset (main key only).
      ildra_pairing_ledger_ack: async (payload, asker) => {
        const origin = originOf(asker.connection, payload?.from)
        if (typeof origin === 'string' || origin.via !== 'phone') return { ok: false, reason: 'no_authority' }
        if (!core.onPairingLedgerAck) return { ok: false, reason: 'unavailable' }
        return core.onPairingLedgerAck({ seq: payload?.seq, hash: payload?.hash, signature: payload?.signature }, origin.from)
      },
      // (h): the paired phone asks the device to confirm the phone and device list (main key only).
      ildra_ledger_confirm: async (payload, asker) => {
        const origin = originOf(asker.connection, payload?.from)
        if (typeof origin === 'string' || origin.via !== 'phone') return { ok: false, reason: 'unpaired_phone' }
        if (!core.onLedgerConfirm) return { ok: false, reason: 'unavailable' }
        return core.onLedgerConfirm({ head: payload?.head, seq: payload?.seq, at: payload?.at, phoneSignature: payload?.phoneSignature }, origin.from)
      },
      // (k): the paired phone acknowledges the deny summary (main or deny key).
      ildra_deny_summary_ack: async (payload, asker) => {
        const origin = originOf(asker.connection, payload?.from)
        if (typeof origin === 'string' || origin.via !== 'phone') return { ok: false, reason: 'unpaired_phone' }
        if (!core.onDenySummaryAck) return { ok: false, reason: 'unavailable' }
        return core.onDenySummaryAck({ since: payload?.since, at: payload?.at, phoneSignature: payload?.phoneSignature }, origin.from)
      },
      ildra_device_challenge: async (_payload, asker) => {
        const nonce = asker.connection ? core.challengeDevice(asker.connection) : null
        return nonce ? { ok: true, nonce } : { ok: false, reason: 'no_authority' }
      },
      ildra_device_prove: async (payload, asker) => {
        return asker.connection && core.proveDevice(asker.connection, payload?.signature) ? { ok: true } : { ok: false, reason: 'no_authority' }
      },
    },
  }
  return core
}
