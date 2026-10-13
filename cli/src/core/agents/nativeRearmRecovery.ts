/** A claimed native restart can be confirmed, never launched a second time. */
import { creationFingerprint, type AgentCreationReceipts, type AgentCreationStatus } from '../../lib/agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnTarget, parseNativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession, registry } from '../../lib/registry.js'
import type { createNativeRearmProof } from '../../engines/kit/nativeRearmProof.js'

export interface NativeRearmRecoveryDeps {
  registry: Pick<typeof registry, 'byAgent' | 'readNativeControl' | 'readNativeReplacementSource' | 'commitNativeReplacement'>
  receipts: Pick<AgentCreationReceipts, 'confirmNativeRelaunch'>
  proof: ReturnType<typeof createNativeRearmProof>
  held(agentId: string, reason: string): void
}

/** Recovery has no launch callback. A bounded reply never releases an occupied
 * native read, and Cancel/shutdown revoke the original attempt before it settles. */
export function createNativeRearmRecovery({ registry, receipts, proof, held }: NativeRearmRecoveryDeps) {
  type Attempt = { revoked: boolean; deadline: number }
  const attempts = new Map<string, Attempt>()
  let closed = false
  const sameOwner = (row: RegisteredSession, current = registry.byAgent(row.agentId)) => !!current
    && nativeTurnTarget(current) === nativeTurnTarget(row)
    && creationFingerprint(current.nativeControl ?? null) === creationFingerprint(row.nativeControl ?? null)
  const hold = (row: RegisteredSession, reason: string, publish = true): AgentCreationStatus => {
    const detail = `Waiting to confirm the original native launch: ${reason}.`
    if (publish && !closed && sameOwner(row)) {
      try { held(row.agentId, detail) }
      catch { /* A status notification cannot strand session control or its reply. */ }
    }
    return { state: 'pending', held: { service: 'native', detail } }
  }

  return {
    recover(input: RegisteredSession): Promise<AgentCreationStatus> {
      let owner = structuredClone(input)
      const agentId = owner.agentId
      const control = parseNativeTurnIntent(owner.nativeControl), rearm = control?.rearm
      const request = control && nativeRearmRequest(control)
      if (closed || owner.engine !== 'cursor' || !owner.sessionId || !rearm || rearm.source !== 'live' || rearm.revoked || !request) {
        return Promise.resolve(hold(owner, 'the complete live reservation is unavailable'))
      }
      if (attempts.has(owner.agentId) || attempts.size >= 4) return Promise.resolve(hold(owner, 'original recovery reads are still occupied'))
      const attempt: Attempt = { revoked: false, deadline: performance.now() + 5000 }
      attempts.set(owner.agentId, attempt)
      let actual: Promise<void> | undefined
      const present = () => !closed && !attempt.revoked && attempts.get(agentId) === attempt
      const current = () => {
        if (closed || attempt.revoked || attempts.get(owner.agentId) !== attempt || performance.now() >= attempt.deadline
          || !sameOwner(owner)) throw Error('the original recovery owner or deadline changed')
      }
      const fingerprint = creationFingerprint({ kind: 'native-rearm', agentId: rearm.agentId,
        operation: rearm.operation, source: rearm.source,
        ...(rearm.permissionMode === undefined ? {} : { permissionMode: rearm.permissionMode }),
      })
      const receipt = { fingerprint, request }
      const recover = async (): Promise<AgentCreationStatus> => {
        current()
        const source = rearm.replacement ? registry.readNativeControl(owner) : registry.readNativeReplacementSource(owner)
        const fence = { verify: () => { source.verify(); current() }, current }
        const observation = rearm.replacement ? proof(owner, receipt, fence)
          : proof.recover(owner, receipt, fence, owner.tmuxPane)
        actual = observation.settled
        const replacement = await observation
        fence.verify(); replacement.verify(); current()
        if (!rearm.replacement) {
          const committed = registry.commitNativeReplacement(owner, replacement, current)
          // Only the exact durable commit can change this attempt's owner. Its
          // former file proof is intentionally invalidated by that same rename.
          owner = structuredClone(committed)
        }
        const published = registry.readNativeControl(owner)
        const verify = () => { published.verify(); replacement.verifyExecution(); current() }
        verify()
        const verifyConfirmation = () => { published.verify(); replacement.verifyConfirmation(); current() }
        let confirmed: { verify(): void } | undefined
        const status = receipts.confirmNativeRelaunch(rearm.requestId, { ...receipt,
          outcome: { state: 'created', agentId: owner.agentId, resumed: true },
        }, { verify: verifyConfirmation, current: () => { replacement.current(); current() } }, retained => { confirmed = retained })
        if (!confirmed) throw Error('the original confirmation proof is unavailable')
        confirmed.verify()
        return status
      }
      return new Promise(resolve => {
        let replied = false
        const finish = (status: AgentCreationStatus) => { replied = true; clearTimeout(timer); resolve(status) }
        const timer = setTimeout(() => {
          const publish = present()
          attempt.revoked = true
          finish(hold(owner, 'native recovery exceeded its deadline', publish))
        }, 5000)
        void recover().then(finish, error => {
          if (!replied) finish(hold(owner, error instanceof Error ? error.message : String(error), present()))
        }).finally(async () => {
          attempt.revoked = true
          await actual
          attempts.delete(agentId)
        })
      })
    },
    revoke(agentId: string): void { const attempt = attempts.get(agentId); if (attempt) attempt.revoked = true },
    close(): void { closed = true; for (const attempt of attempts.values()) attempt.revoked = true },
  }
}
