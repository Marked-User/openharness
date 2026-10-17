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
import type { Asker, IldraAnswerOrigin, IldraAskInputs, IldraPaneGuard, ServiceRequest } from './api.js'

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

export type IldraAnswerReply = { ok: true } | { ok: false; reason: 'malformed' | 'no_connection' | 'unknown_id' }

export interface IldraAskCore extends IldraAskInputs {
  readonly requests: { ildra_ask_answer: (payload: Record<string, unknown>, asker: Asker) => Promise<IldraAnswerReply> } & Record<string, ServiceRequest>
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

  const originOf = (connId: string | undefined, claimed: unknown): IldraAnswerOrigin | null => {
    if (!connId) return null
    const c = claimed && typeof claimed === 'object' ? (claimed as Record<string, unknown>) : {}
    const phoneId = typeof c.phoneId === 'string' && c.phoneId ? c.phoneId : undefined
    if (deps.isLoopback(connId)) return phoneId ? { phoneId } : {}
    const client = deps.clientOf(connId)
    if (!client || typeof client.identity !== 'string' || !client.identity) return null
    sharedByPub.set(client.identity, client.shared === true)
    return { machinePub: client.identity, ...(phoneId ? { phoneId } : {}) }
  }

  const core: IldraAskCore = {
    guard,
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
        const from = originOf(asker.connection, payload.from)
        if (!from) return { ok: false, reason: 'no_connection' }
        const answer: Record<string, unknown> = {
          id: payload.id, digest8: payload.digest8, answerId: payload.answerId /* checked by the ledger (malformed) */, approved: payload.approved === true, from,
          ...(typeof payload.holdMs === 'number' ? { holdMs: payload.holdMs } : {}),
          ...(typeof payload.transcript === 'string' ? { transcript: payload.transcript } : {}),
          ...(typeof payload.signature === 'string' ? { signature: payload.signature } : {}),
        }
        const finish = waiting.get(payload.id)
        // No open Ask waits for it: nothing to approve. The ledger never sees it, so it cannot spend one either.
        if (!finish) return { ok: false, reason: 'unknown_id' }
        core.onAnswer?.(payload.id, answer)
        finish(answer)
        return { ok: true }
      },
    },
  }
  return core
}
