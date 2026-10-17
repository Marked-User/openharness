/**
 * Ildra Asks, the service's half: runs approvals.ts ask() against the Ask journal, with the core's input paths
 * (CoreApi.ildraAsk, core/ildraAsk.ts) as the answer function and the F12 shared-origin lookup, and the core's
 * pane guard held while an Ask waits (F13). The journal opens on first use, so a daemon that never asks writes
 * nothing. Showing the Ask on its channel (`bridge`) is the gateway plugin's job; unset, every Ask is denied.
 */
import { ask as askGate, openJournal, type ApprovalJournal, type ApprovalProfile, type ApprovalTemplate, type AskAnswer, type AskAttempt, type AskChannel, type AskOptions, type AskOutcome, type AskRequest, ToolManifestLoader, type ToolManifestEntry } from './approvals.js'
import type { IldraAskInputs } from '../core/api.js'

export interface IldraAsk {
  journal(): ApprovalJournal
  ask(template: ApprovalTemplate, action: string, profile: ApprovalProfile | null | undefined,
    opts: Omit<AskOptions, 'ledger' | 'pairing' | 'window' | 'isShared' | 'reference' | 'kind'> & {
      agentId: string
      /** The called tool. manifest omitted: the daemon's own loaded manifests (`manifests`, R5-2). */
      kind: { tool: string; manifest?: readonly ToolManifestEntry[] | null }
    }): Promise<AskOutcome>
  /** Shield R5-2: the daemon's manifest loader; every entry stamped by where it was loaded from, keyed server+tool. */
  manifests: ToolManifestLoader
  /** Shows an Ask on its channel (device prompt, phone push). Unset: every Ask is denied, never answered by keys. */
  bridge: ((channel: AskChannel, prompt: string, req: AskRequest) => void) | null
  /**
   * Daemon events for the phone (gateway plugin forwards them; also kept in the journal): ildra.ask.attempt,
   * one per device approval held under 1500 ms (DECISIONS ad47477). The Ask stays open meanwhile, up to
   * MAX_SHORT_HOLDS (R5-4). ildra.ask.outcome: how every shown Ask ended, so the phone hears of one the device
   * closed (hold_limit) or refused.
   */
  events: ((type: 'ildra.ask.attempt', body: AskAttempt) => void) &
    ((type: 'ildra.ask.outcome', body: AskOutcome) => void) | null
}

export function createIldraAsk(deps: { inputs: IldraAskInputs; journalPath: string; markerPath?: string; now?: () => number }): IldraAsk {
  let journal: ApprovalJournal | null = null
  const open = (): ApprovalJournal => {
    if (journal) return journal
    journal = openJournal(deps.journalPath, { ...(deps.now ? { now: deps.now } : {}), ...(deps.markerPath ? { markerPath: deps.markerPath } : {}) })
    journal.ledger.onAttempt = (a) => rt.events?.('ildra.ask.attempt', a)
    return journal
  }
  const rt: IldraAsk = {
    bridge: null,
    events: null,
    manifests: new ToolManifestLoader(),
    journal: open,
    ask: async (template, action, profile, opts) => {
      const j = open()
      const kind = { tool: opts.kind.tool, manifest: opts.kind.manifest === undefined ? rt.manifests.entries() : opts.kind.manifest }
      const outcome = await askGate(template, action, profile, async (channel, prompt, req) => {
        const ans = (await deps.inputs.awaitAnswer(req!, req!.agentId ?? opts.agentId, () => {
          if (!rt.bridge) throw new Error('no Ildra Ask bridge connected')
          rt.bridge(channel, prompt, req!)
        })) as AskAnswer | null
        // R5-1: an answer reaches the gate only with the channel its connection may answer on (set by the core).
        return ans && (ans.via === 'touch' || ans.via === 'phone') ? ans : null
      }, { ...opts, kind, ledger: j.ledger, pairing: j.pairing, window: j.window, isShared: (o) => deps.inputs.isShared(o) })
      if (outcome.channel !== null) rt.events?.('ildra.ask.outcome', outcome)
      return outcome
    },
  }
  return rt
}
