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
import {
  ask as askGate, deviceFingerprint, openJournal, practiceAsk, ToolManifestLoader,
  type ApprovalJournal, type ApprovalProfile, type ApprovalTemplate, type AskAnswer, type AskAttempt, type AskChannel,
  type AskHandoff, type AskOptions, type AskOutcome, type AskRequest, type ToolManifestEntry,
} from './approvals.js'
import type { IldraAskInputs } from '../core/api.js'

export type IldraAskEvent =
  | { type: 'ildra.ask.attempt'; body: AskAttempt }
  | { type: 'ildra.ask.handoff'; body: AskHandoff }
  | { type: 'ildra.ask.outcome'; body: AskOutcome }
  | { type: 'ildra.settings.value'; body: { key: string; value: number } }
  | { type: 'ildra.ask.unpaired'; body: { count: number; since: number; at: number } }
  | { type: 'ildra.device.enroll'; body: { devicePub: string; fingerprint: string; expiresAt: number } }
  | { type: 'ildra.device.enroll.status'; body: { state: 'enrolled' | 'refused' | 'revoked' | 'expired'; fingerprint: string; at: number } }

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
    journal.ledger.onHandoff = onHandoff
    journal.ledger.onUnpaired = (u) => emit('ildra.ask.unpaired', u)
    // Shield R7 ruling: the last unpair ended this phone Ask (no_paired_phone); wake its waiting ask().
    journal.ledger.onEnded = (id) => { deps.inputs.cancel(id) }
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
  deps.inputs.onDeviceEnroll = (devicePub) => {
    const p = open().device.begin(devicePub)
    if (!p) return { ok: false, reason: 'malformed' }
    emit('ildra.device.enroll', p)
    return { ok: true, ...p }
  }
  deps.inputs.onDeviceConfirm = (msg, from) => {
    const j = open()
    if (typeof from.phoneId !== 'string' || typeof from.machinePub !== 'string' || !j.pairing.isPairedKey(from.phoneId, from.machinePub)) return { ok: false, reason: 'unpaired_phone' }
    const state = j.device.confirm(msg.devicePub, msg.approved)
    if (state === null) return { ok: false, reason: 'unknown_id' }
    emit('ildra.device.enroll.status', { state, fingerprint: deviceFingerprint(msg.devicePub as string), at: (deps.now ?? Date.now)() })
    return { ok: true, state }
  }
  deps.inputs.onSettings = (msg, from) => {
    const j = open()
    if (typeof from.phoneId !== 'string' || typeof from.machinePub !== 'string' || !j.pairing.isPairedKey(from.phoneId, from.machinePub)) {
      return { ok: false, reason: 'unpaired_phone' }
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
