/**
 * Ildra Asks, the service's half: runs approvals.ts ask() against the Ask journal, with the core's input paths
 * (CoreApi.ildraAsk, core/ildraAsk.ts) as the answer function and the F12 shared-origin lookup, and the core's
 * pane guard held while an Ask waits (F13). The journal opens on first use, so a daemon that never asks writes
 * nothing. Showing the Ask on its channel (`bridge`) is the gateway plugin's job; unset, every Ask is denied.
 *
 * v3.3: a device Ask (touch or voice) hands off to the paired phone after ask.deviceWindowSec (journaled
 * setting, 30 to 300 s, default 60) when its policy permits the phone; a paired-phone answer before that is an
 * early handoff (ledger). Either way the daemon emits ildra.ask.handoff, withdraws the device prompt
 * (`withdraw`) and shows the Ask on the phone (`bridge('phone', ...)`).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import {
  ask as askGate, deviceFingerprint, openJournal, practiceAsk, ToolManifestLoader,
  type ApprovalJournal, type ApprovalProfile, type ApprovalTemplate, type AskAnswer, type AskAttempt, type AskChannel,
  type AskHandoff, type AskOptions, type AskOutcome, type AskRequest, type EnrollReplaced, type EnrollSource, type ToolManifestEntry,
  type AskAnsweredBy, stampManifest, UNPAIR_RESET_COUNT, LEDGER_STRING_MAX, deviceHoldConfirm, LEDGER_CONFIRM_PROMPT, LEDGER_CONFIRM_MS, parseDeviceCaps,
} from './approvals.js'

/** (i): a presence challenge, sent to the paired phone and the device. */
export interface PresenceChallenge { requestId: string; method: 'hold_screen' | 'blink_button'; groups?: [number, number]; pattern?: { on_ms: number; off_ms: number }[]; nonce: string; expiresAt: number }

/** Batch B: the unpair API's rate limit (from the pairing ledger, daemon-wide) and clock skew for its signed `at`. */
export const UNPAIR_RATE = 3
export const UNPAIR_WINDOW_MS = 600_000
export const UNPAIR_SKEW_MS = 60_000
const UNPAIR_ACTION = 'Unpair a phone'
const UNPAIR_TEMPLATE: ApprovalTemplate = { permissions: { locked_ask: [UNPAIR_ACTION] } }
const UNPAIR_MANIFEST = stampManifest([{ name: 'ildra.pairing.unpair', send: false }], 'first_party')
import { ENROLL_UV, askAnswerMessage, enrollConfirmMessage, rawDeviceKey, rawPhoneKey, settingsSetMessage, stampedChannel, ledgerAckMessage, ledgerConfirmMessage, denySummaryAckMessage, presencePattern, presenceMessage, presenceAbortMessage, PRESENCE_TTL_MS, PRESENCE_MIN_HELD_MS, unpairMessage, unpairTouchMessage, verifyEd25519, type EnrollUv, type IldraAskInputs } from '../core/api.js'

export type IldraAskEvent =
  | { type: 'ildra.ask.attempt'; body: AskAttempt }
  | { type: 'ildra.ask.handoff'; body: AskHandoff }
  | { type: 'ildra.ask.outcome'; body: AskOutcome }
  | { type: 'ildra.settings.value'; body: { key: string; value: number } }
  | { type: 'ildra.ask.unpaired'; body: { count: number; since: number; at: number } }
  | { type: 'ildra.device.enroll'; body: { devicePub: string; fingerprint: string; nonce: string; expiresAt: number; source: EnrollSource } }
  | { type: 'ildra.device.enroll.replaced'; body: EnrollReplaced }
  | { type: 'ildra.phone.deny_summary'; body: { count: number; since: number; at: number } }
  | { type: 'ildra.ask.answered_by'; body: AskAnsweredBy }
  | { type: 'ildra.pairing.unpair_requested'; body: { phoneId: string; by: string; at: number } }
  | { type: 'ildra.pairing.unpaired'; body: { phoneId: string; by: string; askId: string; at: number; remaining: number } }
  | { type: 'ildra.pairing.ledger_reset'; body: { seq: number; hash: string; reason: string; at: number; oldHead?: string } }
  | { type: 'ildra.ledger.confirmed'; body: { head: string; seq: number; at: number } }
  | { type: 'ildra.presence.challenge'; body: PresenceChallenge }
  | { type: 'ildra.ledger.confirm_refused'; body: { reason: string } }
  | { type: 'ildra.device.enroll.status'; body: { state: 'enrolled' | 'refused' | 'revoked' | 'expired'; fingerprint: string; at: number; uv?: EnrollUv } }

