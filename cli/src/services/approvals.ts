/**
 * Ildra approval gates: Auto / Ask / locked_ask / Never, resolved from an agent template's permission
 * lists and the user's preference profile. Port of the Ildra reference (eng/reference/ildra_ref/
 * permissions.py) plus Shield's findings F1, F3, F4 and F5. Golden parity: approvals.golden.json is
 * generated from the reference by eng/reference/make_golden.py.
 *
 * Pure policy only. Wiring into the core (CoreApi, ports, bridge tools/call hold and release, ledger)
 * is a separate reviewed change (SCOPE P1).
 *
 * Open, hooks only (not enforced yet):
 * - F2: answers must bind to request id plus digest8, single use, expiry, spoken challenge, signed
 *   answers before GA. See AskRequest, AskAnswer, AnswerVerifier. Needs the cable frames (Volt).
 * - F6: pairing a new Ask channel must itself be locked_ask on device touch. See PairingGuard (App).
 */

export type Tier = 'auto' | 'ask' | 'locked_ask' | 'never'
export type AskChannel = 'voice' | 'touch' | 'phone'

/** Higher is stricter. */
export const TIER_RANK: Readonly<Record<Tier, number>> = { auto: 0, ask: 1, locked_ask: 2, never: 3 }
const PRECEDENCE: readonly Tier[] = ['never', 'locked_ask', 'ask', 'auto']

export const DEFAULT_ASK_CHANNEL: readonly AskChannel[] = ['voice', 'touch', 'phone']
/** Shield F3: only these channels may answer an Ask. */
export const KNOWN_CHANNELS: ReadonlySet<string> = new Set(DEFAULT_ASK_CHANNEL)
/** DECISIONS 2026-10-14: voice money approvals up to $50; above that on the phone. */
export const VOICE_MONEY_LIMIT_MINOR = 5000

export interface ApprovalTemplate {
  permissions?: Partial<Record<Tier, readonly unknown[] | null>> | null
}

export interface ApprovalProfile {
  approval_strictness?: unknown
  ask_channel?: readonly unknown[] | null
  [key: string]: unknown
}

export class ApprovalDenied extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalDenied'
  }
}

export interface AskResult {
  approved: boolean
  channel: AskChannel | null
  tier: Tier
}

function baseTier(template: ApprovalTemplate, action: string, isWrite: boolean): Tier {
  const perms = template.permissions ?? {}
  for (const tier of PRECEDENCE) {
    const list = perms[tier] ?? []
    if (list.some((item) => typeof item === 'string' && item === action)) return tier
  }
  // FORMAT.md Rule 5: an unlisted write falls back to Ask; an unlisted read is Auto.
  return isWrite ? 'ask' : 'auto'
}

/** Tier for an action. The profile can only tighten: strict turns Auto into Ask. */
export function resolve(template: ApprovalTemplate, action: string, profile?: ApprovalProfile | null, isWrite = true): Tier {
  const tier = baseTier(template, action, isWrite)
  if (tier === 'auto' && profile?.approval_strictness === 'strict') return 'ask'
  return tier
}

/** Tier after a requested change. Throws ApprovalDenied for any loosening or any change to Never. */
export function applyOverride(template: ApprovalTemplate, action: string, requested: Tier, profile?: ApprovalProfile | null): Tier {
  const current = baseTier(template, action, true)
  if (current === 'never' && requested !== 'never') throw new ApprovalDenied(`never item cannot be changed: ${action}`)
  if (TIER_RANK[requested] < TIER_RANK[current]) throw new ApprovalDenied(`cannot loosen ${current} to ${requested}: ${action}`)
  const resolved = resolve(template, action, profile)
  return TIER_RANK[requested] >= TIER_RANK[resolved] ? requested : resolved
}

/** Shield F1: voice is the weakest channel. locked_ask and money over the limit need touch or phone. */
export function voiceAllowed(tier: Tier, amountMinor?: number | null, limitMinor = VOICE_MONEY_LIMIT_MINOR): boolean {
  if (tier === 'locked_ask') return false
  if (amountMinor != null && amountMinor > limitMinor) return false
  return true
}

/** F6 hook (not enforced by default): may this channel answer? Pairing itself must be locked_ask on touch. */
export type PairingGuard = (channel: AskChannel) => boolean

/** First usable channel in the profile order, or null (fail closed). */
export function askChannelFor(
  tier: Tier,
  profile?: ApprovalProfile | null,
  available?: readonly string[] | null,
  amountMinor?: number | null,
  extra: { allowVoice?: boolean; isPaired?: PairingGuard } = {},
): AskChannel | null {
  const configured = profile?.ask_channel
  const order: readonly unknown[] = configured && configured.length > 0 ? configured : DEFAULT_ASK_CHANNEL
  const allowVoice = voiceAllowed(tier, amountMinor) && extra.allowVoice !== false
  for (const c of order) {
    if (typeof c !== 'string' || !KNOWN_CHANNELS.has(c)) continue
    if (c === 'voice' && !allowVoice) continue
    if (available != null && !available.includes(c)) continue
    if (c === 'phone' && extra.isPaired && !extra.isPaired(c)) continue
    return c as AskChannel
  }
  return null
}

// ---- F4: read vs write comes from the bridge tool manifest, never from the caller ----

export interface ToolManifestEntry {
  name: string
  readOnly?: unknown
  annotations?: { readOnlyHint?: unknown } | null
}

/** A tool is a read only when the manifest lists it as read-only. Unknown tools are writes. */
export function classifyTool(manifest: readonly ToolManifestEntry[] | null | undefined, toolName: string): 'read' | 'write' {
  const entry = manifest?.find((e) => e.name === toolName)
  if (!entry) return 'write'
  if (entry.readOnly === true || entry.annotations?.readOnlyHint === true) return 'read'
  return 'write'
}

