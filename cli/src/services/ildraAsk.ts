/**
 * Ildra Asks, the service's half: runs approvals.ts ask() against the Ask journal, with the core's input paths
 * (CoreApi.ildraAsk, core/ildraAsk.ts) as the answer function and the F12 shared-origin lookup, and the core's
 * pane guard held while an Ask waits (F13). The journal opens on first use, so a daemon that never asks writes
 * nothing. Showing the Ask on its channel (`bridge`) is the gateway plugin's job; unset, every Ask is denied.
 */
import { ask as askGate, openJournal, type ApprovalJournal, type ApprovalProfile, type ApprovalTemplate, type AskAnswer, type AskAttempt, type AskChannel, type AskOptions, type AskOutcome, type AskRequest } from './approvals.js'
import type { IldraAskInputs } from '../core/api.js'

export interface IldraAsk {
  journal(): ApprovalJournal
  ask(template: ApprovalTemplate, action: string, profile: ApprovalProfile | null | undefined,
    opts: Omit<AskOptions, 'ledger' | 'pairing' | 'window' | 'isShared' | 'reference'> & { agentId: string }): Promise<AskOutcome>
  /** Shows an Ask on its channel (device prompt, phone push). Unset: every Ask is denied, never answered by keys. */
  bridge: ((channel: AskChannel, prompt: string, req: AskRequest) => void) | null
  /**
   * Daemon events for the phone (gateway plugin forwards them; also kept in the journal): ildra.ask.attempt,
   * one per device approval held under 1500 ms (DECISIONS ad47477). The Ask stays open meanwhile.
   */
  events: ((type: 'ildra.ask.attempt', body: AskAttempt) => void) | null
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
    journal: open,
    ask: async (template, action, profile, opts) => {
      const j = open()
      return askGate(template, action, profile, async (channel, prompt, req) => (await deps.inputs.awaitAnswer(req!, req!.agentId ?? opts.agentId, () => {
        if (!rt.bridge) throw new Error('no Ildra Ask bridge connected')
        rt.bridge(channel, prompt, req!)
      })) as AskAnswer | null, { ...opts, ledger: j.ledger, pairing: j.pairing, window: j.window, isShared: (o) => deps.inputs.isShared(o) })
    },
  }
  return rt
}