export interface IldraAsk {
  journal(): ApprovalJournal
  ask(template: ApprovalTemplate, action: string, profile: ApprovalProfile | null | undefined,
    opts: Omit<AskOptions, 'ledger' | 'pairing' | 'window' | 'isShared' | 'reference' | 'kind'> & {
      agentId: string
      /** The called tool. manifest omitted: the daemon's own loaded manifests (`manifests`, R5-2). */
      kind: { tool: string; manifest?: readonly ToolManifestEntry[] | null }
    }): Promise<AskOutcome>
  /**
   * PM Q52: the first-run practice Ask. Carries no action, tool, amount or recipient (refused if given),
   * executes nothing, never touches the totals; short holds never close it.
   */
  practice(opts: { agentId?: string; available?: readonly string[] | null; profile?: ApprovalProfile | null } & Record<string, unknown>): Promise<AskOutcome & { practice: true }>
  /** Shield R5-2: the daemon's manifest loader; every entry stamped by where it was loaded from, keyed server+tool. */
  manifests: ToolManifestLoader
  /** Shows an Ask on its channel (device prompt, phone push). Unset: every Ask is denied, never answered by keys. */
  bridge: ((channel: AskChannel, prompt: string, req: AskRequest) => void) | null
  /** v3.3: clears the device prompt for an Ask that moved to the phone (the device then shows "Use your phone"). */
  withdraw: ((channel: AskChannel, req: AskRequest) => void) | null
  /**
   * Daemon events for the phone and device (gateway plugin forwards them; attempts and handoffs are also kept in
   * the journal): ildra.ask.attempt (a short hold or a stale-channel answer; the Ask stays open), ildra.ask.handoff,
   * ildra.ask.outcome (how every shown Ask ended, hold_limit among them), ildra.settings.value.
   */
  events: ((type: IldraAskEvent['type'], body: IldraAskEvent['body']) => void) | null
}