export function resolveTool(
  template: ApprovalTemplate,
  toolName: string,
  manifest: readonly ToolManifestEntry[] | null | undefined,
  profile?: ApprovalProfile | null,
): Tier {
  return resolve(template, toolName, profile, classifyTool(manifest, toolName) === 'write')
}

// ---- F5: running totals per agent per rolling window ----

export interface WindowTotals {
  count: number
  amountMinor: number
}

function checkAmount(amountMinor: number | undefined, count: number): void {
  if (amountMinor !== undefined && (!Number.isInteger(amountMinor) || amountMinor < 0)) {
    throw new RangeError(`amountMinor must be a non-negative integer: ${amountMinor}`)
  }
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`count must be a positive integer: ${count}`)
}

export class ApprovalWindow {
  readonly windowMs: number
  readonly voiceMoneyLimitMinor: number
  readonly bulkCount: number
  private readonly now: () => number
  private readonly entries = new Map<string, { at: number; count: number; amountMinor: number }[]>()

  constructor(opts: { windowMs?: number; voiceMoneyLimitMinor?: number; bulkCount?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000
    this.voiceMoneyLimitMinor = opts.voiceMoneyLimitMinor ?? VOICE_MONEY_LIMIT_MINOR
    this.bulkCount = opts.bulkCount ?? 20
    this.now = opts.now ?? Date.now
  }

  private live(agentId: string) {
    const cutoff = this.now() - this.windowMs
    const kept = (this.entries.get(agentId) ?? []).filter((e) => e.at > cutoff)
    this.entries.set(agentId, kept)
    return kept
  }

  totals(agentId: string): WindowTotals {
    return this.live(agentId).reduce((t, e) => ({ count: t.count + e.count, amountMinor: t.amountMinor + e.amountMinor }), { count: 0, amountMinor: 0 })
  }

  /** Record an approved action. */
  record(agentId: string, { amountMinor, count = 1 }: { amountMinor?: number; count?: number } = {}): void {
    checkAmount(amountMinor, count)
    this.live(agentId).push({ at: this.now(), count, amountMinor: amountMinor ?? 0 })
  }

  /** Totals including this action, and whether voice may still approve it. */
  wouldExceed(agentId: string, { amountMinor, count = 1 }: { amountMinor?: number; count?: number } = {}) {
    checkAmount(amountMinor, count)
    const t = this.totals(agentId)
    const total = { count: t.count + count, amountMinor: t.amountMinor + (amountMinor ?? 0) }
    return { voiceAllowed: total.amountMinor <= this.voiceMoneyLimitMinor && total.count <= this.bulkCount, total }
  }
}

function money(minor: number): string {
  return `$${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`
}

// ---- F2 hooks (not enforced yet) ----

/** SCOPE 3.5 AskRequest. F2 will require every answer to match id and digest8, once, before expiresAt. */
export interface AskRequest {
  id: string
  digest8: string
  expiresAt: number
  /** Daemon-drawn 2-word spoken challenge for voice Asks. */
  challenge?: string
}

export interface AskAnswer {
  id: string
  digest8: string
  approved: boolean
  transcript?: string
  /** D5 (b): signature over (id, digest, counter) before GA. */
  signature?: string
}

export type AnswerVerifier = (req: AskRequest, ans: AskAnswer) => boolean

// ---- ask ----

export type AnswerFn = (channel: AskChannel, prompt: string) => unknown

export interface AskOptions {
  available?: readonly string[] | null
  /** Caller hint only. A manifest-derived kind always wins toward write (F4). */
  isWrite?: boolean
  kind?: { manifest: readonly ToolManifestEntry[] | null | undefined; tool: string }
  amountMinor?: number
  count?: number
  window?: ApprovalWindow
  agentId?: string
  isPaired?: PairingGuard
  /** F2 hook; not called yet. */
  verifier?: AnswerVerifier
}

/** Run the Ask for an action. Never rejects before any prompt; Auto needs none; no channel fails closed. */
export async function ask(
  template: ApprovalTemplate,
  action: string,
  profile: ApprovalProfile | null | undefined,
  answerFn: AnswerFn,
  opts: AskOptions = {},
): Promise<AskResult> {
  if (opts.window && !opts.agentId) throw new ApprovalDenied('approval window needs an agentId')
  let isWrite = opts.isWrite ?? true
  if (opts.kind && classifyTool(opts.kind.manifest, opts.kind.tool) === 'write') isWrite = true
  else if (opts.kind) isWrite = opts.isWrite ?? false
  const tier = resolve(template, action, profile, isWrite)
  if (tier === 'never') throw new ApprovalDenied(`never item: ${action}`)
  if (tier === 'auto') return { approved: true, channel: null, tier }

  let suffix = ''
  let allowVoice = true
  if (opts.window && opts.agentId) {
    const w = opts.window.wouldExceed(opts.agentId, { amountMinor: opts.amountMinor, count: opts.count })
    allowVoice = w.voiceAllowed
    suffix = ` (running total today: ${w.total.count} actions, ${money(w.total.amountMinor)})`
  }
  const channel = askChannelFor(tier, profile, opts.available, opts.amountMinor, { allowVoice, isPaired: opts.isPaired })
  if (channel === null) return { approved: false, channel: null, tier }
  const approved = (await answerFn(channel, `${tier.toUpperCase()}: ${action}${suffix}`)) === true
  if (approved && opts.window && opts.agentId) opts.window.record(opts.agentId, { amountMinor: opts.amountMinor, count: opts.count })
  return { approved, channel, tier }
}
