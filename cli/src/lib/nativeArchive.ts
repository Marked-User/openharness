/** The original saved Resume owns one live visit, even when later Cancel or
 * Restart replaces its rearm request. This link grants no launch permission. */
export interface NativeArchiveLink {
  readonly version: 1
  readonly agentId: string
  readonly requestId: string
  readonly launchToken: string
  readonly target: string
}

/** The archive retains its old snapshot as history while this exact live visit
 * owns control. Registry absence cannot turn it back into a saved owner. */
export interface NativeArchiveTransfer {
  readonly version: 1
  readonly link: NativeArchiveLink
  readonly pendingTarget: string
  readonly processKey: string
  readonly pane: string
}

export function parseNativeArchiveLink(value: unknown): NativeArchiveLink | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'agentId,launchToken,requestId,target,version' || row.version !== 1
    || typeof row.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.agentId)
    || typeof row.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(row.requestId)
    || typeof row.launchToken !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(row.launchToken)
    || typeof row.target !== 'string' || !/^[a-f0-9]{64}$/.test(row.target)) return null
  return Object.freeze({ version: 1, agentId: row.agentId, requestId: row.requestId, launchToken: row.launchToken, target: row.target })
}

export function parseNativeArchiveTransfer(value: unknown): NativeArchiveTransfer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>, link = parseNativeArchiveLink(row.link)
  if (Object.keys(row).sort().join(',') !== 'link,pane,pendingTarget,processKey,version' || row.version !== 1 || !link
    || typeof row.pendingTarget !== 'string' || !/^[a-f0-9]{64}$/.test(row.pendingTarget)
    || typeof row.processKey !== 'string' || !row.processKey || row.processKey.length > 512
    || typeof row.pane !== 'string' || !/^%\d{1,20}$/.test(row.pane)) return null
  return Object.freeze({ version: 1, link, pendingTarget: row.pendingTarget, processKey: row.processKey, pane: row.pane })
}