export function createIldraAsk(deps: { inputs: IldraAskInputs; journalPath: string; markerPath?: string; now?: () => number }): IldraAsk {
  let journal: ApprovalJournal | null = null
  /** Open device Asks: id to what the handoff needs (prompt, timer). */
  const live = new Map<string, { prompt: string; timer?: ReturnType<typeof setTimeout> }>()
  const emit = (type: IldraAskEvent['type'], body: IldraAskEvent['body']): void => {
    try { rt.events?.(type, body) } catch { /* a listener never changes the result */ }
  }
  const onHandoff = (h: AskHandoff): void => {
    const j = open()
    const req = j.ledger.get(h.id)
    const l = live.get(h.id)
    if (l?.timer) clearTimeout(l.timer)
    emit('ildra.ask.handoff', h)
    // The device prompt is withdrawn at once, so a later touch is stale_channel and cannot double-settle.
    try { if (req) rt.withdraw?.(h.channel, req) } catch { /* the bridge's problem */ }
    // Timer handoff: the Ask waits on, now on the phone. (An early handoff is being settled by that answer.)
    if (h.cause === 'timer' && req && l) {
      try { rt.bridge?.('phone', l.prompt, req) } catch { /* the bridge's problem */ }
    }
  }
  const open = (): ApprovalJournal => {
    if (journal) return journal
    // Shield R7 ledger via rule: this journal's ledger settles only answers the core stamped with their channel.
    journal = openJournal(deps.journalPath, { requireChannelStamp: true, ...(deps.now ? { now: deps.now } : {}), ...(deps.markerPath ? { markerPath: deps.markerPath } : {}) })
    journal.ledger.onAttempt = (a) => emit('ildra.ask.attempt', a)
    // Shield B5: the ledger could not be trusted at load: tell the phone now (and on every phone open until it acks).
    { const reset = journal.pairingLedger.pendingReset(); if (reset) emit('ildra.pairing.ledger_reset', resetBody(reset)) }
    journal.ledger.onHandoff = onHandoff
    journal.ledger.onUnpaired = (u) => emit('ildra.ask.unpaired', u)
    // Shield R7 ruling: the last unpair ended this phone Ask (no_paired_phone); wake its waiting ask().
    journal.ledger.onEnded = (id) => { deps.inputs.cancel(id) }
    // Shield deny key condition 6: every Deny the deny key settled is journaled (source deny_key); a burst flags the phone.
    journal.ledger.onSettled = (ans) => {
      const a = ans as AskAnswer & { keyRole?: unknown }
      const j = journal!
      const denyKey = a.keyRole === 'deny_only' && a.approved === false && typeof a.from?.phoneId === 'string'
      if (denyKey) j.pairing.noteDenyKeyDeny(a.from!.phoneId!, a.id)
      // Batch B: ildra.ask.answered_by: the channel and the key that settled this Ask (journaled with the ledger).
      const via = stampedChannel(ans) ?? a.via
      let by: AskAnsweredBy['by'] | null = null
      if (via === 'phone' && typeof a.from?.phoneId === 'string' && typeof a.from.machinePub === 'string') {
        by = { kind: 'phone', phoneId: a.from.phoneId, key: denyKey ? 'deny_only' : 'main', fingerprint: deviceFingerprint((denyKey ? j.pairing.denyKey(a.from.phoneId) : j.pairing.phoneKey(a.from.phoneId)) ?? '') }
      } else if ((via === 'touch' || via === 'voice') && j.device.device()) {
        by = { kind: 'device', key: 'device', fingerprint: deviceFingerprint(j.device.device()!) }
      }
      if (by && via) {
        const rec: AskAnsweredBy = { id: a.id, approved: a.approved === true, channel: via as AskChannel, by, at: (deps.now ?? Date.now)() }
        j.ledger.noteAnsweredBy(rec)
        emit('ildra.ask.answered_by', rec)
      }
    }
    return journal
  }
  const pairedKey = (j: ApprovalJournal) => (id: string, pub?: string) => (pub === undefined ? j.pairing.isPaired(id) : j.pairing.isPairedKey(id, pub))
  // v3.3: answers no open Ask waits for. Only for an Ask the ledger no longer holds open (a device answer after
  // the phone settled it reads stale_channel, a reuse replayed); an open one is being answered right now (busy),
  // so of two answers in the same tick exactly one settles.
  deps.inputs.onUnclaimed = (a) => {
    const j = open()
    if (typeof a.id === 'string' && j.ledger.get(a.id)) {
      // v3.3: a phone answer refused as busy is logged as an attempt (channel phone), like its other rejections.
      j.ledger.phoneAttempt(a as unknown as AskAnswer, 'busy')
      return 'busy'
    }
    const r = j.ledger.settle(a as unknown as AskAnswer, { isPaired: pairedKey(j), isShared: (o) => deps.inputs.isShared(o) })
    return r.ok ? null : r.reason
  }
  // Shield R7-1: the enrolled Ildra device key, kept in the journal; enrollment confirmed by the paired phone.
  deps.inputs.deviceKey = () => open().device.device()
  deps.inputs.onDeviceEnroll = (devicePub, source, rawCaps) => {
    const caps = parseDeviceCaps(rawCaps ?? {})
    if (!caps) return { ok: false, reason: 'malformed' }
    // (i) point 3: the household has one Ildra device; enrolling one with no physical input would leave it none.
    if (caps.inputs.length === 0) {
      open().pairingLedger.append({ kind: 'device_refused', by: source, via: source, reason: 'no_physical_input' })
      return { ok: false, reason: 'no_physical_input' }
    }
    const p = open().device.begin(devicePub, source, caps)
    if (!p) return { ok: false, reason: 'malformed' }
    const { replaced, ...pending } = p
    // Batch A: a later request (any source, the local socket included) replaced a pending one: alert the phone.
    if (replaced) emit('ildra.device.enroll.replaced', replaced)
    emit('ildra.device.enroll', { ...pending, source })
    return { ok: true, ...pending }
  }
  deps.inputs.onDeviceConfirm = (msg, from) => {
    const j = open()
    if (typeof from.phoneId !== 'string' || typeof from.machinePub !== 'string' || !j.pairing.isPairedKey(from.phoneId, from.machinePub)) return { ok: false, reason: 'unpaired_phone' }
    // Batch A (Design Q55): uv is required and signed, with the nonce of the pending enrollment, by the paired key.
    if (typeof msg.approved !== 'boolean' || typeof msg.devicePub !== 'string' || !rawDeviceKey(msg.devicePub)
      || typeof msg.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(msg.nonce)
      || !(ENROLL_UV as readonly unknown[]).includes(msg.uv)) return { ok: false, reason: 'malformed' }
    const uv = msg.uv as EnrollUv
    if (msg.denyKey !== undefined && !rawPhoneKey(msg.denyKey)) return { ok: false, reason: 'malformed' }
    const denyKey = msg.denyKey as string | undefined
    // Shield deny key conditions 1 and 2: only the main key signs a confirm (and a deny key inside it); the deny key
    // signing one, with or without a deny key, is verifier_rejected (logged).
    const v = j.pairing.verifyPhone(from.phoneId, denyKey !== undefined ? 'deny_key.set' : 'device.enroll.confirm', enrollConfirmMessage(msg.devicePub, msg.nonce, msg.approved, uv, denyKey), msg.signature)
    if (!v.ok) return { ok: false, reason: v.reason }
    if (v.role !== 'main') { j.pairing.rejectVerifier(from.phoneId, 'device.enroll.confirm'); return { ok: false, reason: 'verifier_rejected' } }
    // Shield D2a: all or nothing. A deny key that would be refused refuses the whole confirm before the device changes.
    if (denyKey !== undefined && !j.pairing.canSetDenyKey(from.phoneId, denyKey)) return { ok: false, reason: 'malformed' }
    const state = j.device.confirm(msg.devicePub, msg.nonce, msg.approved, { uv, phoneId: from.phoneId })
    if (state === null) return { ok: false, reason: 'unknown_id' }
    if (denyKey !== undefined && !j.pairing.setDenyKey(from.phoneId, denyKey)) return { ok: false, reason: 'malformed' }
    const rec = j.device.enrolled()
    emit('ildra.device.enroll.status', { state, fingerprint: deviceFingerprint(msg.devicePub), at: (deps.now ?? Date.now)(), ...(state === 'enrolled' && rec ? { uv, inputs: rec.inputs, ...(rec.form ? { form: rec.form } : {}) } : {}) })
    return { ok: true, state }
  }
  // Shield deny key: an answer carrying phoneSignature is checked against the stored keys of the paired phone. The
  // deny-only key can sign a Deny (condition 1) on the phone path only (condition 7); its Deny is bound to id,
  // digest8 and the single-use answerId (condition 3), and the ledger then settles it like any phone Deny.
  deps.inputs.checkAnswer = (a) => {
    if (a.phoneSignature === undefined) return null
    const j = open()
    const from = (a.from ?? {}) as { phoneId?: unknown; machinePub?: unknown }
    if (a.via !== 'phone') { j.pairing.rejectVerifier(typeof from.phoneId === 'string' ? from.phoneId : '', `answer.${String(a.via)}`); return 'verifier_rejected' }
    // Not the paired phone's key: the ledger refuses it first as unpaired_phone (R7-10), with nothing recorded.
    if (typeof from.phoneId !== 'string' || typeof from.machinePub !== 'string' || !j.pairing.isPairedKey(from.phoneId, from.machinePub)) return null
    if (typeof a.id !== 'string' || typeof a.digest8 !== 'string' || typeof a.answerId !== 'string') return 'malformed'
    const approved = a.approved === true
    const v = j.pairing.verifyPhone(from.phoneId, approved ? 'ask.approve' : 'ask.deny', askAnswerMessage(approved, a.id, a.digest8, a.answerId), a.phoneSignature)
    if (!v.ok) return v.reason === 'unpaired_phone' ? null : v.reason
    if (v.role === 'deny_only') a.keyRole = 'deny_only'
    return null
  }
  // Shield deny key condition 6: the next phone open shows the 'denied from this phone' summary, once.
  deps.inputs.onPhoneOpen = (from) => {
    const j = open()
    if (typeof from.phoneId !== 'string' || typeof from.machinePub !== 'string' || !j.pairing.isPairedKey(from.phoneId, from.machinePub)) return { ok: false, reason: 'unpaired_phone' }
    const denySummary = j.pairing.takeDenySummary(from.phoneId)
    if (denySummary) emit('ildra.phone.deny_summary', denySummary)
    const reset = j.pairingLedger.pendingReset()
    if (reset) emit('ildra.pairing.ledger_reset', resetBody(reset))
    return { ok: true, denySummary }
  }
  // (k): only the phone's signed acknowledgement clears the deny summary (main or deny key); it resends until then.
  deps.inputs.onDenySummaryAck = (msg, from) => {
    const j = open()
    if (typeof from.phoneId !== 'string' || typeof from.machinePub !== 'string' || !j.pairing.isPairedKey(from.phoneId, from.machinePub)) return { ok: false, reason: 'unpaired_phone' }
    if (typeof msg.since !== 'number' || !Number.isInteger(msg.since) || msg.since < 0 || typeof msg.at !== 'number' || !Number.isFinite(msg.at) || typeof msg.phoneSignature !== 'string') return { ok: false, reason: 'malformed' }
    const v = j.pairing.verifyPhone(from.phoneId, 'deny_summary.ack', denySummaryAckMessage(msg.since, msg.at), msg.phoneSignature)
    if (!v.ok) return { ok: false, reason: v.reason }
    if (!j.pairing.ackDenySummary(from.phoneId, msg.since)) return { ok: false, reason: 'unknown_id' }
    return { ok: true }
  }
  const pairedFrom = (j: ApprovalJournal, from: { phoneId?: unknown; machinePub?: unknown }): from is { phoneId: string; machinePub: string } =>
    typeof from.phoneId === 'string' && typeof from.machinePub === 'string' && j.pairing.isPairedKey(from.phoneId, from.machinePub)
  // Batch B (1): the pairing ledger read API, for the paired phone only.
  deps.inputs.onPairingLedger = (since, from) => {
    const j = open()
    if (!pairedFrom(j, from)) return { ok: false, reason: 'unpaired_phone' }
    const s = since === undefined ? 0 : since
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 0) return { ok: false, reason: 'malformed' }
    return { ok: true, ...j.pairingLedger.page(s) }
  }
  // Batch B (3): who settled an Ask, for the paired phone.
  deps.inputs.onAnsweredBy = (id, from) => {
    const j = open()
    if (!pairedFrom(j, from)) return { ok: false, reason: 'unpaired_phone' }
    if (typeof id !== 'string') return { ok: false, reason: 'malformed' }
    return { ok: true, answeredBy: j.ledger.answeredBy(id) }
  }
  // Batch B (2): unpair through a locked_ask. Signed by the requesting phone's main key (the deny key is
  // verifier_rejected), rate limited from the ledger, the last paired phone only with a device touch proof; the other
  // paired phones and the device are told when it is asked and when it is done; every step is a ledger entry.
  /** Shield B5: the ildra.pairing.ledger_reset body for a pending reset entry. */
  const resetBody = (e: { seq: number; hash: string; at: number; reason?: string; oldHead?: string }) =>
    ({ seq: e.seq, hash: e.hash, reason: e.reason ?? 'chain_broken', at: e.at, ...(e.oldHead ? { oldHead: e.oldHead } : {}) })
  deps.inputs.onPairingLedgerAck = (msg, from) => {
    const j = open()
    if (!pairedFrom(j, from)) return { ok: false, reason: 'unpaired_phone' }
    if (typeof msg.seq !== 'number' || !Number.isInteger(msg.seq) || typeof msg.hash !== 'string' || !/^[0-9a-f]{64}$/.test(msg.hash)) return { ok: false, reason: 'malformed' }
    const v = j.pairing.verifyPhone(from.phoneId, 'pairing.ledger_ack', ledgerAckMessage(msg.seq, msg.hash), msg.signature)
    if (!v.ok) return { ok: false, reason: v.reason }
    if (!j.pairing.ackReset(from.phoneId, msg.seq, msg.hash)) return { ok: false, reason: 'unknown_id' }
    return { ok: true }
  }
  // (h): the paired phone asks the device to confirm the phone and device list at the head it read. Main key only
  // (the deny key is verifier_rejected), at the daemon's current head (else stale_head), one at a time (busy), then a
  // 60 s device hold prompt with the touch hold rules and authority proof. Every refusal is a ledger entry and an
  // ildra.ledger.confirm_refused; success appends ledger_confirmed (prev = the confirmed head, since = its seq).
  // The daemon keeps no per-phone head: pausing on a mismatch is the phone's.
  // (i): device presence. The daemon issues a challenge (requestId, nonce, 60 s) to the phone and the device; the
  // enrolled device answers with a signed hold (ildra.device.presence). Accepted only for the challenge's own purpose
  // (ledger.confirm, removing the last owner phone); never as an Ask answer. The phone may abort it (refuse only).
  type Open = PresenceChallenge & { purpose: 'ledger_confirm' | 'unpair_last'; done: (r: 'ok' | 'aborted' | 'missing') => void }
  const presenceOpen = new Map<string, Open>()
  const presenceEnded = new Map<string, 'spent' | 'aborted' | 'expired'>()
  const endPresence = (c: Open, how: 'spent' | 'aborted' | 'expired') => {
    presenceOpen.delete(c.requestId)
    presenceEnded.set(c.requestId, how)
    if (presenceEnded.size > 1000) presenceEnded.delete(presenceEnded.keys().next().value!)
    c.done(how === 'spent' ? 'ok' : how === 'aborted' ? 'aborted' : 'missing')
  }
  const runPresence = (purpose: Open['purpose'], inputs: readonly string[]): Promise<{ result: 'ok' | 'aborted' | 'missing'; requestId: string }> => {
    const now = (deps.now ?? Date.now)()
    const requestId = randomUUID()
    const nonce = randomBytes(32).toString('base64url')
    const method = inputs.includes('touch') ? 'hold_screen' as const : 'blink_button' as const
    const blink = method === 'blink_button' ? presencePattern(requestId, nonce) : null
    const ch: PresenceChallenge = { requestId, method, ...(blink ? { groups: blink.groups, pattern: blink.pattern } : {}), nonce, expiresAt: now + PRESENCE_TTL_MS }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { const c = presenceOpen.get(requestId); if (c) endPresence(c, 'expired') }, PRESENCE_TTL_MS)
      timer.unref?.()
      presenceOpen.set(requestId, { ...ch, purpose, done: (result) => { clearTimeout(timer); resolve({ result, requestId }) } })
      emit('ildra.presence.challenge', ch)
    })
  }
  deps.inputs.onDevicePresence = (msg) => {
    const j = open()
    const refuse = (reason: string, id?: string) => {
      j.pairingLedger.append({ kind: 'presence_refused', by: 'device', via: 'device', reason, ...(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? { askId: id } : {}) })
      return { ok: false as const, reason }
    }
    const id = msg.requestId
    if (typeof id !== 'string' || id.length > LEDGER_STRING_MAX) return refuse('presence_missing')
    const c = presenceOpen.get(id)
    if (!c) {
      const ended = presenceEnded.get(id)
      if (ended === 'aborted') return refuse('aborted', id)
      if (ended === 'spent') return refuse('presence_replayed', id)
      if (ended === 'expired') return refuse('presence_expired', id)
      // Presence is not an Ask answer: a hold sent against an open Ask id is no_authority.
      if (j.ledger.get(id)) return { ok: false, reason: 'no_authority' }
      return refuse('presence_wrong_request', id)
    }
    if (msg.nonce !== c.nonce) return refuse('presence_wrong_request', id)
    if ((deps.now ?? Date.now)() >= c.expiresAt) { endPresence(c, 'expired'); return refuse('presence_expired', id) }
    if (msg.kind !== (c.method === 'blink_button' ? 'button_hold' : 'screen_hold')) return refuse('presence_wrong_request', id)
    if (typeof msg.heldMs !== 'number' || !Number.isInteger(msg.heldMs) || msg.heldMs < 0) return refuse('presence_missing', id)
    if (msg.heldMs < PRESENCE_MIN_HELD_MS) return refuse('presence_too_short', id)
    const dev = j.device.device()
    if (!dev || !verifyEd25519(dev, presenceMessage(id, c.nonce, msg.heldMs), msg.signature)) return refuse('bad_signature', id)
    j.pairingLedger.append({ kind: 'device_presence', fingerprint: deviceFingerprint(dev), by: 'device', via: 'device', askId: id, reason: c.purpose, verb: msg.kind as string })
    endPresence(c, 'spent')
    return { ok: true }
  }
  deps.inputs.onPresenceAbort = (msg, from) => {
    const j = open()
    if (!pairedFrom(j, from)) return { ok: false, reason: 'unpaired_phone' }
    if (typeof msg.requestId !== 'string' || typeof msg.at !== 'number' || !Number.isFinite(msg.at) || typeof msg.phoneSignature !== 'string') return { ok: false, reason: 'malformed' }
    const v = j.pairing.verifyPhone(from.phoneId, 'presence.abort', presenceAbortMessage(msg.requestId, msg.at), msg.phoneSignature)
    if (!v.ok) return { ok: false, reason: v.reason }
    const c = presenceOpen.get(msg.requestId)
    if (!c) return { ok: false, reason: 'unknown_id' }
    j.pairingLedger.append({ kind: 'presence_aborted', phoneId: from.phoneId, by: from.phoneId, via: 'phone', askId: c.requestId, reason: c.purpose })
    endPresence(c, 'aborted')
    return { ok: true }
  }
  let confirmOpen = false
  deps.inputs.onLedgerConfirm = async (msg, from) => {
    const j = open()
    const who = typeof from.phoneId === 'string' && from.phoneId.length <= LEDGER_STRING_MAX ? from.phoneId : undefined
    const refuse = (reason: string, askId?: string) => {
      j.pairingLedger.append({ kind: 'ledger_confirm_refused', ...(who ? { phoneId: who, by: who } : {}), via: askId ? 'touch' : 'phone', reason, ...(askId ? { askId } : {}) })
      emit('ildra.ledger.confirm_refused', { reason })
      return { ok: false as const, reason }
    }
    if (!pairedFrom(j, from)) return refuse('unpaired_phone')
    const { head, seq, at } = msg
    if (typeof head !== 'string' || !/^[0-9a-f]{64}$/.test(head) || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0
      || typeof at !== 'number' || !Number.isFinite(at) || typeof msg.phoneSignature !== 'string') return refuse('malformed')
    const v = j.pairing.verifyPhone(from.phoneId, 'ledger.confirm', ledgerConfirmMessage(head, seq, at), msg.phoneSignature)
    if (!v.ok) return refuse(v.reason === 'verifier_rejected' ? 'verifier_rejected' : v.reason === 'unpaired_phone' ? 'unpaired_phone' : 'bad_signature')
    const atHead = () => { const h = j.pairingLedger.head(); return h.seq === seq && h.hash === head }
    // After the prompt: the list is still the one confirmed if no phone, device or deny key entry came after seq
    // (refusals and the presence record written meanwhile do not change the list).
    const STATE = new Set(['phone_paired', 'phone_rotated', 'phone_unpaired', 'device_enrolled', 'device_revoked', 'device_reset', 'deny_key_set', 'deny_key_revoked', 'ledger_reset', 'ledger_ack'])
    const listUnchanged = () => { const all = j.pairingLedger.all(); const at = all.findIndex((e) => e.seq === seq); return (seq === 0 || (at >= 0 && all[at]!.hash === head)) && all.slice(at + 1).every((e) => !STATE.has(e.kind)) }
    if (!atHead()) return refuse('stale_head')
    if (confirmOpen) return refuse('busy')
    confirmOpen = true
    // (i): a device without a touch screen confirms by presence (blink_button); a touch device by the hold prompt.
    const inputs = j.device.inputs()
    let askId: string
    try {
      if (inputs && !inputs.includes('touch')) {
        const p = await runPresence('ledger_confirm', inputs)
        askId = p.requestId
        if (p.result !== 'ok') return refuse(p.result === 'aborted' ? 'aborted' : 'presence_missing', askId)
      } else {
        const out = await deviceHoldConfirm(answerVia('ildra'), { ledger: j.ledger, pairing: j.pairing, isShared: (o) => deps.inputs.isShared(o), prompt: LEDGER_CONFIRM_PROMPT, expiryMs: LEDGER_CONFIRM_MS, agentId: 'ildra' })
        done(out.request.id)
        askId = out.request.id
        if (!out.approved) return refuse('timeout', askId)
      }
    } finally { confirmOpen = false }
    const out = { request: { id: askId } }
    // The head may have moved while the hold prompt was up: then the person confirmed a list that is no longer current.
    if (!listUnchanged()) return refuse('stale_head', out.request.id)
    if (!j.pairing.isPairedKey(from.phoneId, from.machinePub)) return refuse('unpaired_phone', out.request.id)
    j.pairingLedger.append({ kind: 'ledger_confirmed', phoneId: from.phoneId, by: from.phoneId, via: 'touch', since: seq, askId: out.request.id })
    emit('ildra.ledger.confirmed', { head, seq, at })
    return { ok: true, head, seq, at }
  }
  /** Shield B7: at most one unpair open at a time (its locked_ask is pending). */
  let unpairOpen: string | null = null
  deps.inputs.onPairingUnpair = async (msg, from) => {
    const j = open()
    if (!pairedFrom(j, from)) return { ok: false, reason: 'unpaired_phone' }
    const now = (deps.now ?? Date.now)()
    const refuse = (reason: string, target?: string, askId?: string) => {
      j.pairingLedger.append({ kind: 'unpair_refused', ...(target ? { phoneId: target } : {}), by: from.phoneId as string, via: askId ? 'locked_ask' : 'phone', reason, ...(askId ? { askId } : {}) })
      return { ok: false as const, reason }
    }
    if (typeof msg.phoneId !== 'string' || msg.phoneId === '' || msg.phoneId.length > LEDGER_STRING_MAX || typeof msg.at !== 'number' || !Number.isFinite(msg.at)) return { ok: false, reason: 'malformed' }
    const target = msg.phoneId; const at = msg.at
    const v = j.pairing.verifyPhone(from.phoneId, 'pairing.unpair', unpairMessage(target, at), msg.signature)
    if (!v.ok) return { ok: false, reason: v.reason }
    if (Math.abs(now - at) > UNPAIR_SKEW_MS) return refuse('expired', target)
    if (!j.pairing.isPaired(target)) return refuse('unknown_phone', target)
    // Each request that opened a locked_ask counts (refusals before that open no Ask and need a valid signature).
    // Shield B5: a ledger_reset counts as UNPAIR_RESET_COUNT requests, so a broken ledger never resets the limit.
    const recent = j.pairingLedger.all().reduce((n, e) => n + (now - e.at >= UNPAIR_WINDOW_MS ? 0 : e.kind === 'unpair_requested' ? 1 : e.kind === 'ledger_reset' ? (e.count ?? UNPAIR_RESET_COUNT) : 0), 0)
    { const why = j.pairing.changeRefusal(); if (why) return refuse(why, target) }
    if (recent >= UNPAIR_RATE) return refuse('rate_limited', target)
    // Shield B7: one open unpair at a time, so two requests can never both pass the last-owner check below.
    if (unpairOpen !== null) return refuse('unpair_pending', target)
    // The last owner channel: removing the only paired phone needs the enrolled device's signed touch.
    let touched = false
    let presenceId: string | null = null
    // (i): presence fills the touch proof slot, only for removing the last owner phone.
    const usePresence = msg.presence === true && msg.touchProof === undefined
    if (usePresence && j.pairing.pairedCount() > 1) return refuse('presence_not_allowed', target)
    if (usePresence) {
      const inputs = j.device.inputs()
      if (!inputs || !j.device.device()) return refuse('last_owner_channel', target)
      unpairOpen = target
      let p: Awaited<ReturnType<typeof runPresence>>
      try { p = await runPresence('unpair_last', inputs) } finally { unpairOpen = null }
      if (p.result !== 'ok') return refuse(p.result === 'aborted' ? 'aborted' : 'presence_missing', target)
      touched = true
      presenceId = p.requestId
    } else if (j.pairing.pairedCount() <= 1) {
      const dev = j.device.device()
      if (!dev || !verifyEd25519(dev, unpairTouchMessage(target, at), msg.touchProof)) return refuse('last_owner_channel', target)
      // Shield B8: a touch proof is single use. Its (target, at) is spent in the ledger (journaled, so also across a
      // restart); one signed before the latest ledger reset or acknowledgement is not accepted either.
      const spent = j.pairingLedger.all().some((e) => (e.kind === 'unpair_requested' && e.verb === 'touch_proof' && e.phoneId === target && e.since === at)
        || ((e.kind === 'ledger_reset' || e.kind === 'ledger_ack') && at <= e.at))
      if (spent) return refuse('last_owner_channel', target)
      touched = true
    }
    j.pairingLedger.append({ kind: 'unpair_requested', phoneId: target, by: from.phoneId, via: 'phone', ...(presenceId ? { verb: 'presence', askId: presenceId } : touched ? { verb: 'touch_proof', since: at } : {}) })
    emit('ildra.pairing.unpair_requested', { phoneId: target, by: from.phoneId, at: now })
    unpairOpen = target
    let outcome: Awaited<ReturnType<typeof rt.ask>>
    try {
      outcome = await rt.ask(UNPAIR_TEMPLATE, UNPAIR_ACTION, null, { agentId: 'ildra', kind: { tool: 'ildra.pairing.unpair', manifest: UNPAIR_MANIFEST }, available: ['phone'] })
    } finally { unpairOpen = null }
    const askId = outcome.request?.id ?? ''
    if (!outcome.approved) return refuse('not_approved', target, askId || undefined)
    // Shield B7: check again right before the unpair, in the same synchronous step (nothing can run between the
    // check and the change): if it would leave no paired phone, only a touch proof given for this request allows it.
    if (!j.pairing.isPaired(target)) return refuse('unknown_phone', target, askId || undefined)
    if (j.pairing.pairedCount() <= 1 && !touched) return refuse('last_owner_channel', target, askId || undefined)
    if (!j.pairing.unpair(target, { by: from.phoneId, via: 'locked_ask', askId })) return refuse(j.pairing.changeRefusal() ?? 'unknown_phone', target, askId || undefined)
    emit('ildra.pairing.unpaired', { phoneId: target, by: from.phoneId, askId, at: (deps.now ?? Date.now)(), remaining: j.pairing.pairedCount() })
    return { ok: true, state: 'unpaired', askId }
  }
  deps.inputs.onSettings = (msg, from) => {
    const j = open()
    if (typeof from.phoneId !== 'string' || typeof from.machinePub !== 'string' || !j.pairing.isPairedKey(from.phoneId, from.machinePub)) {
      return { ok: false, reason: 'unpaired_phone' }
    }
    // Shield deny key condition 1: a signed settings.set must be by the main key; the deny key is verifier_rejected.
    if (msg.signature !== undefined) {
      const v = j.pairing.verifyPhone(from.phoneId, 'settings.set', settingsSetMessage(String(msg.key), msg.value), msg.signature)
      if (!v.ok) return { ok: false, reason: v.reason }
    }
    const stored = j.settings.set(msg.key, msg.value)
    if (!stored) return { ok: false, reason: 'malformed' }
    emit('ildra.settings.value', stored)
    return { ok: true, ...stored }
  }
  const answerVia = (agentId: string) => async (channel: AskChannel, prompt: string, req?: AskRequest): Promise<AskAnswer | null> => {
    const j = open()
    const current = j.ledger.get(req!.id) ?? req!
    const ans = (await deps.inputs.awaitAnswer(current, current.agentId ?? agentId, () => {
      if (!rt.bridge) throw new Error('no Ildra Ask bridge connected')
      rt.bridge(current.channel, prompt, current)
      if ((current.channel === 'touch' || current.channel === 'voice') && j.ledger.phoneAllowed(current.id)) {
        const l = live.get(current.id) ?? { prompt }
        l.prompt = prompt
        if (!l.timer) {
          // The device window counts from when the Ask opened (DEVICE-INTERFACE 11); a re-prompt keeps it.
          const left = current.openedAt + j.settings.deviceWindowSec * 1000 - (deps.now ?? Date.now)()
          l.timer = setTimeout(() => { j.ledger.handoff(current.id, 'phone', 'timer') }, Math.max(0, left))
          l.timer.unref?.()
        }
        live.set(current.id, l)
      }
    })) as AskAnswer | null
    void channel
    // R5-1: an answer reaches the gate only with the channel its connection may answer on (set by the core).
    return ans && (ans.via === 'touch' || ans.via === 'phone') ? ans : null
  }
  const done = (id: string | undefined): void => {
    if (!id) return
    const l = live.get(id)
    if (l?.timer) clearTimeout(l.timer)
    live.delete(id)
  }
  const rt: IldraAsk = {
    bridge: null,
    withdraw: null,
    events: null,
    manifests: new ToolManifestLoader(),
    journal: open,
    ask: async (template, action, profile, opts) => {
      const j = open()
      const kind = { tool: opts.kind.tool, manifest: opts.kind.manifest === undefined ? rt.manifests.entries() : opts.kind.manifest }
      let outcome: AskOutcome
      try {
        outcome = await askGate(template, action, profile, answerVia(opts.agentId),
          { ...opts, kind, ledger: j.ledger, pairing: j.pairing, window: j.window, isShared: (o) => deps.inputs.isShared(o) })
      } finally {
        for (const id of live.keys()) if (!j.ledger.get(id)) done(id)
      }
      done(outcome.request?.id)
      if (outcome.channel !== null) emit('ildra.ask.outcome', outcome)
      return outcome
    },
    practice: async (opts) => {
      const j = open()
      const out = await practiceAsk(answerVia(typeof opts.agentId === 'string' ? opts.agentId : 'practice'),
        { ...opts, ledger: j.ledger, pairing: j.pairing, isShared: (o) => deps.inputs.isShared(o) })
      done(out.request?.id)
      if (out.channel !== null) emit('ildra.ask.outcome', out)
      return out
    },
  }
  return rt
}
