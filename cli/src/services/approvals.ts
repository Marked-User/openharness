/**
 * Ildra approval gates: Auto / Ask / locked_ask / Never, resolved from an agent template's permission
 * lists and the user's preference profile. Port of the Ildra reference (eng/reference/ildra_ref/
 * permissions.py) plus Shield's findings F1, F3, F4 and F5. Golden parity: approvals.golden.json is
 * generated from the reference by eng/reference/make_golden.py.
 *
 * Pure policy only. Wiring into the core (CoreApi, ports, bridge tools/call hold and release, ledger)
 * is a separate reviewed change (SCOPE P1).
 *
 * Shield pilot privacy review (ildra 85eb9f3): unknown tools can send (only manifest send:false opts out),
 * the install marker never sits in the journal's folder, locked_ask and money Asks are phone-only, and a
 * device (touch) approval needs holdMs >= DEVICE_HOLD_MIN_MS.
 *
 * Production is the default: ask() requires a ledger (F2), a tool manifest (F4) and, for money or
 * send Asks, an approval window (F5). That mode adds F2 (id + digest8, single use, expiry, 2-word spoken challenge,
 * AnswerVerifier), the required MicGuard for voice, F6 minimum (PhonePairing: touch on device plus a
 * single-use code) and F8 (send Asks name recipient and first line). openJournal persists F5 totals,
 * pending Asks and pairings. Hooks for Volt: MicGuard implementation, AskAnswer.signature (D5 b) via
 * AnswerVerifier. `reference: true` keeps exact parity with eng/reference and is never for production.
 * Expiry: money Asks 1 h, others 24 h. Shared-account machines (#1358) never answer or pair. Phone MCP
 * Accept/Decline (#1340) goes through answerMcpElicitation. Sync order (F11) is syncOrder.ts.
 */

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path'
import { HIDDEN_DATA } from './unicode/hidden.js'
import { ENROLL_UV, deviceFingerprint, rawDeviceKey, rawPhoneKey, stampedChannel, verifyPhoneSignature, type EnrollUv } from '../core/api.js'
export { deviceFingerprint, deviceProofMessage, verifyDeviceProof } from '../core/api.js'
import { isLookalike, isNewRecipient, lookalikeOf, recipientAscii, recipientKey, type RecipientKnowledge } from './recipient.js'

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
  /** locked_ask actions that are safety verification steps (AskRequest.kind, display only). */
  safety_verification?: readonly unknown[] | null
}

/**
 * AskRequest.kind: display only, never in digest8; set by the daemon, never the caller. safety_verification only
 * on locked_ask; practice (PM Q52) only on the daemon's own first-run practice Ask (practiceAsk), which carries
 * no real action.
 */
export type AskKind = 'safety_verification' | 'practice'

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

/**
 * Shield pilot review A1: locked_ask and money Asks are answered on the paired phone only, never on the
 * device (touch) or by voice. Production ask() and AskLedger.open enforce it; reference mode does not.
 */
export function phoneOnly(tier: Tier, amountMinor?: number | null, flags?: readonly RecipientFlag[] | null): boolean {
  return tier === 'locked_ask' || amountMinor != null || phoneOnlyRecipient(flags)
}

/**
 * Shield pilot review A1: a device (touch) approval is a deliberate hold of at least this long.
 * R3-2: `holdMs` is client-claimed. For M1 the device link is daemon-owned (only the daemon's own device
 * bridge can answer on the touch channel), so the claim is as trustworthy as that link. GA needs the
 * firmware to measure the hold and sign it over (id, digest8, holdMs, counter): see signedHoldVerifier (D5 b).
 */
export const DEVICE_HOLD_MIN_MS = 1500

/** F6 hook (not enforced by default): may this channel answer? Pairing itself must be locked_ask on touch. */
export type PairingGuard = (channel: AskChannel) => boolean

/** First usable channel in the profile order, or null (fail closed). */
export function askChannelFor(
  tier: Tier,
  profile?: ApprovalProfile | null,
  available?: readonly string[] | null,
  amountMinor?: number | null,
  extra: { allowVoice?: boolean; isPaired?: PairingGuard; phoneOnly?: boolean } = {},
): AskChannel | null {
  const configured = profile?.ask_channel
  const order: readonly unknown[] = configured && configured.length > 0 ? configured : DEFAULT_ASK_CHANNEL
  const allowVoice = voiceAllowed(tier, amountMinor) && extra.allowVoice !== false
  for (const c of order) {
    if (typeof c !== 'string' || !KNOWN_CHANNELS.has(c)) continue
    if (c === 'voice' && !allowVoice) continue
    if (extra.phoneOnly && c !== 'phone') continue
    if (available != null && !available.includes(c)) continue
    if (c === 'phone' && extra.isPaired && !extra.isPaired(c)) continue
    return c as AskChannel
  }
  return null
}

// ---- R3-2 (GA, D5 b): signed device hold. Hook only; not wired for M1 ----

/** Canonical bytes the device firmware signs for a hold: version, request id, digest8, holdMs, counter. */
export function signedHoldPayload(id: string, digest8: string, holdMs: number, counter: number): string {
  return `ildra-hold-v1|${id}|${digest8}|${holdMs}|${counter}`
}

/**
 * GA stub (Volt, D5 b): an AnswerVerifier that requires a touch answer's `signature` to verify over
 * signedHoldPayload with the device's next monotonic counter (daemon-held, so a replayed signature fails).
 * Phone and voice answers pass through. `verify` is the device-key check (Ed25519 or HMAC, Volt's choice).
 * Not passed to any ledger in M1.
 */
export function signedHoldVerifier(deps: { nextCounter: () => number; verify: (payload: string, signature: string) => boolean }): AnswerVerifier {
  return (req, ans) => {
    if (req.channel !== 'touch') return true
    if (typeof ans.signature !== 'string' || typeof ans.holdMs !== 'number') return false
    try {
      return deps.verify(signedHoldPayload(req.id, ans.digest8, ans.holdMs, deps.nextCounter()), ans.signature) === true
    } catch {
      return false
    }
  }
}

// ---- F4: read vs write comes from the bridge tool manifest, never from the caller ----

export interface ToolManifestEntry {
  name: string
  readOnly?: unknown
  annotations?: { readOnlyHint?: unknown } | null
  /** F8: the tool sends a message to someone. Only literal false opts out, and only from a trusted owner (R3-3). */
  send?: unknown
  /** AskRequest.kind safety_verification for this tool's locked_ask (trusted owners only, like send:false). */
  safetyVerification?: unknown
  /**
   * Shield R3-3: where this entry came from, stamped by the daemon's manifest loader (stampManifest),
   * never taken from the manifest itself. Only 'first_party' or 'bridge' entries may declare send:false.
   */
  owner?: unknown
  /**
   * Shield R5-2: the MCP server (or bridge) the entry was loaded from, set by the loader. Entries are keyed
   * by server+tool (`server/name`); a bare name that matches more than one entry is a sending write tool.
   */
  server?: unknown
}

/** Manifest sources whose send:false is believed (R3-3). */
export const TRUSTED_MANIFEST_OWNERS: ReadonlySet<string> = new Set(['first_party', 'bridge'])
export type ManifestSource = 'first_party' | 'bridge' | 'third_party'

/**
 * Shield R3-3: copy a manifest with `owner` set from where the daemon loaded it. Any owner the manifest
 * claims for itself is overwritten, so a third-party (store) manifest cannot pose as bridge-owned. An
 * unknown source is stamped third_party.
 */
export function stampManifest(
  entries: readonly ToolManifestEntry[] | null | undefined, source: ManifestSource, server?: string,
): ToolManifestEntry[] {
  const owner: ManifestSource = source === 'first_party' || source === 'bridge' ? source : 'third_party'
  return (entries ?? []).map((e) => {
    const out: ToolManifestEntry = { ...e, owner }
    if (server !== undefined) out.server = server
    else delete out.server
    if (out.annotations) out.annotations = Object.freeze({ ...out.annotations })
    Object.freeze(out)
    STAMPED.add(out)
    return out
  })
}

/**
 * Shield R5-2: entries that came out of stampManifest (frozen, so nothing changes them afterwards). An
 * owner on any other object, a copy included, is the manifest's own claim and is not believed.
 */
const STAMPED = new WeakSet<object>()

/** True only for an entry stampManifest made with a first-party or bridge source. */
export function trustedEntry(e: ToolManifestEntry): boolean {
  return STAMPED.has(e) && typeof e.owner === 'string' && TRUSTED_MANIFEST_OWNERS.has(e.owner)
}

/**
 * Shield R5-2: the one entry for a tool, keyed by server+tool. `tool` is `server/name` or a bare name. An
 * entry matches when its `server/name` key or its bare name equals `tool`. No match is 'missing'; more
 * than one (a third-party tool reusing a first-party name, or two servers with the same tool) is
 * 'ambiguous', which every caller treats as a sending write tool with no kind.
 */
export function lookupTool(
  manifest: readonly ToolManifestEntry[] | null | undefined, tool: string,
): ToolManifestEntry | 'missing' | 'ambiguous' {
  const hits = (manifest ?? []).filter((e) => e.name === tool || (typeof e.server === 'string' && `${e.server}/${e.name}` === tool))
  if (hits.length === 0) return 'missing'
  return hits.length === 1 ? hits[0]! : 'ambiguous'
}

/**
 * Shield R5-2: the daemon's manifest loader. Every source is stamped with where it was loaded from
 * (first_party, bridge, third_party) and its server name, so the merged manifest is keyed by server+tool
 * and no entry's owner comes from the manifest itself.
 */
export class ToolManifestLoader {
  private readonly bySource = new Map<string, ToolManifestEntry[]>()
  /** Replace what `server` declared, stamped as `source`. */
  load(source: ManifestSource, server: string, entries: readonly ToolManifestEntry[] | null | undefined): void {
    if (typeof server !== 'string' || !server) throw new ApprovalDenied('a tool manifest needs its server name')
    this.bySource.set(server, stampManifest(entries, source, server))
  }
  unload(server: string): void { this.bySource.delete(server) }
  entries(): ToolManifestEntry[] { return [...this.bySource.values()].flat() }
}

/**
 * F8 + Shield pilot review (a): a tool can send unless the manifest lists it with literal `send: false`
 * from a first-party or bridge-owned entry stamped by the loader (R3-3, R5-2; see stampManifest).
 * Missing from the manifest, listed more than once, no manifest, or any other value means it gets the
 * recipient and first-line checks. The caller can tighten (isSend, send details), never loosen.
 */
export function isSendTool(manifest: readonly ToolManifestEntry[] | null | undefined, toolName: string): boolean {
  const e = lookupTool(manifest, toolName)
  if (typeof e === 'string' || e.send !== false) return true
  return !trustedEntry(e)
}

/**
 * A tool is a read only when a trusted manifest entry (first_party or bridge, stamped; R7-4) lists it, once, as
 * read-only. Unknown, duplicate and third-party tools are writes, whatever hints they carry.
 */
export function classifyTool(manifest: readonly ToolManifestEntry[] | null | undefined, toolName: string): 'read' | 'write' {
  const entry = lookupTool(manifest, toolName)
  if (typeof entry === 'string') return 'write'
  // Shield R7-4: a read-only claim (readOnly or the MCP readOnlyHint) is believed only from a first-party or
  // bridge entry stamped by the loader. A third-party tool is a write (Ask) whatever it says about itself.
  if (!trustedEntry(entry)) return 'write'
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

type WindowEntry = { at: number; count: number; amountMinor: number }

export class ApprovalWindow {
  readonly windowMs: number
  readonly voiceMoneyLimitMinor: number
  readonly bulkCount: number
  private readonly now: () => number
  private readonly entries = new Map<string, WindowEntry[]>()
  /** Set when a journal could not be read: voice stays off for every agent until this time. */
  lockedUntil = 0
  onChange?: () => void

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
    this.onChange?.()
  }

  /** Totals including this action, and whether voice may still approve it. */
  wouldExceed(agentId: string, { amountMinor, count = 1 }: { amountMinor?: number; count?: number } = {}) {
    checkAmount(amountMinor, count)
    const t = this.totals(agentId)
    const total = { count: t.count + count, amountMinor: t.amountMinor + (amountMinor ?? 0) }
    const ok = total.amountMinor <= this.voiceMoneyLimitMinor && total.count <= this.bulkCount && this.now() >= this.lockedUntil
    return { voiceAllowed: ok, total }
  }

  toJSON(): { lockedUntil: number; entries: Record<string, WindowEntry[]> } {
    const entries: Record<string, WindowEntry[]> = {}
    for (const id of [...this.entries.keys()]) {
      const live = this.live(id)
      if (live.length) entries[id] = live.map((e) => ({ ...e }))
    }
    return { lockedUntil: this.lockedUntil, entries }
  }

  /** @internal journal restore; entries are validated by the caller. */
  restore(data: { lockedUntil: number; entries: Record<string, WindowEntry[]> }): void {
    this.lockedUntil = data.lockedUntil
    for (const [id, list] of Object.entries(data.entries)) this.entries.set(id, list.map((e) => ({ ...e })))
  }
}

function money(minor: number): string {
  return `$${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`
}

// ---- F2: answers bound to request id + digest8, single use, expiry, spoken challenge ----

/**
 * RFC 8785 (JCS) canonical JSON for the values a digest covers: object keys sorted by UTF-16 code units, no
 * whitespace, strings and numbers as ECMAScript JSON.stringify writes them, null kept, undefined members
 * dropped. A non-finite number or a value JSON cannot hold is refused rather than guessed at.
 */
/**
 * DEVICE-INTERFACE v3: a lone UTF-16 surrogate anywhere in the digest input (action, a detail, a key, the
 * message) makes the Ask malformed: it is refused, never opened. UTF-8 cannot carry one, so two encoders would
 * hash different bytes (JSON.stringify escapes it, Buffer writes U+FFFD).
 */
export class InvalidUnicode extends ApprovalDenied {
  constructor() { super('a digest cannot cover a lone surrogate (malformed)') }
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
export function hasLoneSurrogate(s: string): boolean { return LONE_SURROGATE.test(s) }

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' && hasLoneSurrogate(value)) throw new InvalidUnicode()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApprovalDenied('a digest cannot cover a non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const k of Object.keys(obj)) if (hasLoneSurrogate(k)) throw new InvalidUnicode()
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
  }
  throw new ApprovalDenied(`a digest cannot cover a ${typeof value}`)
}

/** Fields the digest names itself; a detail may not reuse them. recipient and messageSha256 arrive as details. */
const DIGEST_RESERVED = ['action', 'agentId', 'tier', 'amountMinor', 'currency'] as const

/**
 * digest8 (protocol/README.md "Digest"): the first 8 lowercase hex characters of sha256 over the JCS canonical
 * JSON of one flat object {action, agentId, tier, amountMinor, currency, recipient, messageSha256, ...details},
 * undefined members dropped. messageSha256 is the hex sha256 of the full UTF-8 message. channel, ids, times
 * and display-only fields are not covered (so a device-to-phone handoff keeps the digest). A string recipient is
 * NFC-normalized before hashing (v3.3).
 */
export function actionDigest8(action: string, fields: Record<string, unknown> = {}): string {
  return createHash('sha256').update(digestInput(action, fields), 'utf8').digest('hex').slice(0, 8)
}

/**
 * The JCS text digest8 hashes. v3.3 (Shield): a string `recipient` is NFC-normalized first, so an un-normalized
 * (NFD) recipient gives the same digest8 as its NFC form (protocol/examples/vectors/digest8.json).
 */
export function digestInput(action: string, fields: Record<string, unknown> = {}): string {
  if ('action' in fields) throw new ApprovalDenied('a digest field may not be named action')
  const f = typeof fields.recipient === 'string' ? { ...fields, recipient: fields.recipient.normalize('NFC') } : fields
  return canonicalJson({ ...f, action })
}

/** Distinct, easy-to-say words. Not a PIN: a fresh pair is drawn per Ask by the daemon. */
export const CHALLENGE_WORDS: readonly string[] = [
  'amber', 'anchor', 'apple', 'arrow', 'autumn', 'badger', 'bamboo', 'banner', 'basket', 'beacon',
  'birch', 'bison', 'blossom', 'bramble', 'breeze', 'bridge', 'bronze', 'butter', 'cactus', 'candle',
  'canyon', 'carrot', 'castle', 'cedar', 'cherry', 'cliff', 'clover', 'cobalt', 'comet', 'copper',
  'coral', 'cotton', 'crystal', 'daisy', 'desert', 'dolphin', 'dragon', 'eagle', 'ember', 'falcon',
  'feather', 'fern', 'forest', 'fossil', 'garden', 'ginger', 'glacier', 'harbor', 'hazel', 'honey',
  'island', 'ivory', 'jasmine', 'jungle', 'kettle', 'lantern', 'lemon', 'lizard', 'magnet', 'mango',
  'maple', 'marble', 'meadow', 'mirror', 'otter', 'pebble', 'pepper', 'pillow', 'planet', 'pumpkin',
  'quartz', 'rabbit', 'river', 'rocket', 'saddle', 'salmon', 'silver', 'spruce', 'thunder', 'tiger',
  'timber', 'tulip', 'velvet', 'walnut', 'willow', 'winter', 'yellow', 'zebra',
]

/** Draw two different words. `rand(n)` returns an integer in [0, n); defaults to crypto randomInt. */
export function drawChallenge(rand: (n: number) => number = (n) => randomInt(n)): string {
  const n = CHALLENGE_WORDS.length
  const a = rand(n)
  let b = rand(n)
  while (b === a) b = rand(n)
  return `${CHALLENGE_WORDS[a]} ${CHALLENGE_WORDS[b]}`
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z]+/).filter(Boolean)
}

/** The transcript must contain the challenge words, adjacent and in order. Checked by the daemon (R12). */
export function transcriptMatches(challenge: string, transcript: string | undefined): boolean {
  if (typeof transcript !== 'string') return false
  const want = words(challenge)
  const got = words(transcript)
  for (let i = 0; i + want.length <= got.length; i++) {
    if (want.every((w, j) => got[i + j] === w)) return true
  }
  return false
}

/** DECISIONS 2026-10-15: an Ask with an amount expires 1 h after it opens, any other Ask after 24 h. */
export const MONEY_ASK_EXPIRY_MS = 60 * 60 * 1000
export const OTHER_ASK_EXPIRY_MS = 24 * 60 * 60 * 1000

export function askExpiryMs(amountMinor?: number | null): number {
  return amountMinor != null ? MONEY_ASK_EXPIRY_MS : OTHER_ASK_EXPIRY_MS
}

/** Reference `ask_expired`: expired once now - opened >= expiry. */
export function askExpired(openedAt: number, now: number, amountMinor?: number | null): boolean {
  return now - openedAt >= askExpiryMs(amountMinor)
}

/** SCOPE 3.5 AskRequest. Field names match the cable `ask.request` frame. */
export interface AskRequest {
  /** Random UUID chosen by the daemon. */
  id: string
  /** actionDigest8 over {action, agentId, tier, amountMinor, currency, recipient, messageSha256, ...details}. */
  digest8: string
  /** Epoch ms when the Ask opened. */
  openedAt: number
  /** Epoch ms; an answer at or after this is rejected. openedAt + 1 h with an amount, else + 24 h. */
  expiresAt: number
  channel: AskChannel
  tier: Tier
  /** Amount in minor units (cents), integer; present means this is a money Ask. */
  amountMinor?: number
  /** ISO 4217, 'USD' for now. Present exactly when amountMinor is. Bound into digest8. */
  currency?: 'USD'
  /** The asking agent. In digest8 (DECISIONS 2). */
  agentId?: string
  /** Display only. */
  templateId?: string
  /** The action as listed in the template. Display; the action is also in digest8. */
  action: string
  /** Send Asks: recipient. Display; bound into digest8 via the send details. */
  recipient?: string
  /** Send Asks: first non-empty line of the message, trimmed, at most 80 chars, hidden characters marked (R5-5). Display only. */
  firstLine?: string
  /** Send Asks: display and routing flags about the recipient (R5-5, v3.3). Daemon-set, not in digest8. */
  recipientFlags?: RecipientFlag[]
  /** Send Asks: the recipient with its domain in ASCII (punycode), local part as is (v3.3). Display only. */
  recipientAscii?: string
  /**
   * Send Asks with the lookalike flag (v3.3): the known contact or domain it matched, in ASCII form (domain in
   * punycode), so the phone can say "It looks like dana@acme.com". Daemon-set, display only, not in digest8.
   */
  lookalikeOf?: string
  /** Display only, not in digest8; locked_ask only; daemon-set (askKindFor). */
  kind?: AskKind
  /** Daemon-drawn 2-word spoken challenge, voice Asks only. */
  challenge?: string
}

/** Where an answer came from (gateway trust). Shared-account machines (#1358) never answer. */
export interface AnswerOrigin {
  /** Paired phone id, required when channel is phone. */
  phoneId?: string
  /** The answering machine's public key, looked up against the gateway's shared trust (F12). */
  machinePub?: string
  /**
   * Untrusted claim. Never used to clear an answer: true still rejects; false is ignored. Whether the
   * origin is shared comes from the gateway (SharedOriginLookup, fed by sharedMachines.ts trustedKeys).
   */
  shared?: boolean
}

/** F12: true when the gateway trusts this origin only through machine sharing (#1358). */
export type SharedOriginLookup = (origin: AnswerOrigin) => boolean

/** Build a lookup from the gateway's shared peers (sharedMachines.ts `trustedKeys`, sharedTrust pins/keys). */
export function sharedOriginFromPeers(peers: readonly { pub: string; machineId?: string }[]): SharedOriginLookup {
  const pubs = new Set(peers.map((p) => p.pub))
  return (o) => typeof o.machinePub === 'string' && pubs.has(o.machinePub)
}

function originShared(origin: AnswerOrigin | undefined, lookup?: SharedOriginLookup): boolean {
  if (origin?.shared === true) return true
  if (!lookup) return false
  try { return lookup(origin ?? {}) !== false } catch { return true }
}

export interface AskAnswer {
  id: string
  digest8: string
  /**
   * DECISIONS ad47477: chosen fresh by the answering surface for every answer, 16 to 64 of [A-Za-z0-9-] (phone:
   * a UUID; device: Gadget answer_id, 32 hex). Single use: the ledger refuses one it has seen (journaled).
   */
  answerId: string
  /**
   * Shield R5-1, daemon-internal (never on the wire, never from a payload): the channel the answer's connection
   * may answer on, set by core/ildraAsk.ts from the gateway-authenticated connection. 'touch' only for the device
   * bridge session; 'phone' for other remote sessions (then from.machinePub must be the paired phone's key).
   */
  via?: AskChannel
  /** Only literal true approves. */
  approved: boolean
  transcript?: string
  from?: AnswerOrigin
  /**
   * Device (touch) answers: how long the approve control was held, measured by the firmware (Volt).
   * An approval on the touch channel without a finite holdMs of DEVICE_HOLD_MIN_MS or more is rejected.
   */
  holdMs?: number
  /** D5 (b) hook for Volt: signature over (id, digest, counter). Checked by an AnswerVerifier, not here. */
  signature?: string
}

/** Extra check after the built-in ones, e.g. D5 (b) signed answers (Volt). Must return literal true. */
export type AnswerVerifier = (req: AskRequest, ans: AskAnswer) => boolean

export type SettleReason =
  | 'malformed' | 'unknown_id' | 'replayed' | 'expired' | 'digest_mismatch' | 'challenge_mismatch'
  | 'verifier_rejected' | 'shared_machine' | 'unpaired_phone' | 'hold_too_short' | 'stale_channel'
  | 'wrong_channel' | 'hold_limit' | 'busy' | 'no_authority' | 'bad_signature'
/**
 * The wire's AskRejectionReason, in schema order. busy and no_authority come from the runtime, never from the
 * ledger: busy, another answer to the same open Ask is being settled right now (services/ildraAsk.ts);
 * no_authority, the connection may not answer at all (local socket, observer, an unknown connection;
 * core/ildraAsk.ts), refused before the ledger, so its answerId is not recorded.
 */
export const ASK_REJECTION_REASONS: readonly SettleReason[] = [
  'malformed', 'unknown_id', 'replayed', 'expired', 'digest_mismatch', 'challenge_mismatch', 'verifier_rejected',
  'shared_machine', 'unpaired_phone', 'hold_too_short', 'stale_channel', 'wrong_channel', 'hold_limit', 'busy', 'no_authority',
  // Shield deny key (batch A): an AskAnswer.phoneSignature by neither paired phone key (core/ildraAsk.ts, before the ledger).
  'bad_signature',
]
export type SettleResult = { ok: true } | { ok: false; reason: SettleReason }

/**
 * answerId: fresh per answer, 16 to 64 characters of [A-Za-z0-9-] (the phone sends a UUID, the device firmware
 * 32 hex from 128 random bits as Gadget answer_id). Protocol schema $defs/AnswerId.
 */
export const ANSWER_ID = /^[A-Za-z0-9-]{16,64}$/

/**
 * ildra.ask.attempt: a device approval held too briefly (DECISIONS ad47477). The Ask stays open; the daemon
 * emits one of these per short hold and keeps it in the journal so the phone can show the attempts.
 */
/** v3.3: channel is the channel the rejected answer came from (touch, voice or phone). A short hold is a rejected gesture, not an answer. */
/**
 * ildra.ask.attempt: an answer that was rejected. From the device (touch, voice): hold_too_short or stale_channel
 * only, and the Ask stays open. v3.3, channel phone: every rejected answer from the phone to a known Ask
 * (digest_mismatch, malformed, busy, replayed, expired, wrong_channel, shared_machine, ...), so the
 * activity log shows it; when that rejection spent the Ask an ildra.ask.outcome follows. Not logged: unpaired_phone
 * (R7-10: only an aggregate count, onUnpaired), unknown_id
 * (no Ask to log it on), an answer whose id or answerId is not well formed, and no_authority (never reaches it).
 */
export interface AskAttempt { id: string; answerId: string; channel: AskChannel; reason: SettleReason; holdMs?: number; at: number }
const ASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Attempts kept per journal (oldest dropped first). */
export const MAX_ATTEMPTS = 200
/** Shield R5-4: short holds allowed on one Ask; the last one spends it with reason hold_limit. */
export const MAX_SHORT_HOLDS = 5
/** Shield R7-10: unpaired phone answers counted per window; the paired phone hears once a window at the threshold. */
export const UNPAIRED_WINDOW_MS = 10 * 60_000
export const UNPAIRED_NOTIFY = 3

/**
 * ildra.ask.handoff (v3.3): the open request moves from the device (touch or voice) to the paired phone. cause
 * timer: the device window (ask.deviceWindowSec) ran out; phone_answer: the paired phone answered while the Ask
 * was still on the device (early handoff), and that answer then settles it. Same id, digest8 and expiresAt.
 */
/**
 * Batch B, ildra.ask.answered_by: which channel and key settled an Ask (replaces App's mock). Sent when an answer
 * settles it (approve or deny, any channel) and kept in the journal. by.kind phone: the paired phone (phoneId) and
 * the key that signed (main, or deny_only for a deny-key Deny); by.kind device: the enrolled Ildra device. by.fingerprint
 * is deviceFingerprint of that key (16 digits).
 */
export interface AskAnsweredBy {
  id: string
  approved: boolean
  channel: AskChannel
  by: { kind: 'phone'; phoneId: string; key: 'main' | 'deny_only'; fingerprint: string } | { kind: 'device'; key: 'device'; fingerprint: string }
  at: number
}
export const MAX_ANSWERED_BY = 500

export interface AskHandoff { id: string; from: 'device'; to: 'phone'; channel: 'touch' | 'voice'; cause: 'timer' | 'phone_answer'; at: number }

/** The fixed action of the daemon's first-run practice Ask (PM Q52). It names nothing real. */
export const PRACTICE_ACTION = 'Practice Ask'
/** Recipients remembered as known (approved sends), oldest dropped first. */
export const MAX_KNOWN_RECIPIENTS = 1000

/** PM Q52: a practice Ask that would carry a real action, tool, amount, recipient or detail. */
export class PracticeRefused extends ApprovalDenied {
  constructor(what: string) { super(`a practice Ask carries no real action (${what} refused)`) }
}

/**
 * Open Asks, spent request ids and spent answer ids (DECISIONS ad47477). Every answerId is accepted at most
 * once. A rejected answer spends its request too, except hold_too_short on a matching, unexpired Ask: that
 * Ask stays open (until it expires) for a proper hold. A malformed answer touches nothing.
 */
export class AskLedger {
  private readonly now: () => number
  private readonly ttlMs?: number
  private readonly verifier?: AnswerVerifier
  private readonly open_ = new Map<string, AskRequest>()
  private readonly spent = new Map<string, number>()
  /** Answer ids seen, with the time they may be forgotten. */
  private readonly spentAnswers = new Map<string, number>()
  private attempts_: AskAttempt[] = []
  /**
   * Asks moved by handoff: id to the device channel they left and their expiry. Kept after the Ask settles
   * (until it expires), so a late device answer is stale_channel and never double-settles (v3.3).
   */
  private readonly handedOff = new Map<string, { from: AskChannel; until: number }>()
  private handoffLog_: AskHandoff[] = []
  /** Asks whose policy lets the phone answer (early or timed handoff); v3.3. */
  private readonly phoneOk = new Map<string, boolean>()
  /** Short holds per open Ask (Shield R5-4). */
  private readonly shortHolds = new Map<string, number>()
  /** recipientKey of every recipient an approved send went to (new_recipient, lookalike). */
  private known_: string[] = []
  onChange?: () => void
  /** Called with each ildra.ask.attempt as it is recorded (the daemon forwards it to the phone). */
  onAttempt?: (a: AskAttempt) => void
  /** Called with each ildra.ask.handoff as it happens (the daemon forwards it, withdraws the device prompt). */
  onHandoff?: (h: AskHandoff) => void
  /**
   * Shield R7-10: called once per UNPAIRED_WINDOW_MS when unpaired phone answers reach UNPAIRED_NOTIFY in that
   * window (the daemon tells the paired phone, ildra.ask.unpaired). Aggregate only: no Ask, id or answerId.
   */
  onUnpaired?: (u: { count: number; since: number; at: number }) => void
  private unpaired_ = { since: 0, count: 0, notified: false }
  private noteUnpaired(): void {
    const t = this.now()
    if (t - this.unpaired_.since >= UNPAIRED_WINDOW_MS) this.unpaired_ = { since: t, count: 0, notified: false }
    this.unpaired_.count++
    if (this.unpaired_.count >= UNPAIRED_NOTIFY && !this.unpaired_.notified) {
      this.unpaired_.notified = true
      try { this.onUnpaired?.({ count: this.unpaired_.count, since: this.unpaired_.since, at: t }) } catch { /* a listener never changes the result */ }
    }
  }
  /** Shield R7-10: unpaired phone answers in the current window. */
  unpairedCount(): { count: number; since: number } { return { count: this.unpaired_.count, since: this.unpaired_.since } }

  /**
   * Shield R7 (ledger via rule): a production ledger (the Ask service's journal, createIldraAsk) settles only answers the core stamped with
   * their channel (core/ildraChannel.ts) and takes the channel from that stamp; anything else is no_authority and
   * records nothing. Plain ledgers (tests, reference mode) keep reading `via` from the answer.
   */
  private readonly requireStamp: boolean
  /** `ttlMs` overrides the decided expiry; tests only. */
  constructor(opts: { now?: () => number; ttlMs?: number; verifier?: AnswerVerifier; requireChannelStamp?: boolean } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs
    this.verifier = opts.verifier
    this.requireStamp = opts.requireChannelStamp === true
  }
  /** True for a production ledger (only core-stamped answers settle). */
  requiresChannelStamp(): boolean { return this.requireStamp }

  /** Recipients this daemon has sent to (approved), as recipientKey. */
  knownRecipients(): string[] { return [...this.known_] }

  open(o: {
    action: string; tier: Tier; channel: AskChannel; amountMinor?: number; details?: Record<string, unknown>
    agentId?: string; templateId?: string; recipient?: string; firstLine?: string; kind?: AskKind
    /** v3.3: may the phone take this Ask over (timer or early handoff)? Default true; ask() always sets it. */
    phoneAllowed?: boolean
    /** Known contacts and domains beyond the ledger's own sent-to list (lookalike, new_recipient). */
    known?: RecipientKnowledge
    /** @internal practiceAsk only. */
    tool?: unknown
  }): AskRequest {
    if (o.kind === 'practice') {
      if (o.action !== PRACTICE_ACTION) throw new PracticeRefused('action')
      if (o.tool !== undefined) throw new PracticeRefused('tool')
      if (o.amountMinor !== undefined) throw new PracticeRefused('amount')
      if (o.recipient !== undefined || o.firstLine !== undefined) throw new PracticeRefused('recipient')
      if (o.details && Object.keys(o.details).length) throw new PracticeRefused('details')
      if (o.tier !== 'ask') throw new PracticeRefused('tier')
    } else if (o.kind !== undefined && (o.kind !== 'safety_verification' || o.tier !== 'locked_ask')) {
      throw new ApprovalDenied('AskRequest.kind is safety_verification on a locked_ask only, or practice from practiceAsk')
    }
    for (const k of DIGEST_RESERVED) if (o.details && k in o.details) throw new ApprovalDenied(`a detail may not be named ${k}`)
    if (o.firstLine !== undefined && (typeof o.firstLine !== 'string' || o.firstLine === '')) throw new ApprovalDenied('a send Ask needs a non-empty first line')
    if (o.recipient !== undefined && (typeof o.recipient !== 'string' || hasHiddenChar(o.recipient))) throw new UnsafeRecipient()
    const recipient = o.recipient?.normalize('NFC')
    const ascii = recipient !== undefined ? recipientAscii(recipient) : undefined
    if (ascii === null) throw new UnsafeRecipient()
    const known: RecipientKnowledge = { contacts: [...this.known_, ...(o.known?.contacts ?? [])], domains: [...(o.known?.domains ?? [])] }
    const flags = recipient !== undefined ? recipientFlags(recipient, known) : []
    const looksLike = recipient !== undefined && flags.includes('lookalike') ? lookalikeOf(recipient, known) : null
    if (phoneOnly(o.tier, o.amountMinor, flags) && o.channel !== 'phone') {
      throw new ApprovalDenied('locked_ask, money and flagged-recipient Asks are answered on the paired phone only')
    }
    const openedAt = this.now()
    const currency = o.amountMinor !== undefined ? ('USD' as const) : undefined
    const details = o.details && recipient !== undefined && typeof o.details.recipient === 'string'
      ? { ...o.details, recipient: o.details.recipient.normalize('NFC') } : o.details
    const req: AskRequest = {
      id: randomUUID(),
      digest8: actionDigest8(o.action, { ...details, agentId: o.agentId, tier: o.tier, amountMinor: o.amountMinor, currency }),
      action: o.action,
      ...(o.agentId !== undefined ? { agentId: o.agentId } : {}),
      ...(o.templateId !== undefined ? { templateId: o.templateId } : {}),
      ...(recipient !== undefined ? { recipient } : {}),
      ...(ascii !== undefined ? { recipientAscii: ascii } : {}),
      ...(o.firstLine !== undefined ? { firstLine: o.firstLine } : {}),
      ...(flags.length ? { recipientFlags: flags } : {}),
      ...(looksLike !== null ? { lookalikeOf: looksLike } : {}),
      ...(o.kind !== undefined ? { kind: o.kind } : {}),
      ...(currency ? { currency } : {}),
      openedAt,
      expiresAt: openedAt + (this.ttlMs ?? askExpiryMs(o.amountMinor)),
      channel: o.channel,
      tier: o.tier,
      ...(o.amountMinor !== undefined ? { amountMinor: o.amountMinor } : {}),
      ...(o.channel === 'voice' ? { challenge: drawChallenge() } : {}),
    }
    this.open_.set(req.id, req)
    this.phoneOk.set(req.id, o.phoneAllowed !== false)
    this.onChange?.()
    return req
  }

  private prune(): void {
    const t = this.now()
    for (const [id, r] of this.open_) if (t >= r.expiresAt) { this.open_.delete(id); this.spent.set(id, r.expiresAt) }
    for (const [id, h] of this.handedOff) if (t >= h.until) this.handedOff.delete(id)
    for (const id of this.shortHolds.keys()) if (!this.open_.has(id)) this.shortHolds.delete(id)
    for (const id of this.phoneOk.keys()) if (!this.open_.has(id)) this.phoneOk.delete(id)
    // Spent ids are kept until a further day past expiry so a late replay reads as replayed.
    for (const [id, at] of this.spent) if (at + OTHER_ASK_EXPIRY_MS < t) { this.spent.delete(id); this.ended_.delete(id) }
    for (const [id, at] of this.spentAnswers) if (at + OTHER_ASK_EXPIRY_MS < t) this.spentAnswers.delete(id)
  }

  /** Recorded ildra.ask.attempt events, oldest first (copies). */
  attempts(): AskAttempt[] {
    return this.attempts_.map((a) => ({ ...a }))
  }

  /** Recorded ildra.ask.handoff events, oldest first (copies); journaled. */
  handoffs(): AskHandoff[] {
    return this.handoffLog_.map((h) => ({ ...h }))
  }

  pending(): number {
    this.prune()
    return this.open_.size
  }

  /** The open request (a copy), or null. */
  get(id: string): AskRequest | null {
    const r = this.open_.get(id)
    return r && this.now() < r.expiresAt ? { ...r } : null
  }

  /**
   * Shield R7 ruling: the last paired phone was unpaired, so no one can answer an open Ask on the phone channel
   * (phone-only from the start, or handed off). End each one now with no_paired_phone: spent, never approves.
   * Returns the ended ids; onEnded fires for each so the runtime wakes the waiting ask().
   */
  endPhoneAsks(reason: 'no_paired_phone' = 'no_paired_phone'): string[] {
    const t = this.now()
    const ids: string[] = []
    for (const [id, r] of this.open_) {
      if (r.channel !== 'phone' || t >= r.expiresAt) continue
      this.open_.delete(id)
      this.spent.set(id, r.expiresAt)
      this.ended_.set(id, reason)
      ids.push(id)
    }
    if (ids.length > 0) {
      this.onChange?.()
      for (const id of ids) { try { this.onEnded?.(id, reason) } catch { /* a listener never changes the result */ } }
    }
    return ids
  }
  /** Why an Ask was ended by state rather than by an answer (no_paired_phone), or null. */
  endedReason(id: string): 'no_paired_phone' | null { return this.ended_.get(id) ?? null }
  onEnded?: (id: string, reason: 'no_paired_phone') => void
  private ended_ = new Map<string, 'no_paired_phone'>()

  /** May the phone take this open Ask over (its policy permits the phone channel)? */
  phoneAllowed(id: string): boolean {
    return this.open_.has(id) && this.phoneOk.get(id) === true
  }

  /** The device channel an Ask was handed off from (also after it settled, until it expires), or null. */
  handedOffFrom(id: string): AskChannel | null {
    const h = this.handedOff.get(id)
    return h && this.now() < h.until ? h.from : null
  }

  /**
   * Move an open device Ask (touch or voice) to the paired phone: ildra.ask.handoff. Same id and digest8
   * (channel is not in the digest), expiresAt unchanged; journaled. Device answers after it are stale_channel.
   * Null when the Ask is not open, has expired, is not on the device, its policy does not permit the phone, or
   * `to` is not phone. Never upgrades a touch-only Ask.
   */
  handoff(id: string, to: AskChannel, cause: AskHandoff['cause'] = 'timer'): AskHandoff | null {
    const req = this.open_.get(id)
    const at = this.now()
    if (!req || at >= req.expiresAt || (req.channel !== 'touch' && req.channel !== 'voice') || to !== 'phone') return null
    if (this.phoneOk.get(id) !== true) return null
    const { challenge: _c, ...rest } = req
    this.open_.set(id, { ...rest, channel: 'phone' })
    this.handedOff.set(id, { from: req.channel, until: req.expiresAt })
    this.shortHolds.delete(id)
    const h: AskHandoff = { id, from: 'device', to: 'phone', channel: req.channel, cause, at }
    this.handoffLog_.push(h)
    if (this.handoffLog_.length > MAX_ATTEMPTS) this.handoffLog_ = this.handoffLog_.slice(-MAX_ATTEMPTS)
    this.onChange?.()
    try { this.onHandoff?.({ ...h }) } catch { /* a listener never changes the result */ }
    return { ...h }
  }

  /** `isPaired` is consulted for phone answers; `extra` runs after the ledger's own verifier. */
  settle(ans: AskAnswer, ctx: SettleContext = {}): SettleResult {
    if (this.requireStamp && ans !== null && typeof ans === 'object') {
      const via = stampedChannel(ans)
      if (via === undefined) return { ok: false, reason: 'no_authority' }
      ans = { ...ans, via }
      ctx = { ...ctx, via }
    }
    const r = this.check(ans, ctx)
    if (!r.ok) this.logPhoneAttempt(ans, r.reason, ctx)
    else { try { this.onSettled?.(ans) } catch { /* a listener never changes the result */ } }
    this.onChange?.()
    return r
  }
  /** Shield deny key condition 6: called with each answer that settled an Ask (the journal notes deny-key Denies). */
  onSettled?: (ans: AskAnswer) => void

  /**
   * v3.3: log a rejected phone answer as ildra.ask.attempt (channel phone). Only for a known Ask (open or spent)
   * and a well-formed id and answerId; device rejections other than hold_too_short and stale_channel are not logged.
   * Also called by the runtime for busy.
   */
  phoneAttempt(ans: AskAnswer, reason: SettleReason, ctx: SettleContext = {}): void {
    if (this.requireStamp) {
      const via = stampedChannel(ans)
      if (via === undefined) return
      ans = { ...ans, via }
      ctx = { ...ctx, via }
    }
    this.logPhoneAttempt(ans, reason, ctx)
  }

  private logPhoneAttempt(ans: AskAnswer, reason: SettleReason, ctx: SettleContext): void {
    if (!ans || typeof ans !== 'object' || reason === 'hold_too_short' || reason === 'stale_channel' || reason === 'unknown_id' || reason === 'no_authority' || reason === 'unpaired_phone') return
    if (typeof ans.id !== 'string' || !ASK_ID.test(ans.id) || typeof ans.answerId !== 'string' || !ANSWER_ID.test(ans.answerId)) return
    if (answerChannel(ans, ctx) !== 'phone') return
    if (!this.open_.has(ans.id) && !this.spent.has(ans.id)) return
    this.attempt(ans.id, ans, 'phone', reason)
  }

  private attempt(id: string, ans: AskAnswer, channel: AskChannel, reason: SettleReason): SettleResult {
    const h = channel === 'phone' ? undefined : ans.holdMs
    const a: AskAttempt = {
      id, answerId: ans.answerId, channel, reason,
      ...(typeof h === 'number' && Number.isFinite(h) && h >= 0 ? { holdMs: h } : {}), at: this.now(),
    }
    this.attempts_.push(a)
    if (this.attempts_.length > MAX_ATTEMPTS) this.attempts_ = this.attempts_.slice(-MAX_ATTEMPTS)
    try { this.onAttempt?.({ ...a }) } catch { /* a listener never changes the result */ }
    return { ok: false, reason }
  }

  /** R5-1: the phone's claim checked against its paired key (strict when the answer came through the runtime). */
  private phonePaired(ans: AskAnswer, ctx: SettleContext): boolean {
    const id = ans.from?.phoneId
    const strict = ans.via !== undefined || ans.from?.machinePub !== undefined
    const key = strict ? (typeof ans.from?.machinePub === 'string' ? ans.from.machinePub : '') : undefined
    return typeof id === 'string' && !!ctx.isPaired && ctx.isPaired(id, key)
  }

  private check(ans: AskAnswer, ctx: SettleContext): SettleResult {
    if (!ans || typeof ans !== 'object' || typeof ans.id !== 'string' || typeof ans.digest8 !== 'string'
      || typeof ans.answerId !== 'string' || !ANSWER_ID.test(ans.answerId)) return { ok: false, reason: 'malformed' }
    let req = this.open_.get(ans.id)
    // Shield R7-10: on a phone Ask (money, locked_ask, a flagged recipient, or one handed off) an answer not from
    // the paired phone's key is refused before anything else: nothing is recorded (not its answerId, no per-Ask
    // attempt), nothing is spent, the Ask stays open for the real phone. Only an aggregate, rate-limited count
    // reaches the paired phone (onUnpaired). (A phone answer to a device Ask is wrong_channel and spends nothing.)
    if (req && req.channel === 'phone' && answerChannel(ans, ctx) === 'phone' && !this.phonePaired(ans, ctx)) {
      this.noteUnpaired()
      return { ok: false, reason: 'unpaired_phone' }
    }
    const answerSeen = this.spentAnswers.has(ans.answerId)
    this.spentAnswers.set(ans.answerId, Math.max(this.now(), req?.expiresAt ?? 0))
    // v3.1 (decided order) and v3.3: after a handoff, any answer from the device channel the Ask left (approve or
    // deny, even with a reused answerId, and even after the phone settled it) is stale_channel, checked before
    // replayed: logged as an attempt, never approves, never spends.
    const left = this.handedOff.get(ans.id)
    if (left !== undefined && this.now() < left.until) {
      const via = ctx.via ?? ans.via
      const fromDevice = via !== undefined ? via === 'touch' || via === 'voice' : answerChannel(ans, ctx) === left.from
      if (fromDevice) return this.attempt(ans.id, ans, left.from, 'stale_channel')
    }
    if (!req) {
      this.prune()
      return { ok: false, reason: answerSeen || this.spent.has(ans.id) ? 'replayed' : 'unknown_id' }
    }
    const spend = (reason: SettleReason): SettleResult => {
      this.open_.delete(ans.id)
      this.spent.set(ans.id, req!.expiresAt)
      return { ok: false, reason }
    }
    // R5-1 / v3.3: the connection decides the channel (via, set by core/ildraAsk.ts). Only the device bridge
    // answers a device Ask (touch or voice) or nothing at all on a phone Ask. Refusals here never spend (checked
    // before replayed, so a client cannot spend the Ask by repeating its own answerId), except a shared machine,
    // which spends it as before (F12).
    if (ans.via !== undefined) {
      const deviceAsk = req.channel === 'touch' || req.channel === 'voice'
      const fromDevice = ans.via === 'touch' || ans.via === 'voice'
      if (deviceAsk && !fromDevice) {
        if (originShared(ans.from, ctx.isShared)) return spend('shared_machine')
        if (this.now() >= req.expiresAt) return spend('expired')
        // v3.3 early handoff: the paired phone (by key) answers an Ask still on the device. Only when the Ask's
        // policy permits the phone, and only for a fresh answerId that matches the open id and digest8 in time;
        // anything else is wrong_channel and the Ask stays on the device.
        const eligible = ans.via === 'phone' && this.phoneOk.get(req.id) === true && !answerSeen
          && this.now() < req.expiresAt && ans.digest8 === req.digest8 && this.phonePaired(ans, ctx)
        if (!eligible || !this.handoff(req.id, 'phone', 'phone_answer')) return { ok: false, reason: 'wrong_channel' }
        req = this.open_.get(req.id)!
      } else if (!deviceAsk && fromDevice) {
        return originShared(ans.from, ctx.isShared) ? spend('shared_machine') : { ok: false, reason: 'wrong_channel' }
      }
    }
    if (answerSeen) return spend('replayed')
    if (this.now() >= req.expiresAt) return spend('expired')
    if (ans.digest8 !== req.digest8) return spend('digest_mismatch')
    if (originShared(ans.from, ctx.isShared)) return spend('shared_machine')
    // R5-1: the phone id is a claim. An answer that came through the daemon's runtime (via set by
    // core/ildraAsk.ts, the only production path) or that names a key must come from the key that phone
    // paired with. Only a direct in-process ledger caller (tests, reference mode) is checked by id alone.
    // R7-10: only the paired phone's key can spend a phone Ask; anything else here leaves it open.
    if (req.channel === 'phone' && !this.phonePaired(ans, ctx)) { this.noteUnpaired(); return { ok: false, reason: 'unpaired_phone' } }
    if (req.channel === 'touch' && ans.approved === true) {
      const h = ans.holdMs
      // DECISIONS ad47477: a short hold is a rejected gesture (an attempt), not an answer; the Ask stays open.
      if (typeof h !== 'number' || !Number.isFinite(h) || h < DEVICE_HOLD_MIN_MS) {
        const r = this.attempt(req.id, ans, req.channel, 'hold_too_short')
        // Shield R5-4: the MAX_SHORT_HOLDS-th short hold on one Ask spends it (hold_limit). PM Q52: not the
        // practice Ask, which stays open for as many tries as it takes.
        if (req.kind === 'practice') return r
        const n = (this.shortHolds.get(req.id) ?? 0) + 1
        this.shortHolds.set(req.id, n)
        return n >= MAX_SHORT_HOLDS ? spend('hold_limit') : r
      }
    }
    this.open_.delete(ans.id)
    this.spent.set(ans.id, req.expiresAt)
    if (req.challenge && ans.approved === true && !transcriptMatches(req.challenge, ans.transcript)) return { ok: false, reason: 'challenge_mismatch' }
    for (const v of [this.verifier, ctx.extra]) {
      if (!v) continue
      let ok = false
      try { ok = v(req, ans) === true } catch { ok = false }
      if (!ok) return { ok: false, reason: 'verifier_rejected' }
    }
    if (ans.approved === true && req.recipient !== undefined && req.kind !== 'practice') {
      const k = recipientKey(req.recipient)
      if (!this.known_.includes(k)) {
        this.known_.push(k)
        if (this.known_.length > MAX_KNOWN_RECIPIENTS) this.known_ = this.known_.slice(-MAX_KNOWN_RECIPIENTS)
      }
    }
    return { ok: true }
  }

  toJSON(): {
    open: AskRequest[]; spent: [string, number][]; spentAnswers: [string, number][]; attempts: AskAttempt[]
    handoffs: [string, AskChannel, number][]; handoffLog: AskHandoff[]; phoneAllowed: string[]; shortHolds: [string, number][]; knownRecipients: string[]
    answeredBy: AskAnsweredBy[]
  } {
    this.prune()
    return {
      open: [...this.open_.values()].map((r) => ({ ...r })), spent: [...this.spent], spentAnswers: [...this.spentAnswers],
      attempts: this.attempts(), handoffs: [...this.handedOff].map(([id, h]) => [id, h.from, h.until]), handoffLog: this.handoffs(),
      phoneAllowed: [...this.phoneOk].filter(([, ok]) => ok).map(([id]) => id), shortHolds: [...this.shortHolds], knownRecipients: [...this.known_],
      answeredBy: this.answeredBy_.map((a) => ({ ...a, by: { ...a.by } })),
    }
  }

  /** Batch B: who settled each Ask (ildra.ask.answered_by), the last MAX_ANSWERED_BY. */
  private answeredBy_: AskAnsweredBy[] = []
  noteAnsweredBy(a: AskAnsweredBy): void {
    this.answeredBy_.push({ ...a, by: { ...a.by } })
    if (this.answeredBy_.length > MAX_ANSWERED_BY) this.answeredBy_.splice(0, this.answeredBy_.length - MAX_ANSWERED_BY)
  }
  answeredBy(id: string): AskAnsweredBy | null {
    const a = this.answeredBy_.findLast((x) => x.id === id)
    return a ? { ...a, by: { ...a.by } } : null
  }

  /** @internal journal restore. */
  restore(data: {
    open: AskRequest[]; spent: [string, number][]; spentAnswers?: [string, number][]; attempts?: AskAttempt[]
    handoffs?: [string, AskChannel, number?][]; handoffLog?: AskHandoff[]; phoneAllowed?: string[]; shortHolds?: [string, number][]; knownRecipients?: string[]
    answeredBy?: unknown
  }): void {
    this.answeredBy_ = (Array.isArray(data.answeredBy) ? data.answeredBy as AskAnsweredBy[] : [])
      .filter((a) => a && typeof a.id === 'string' && typeof a.approved === 'boolean' && KNOWN_CHANNELS.has(a.channel) && a.by && typeof a.by === 'object' && typeof a.by.fingerprint === 'string')
      .slice(-MAX_ANSWERED_BY).map((a) => ({ ...a, by: { ...a.by } }))
    for (const [id, at] of data.spentAnswers ?? []) this.spentAnswers.set(id, at)
    this.attempts_ = (data.attempts ?? []).filter((a) => a && typeof a.id === 'string'
      && (a.reason === 'hold_too_short' || a.reason === 'stale_channel' || (a.channel === 'phone' && ASK_REJECTION_REASONS.includes(a.reason))))
      .slice(-MAX_ATTEMPTS).map((a) => ({ ...a }))
    this.handoffLog_ = (data.handoffLog ?? []).filter((h) => h && typeof h.id === 'string' && h.from === 'device' && h.to === 'phone')
      .slice(-MAX_ATTEMPTS).map((h) => ({ ...h }))
    for (const r of data.open) {
      // Pilot review A1: a locked_ask, money or flagged-recipient Ask opened on the device or voice before the
      // phone-only rule is denied on restore (spent), never answerable.
      if (phoneOnly(r.tier, r.amountMinor, r.recipientFlags) && r.channel !== 'phone') this.spent.set(r.id, r.expiresAt)
      else this.open_.set(r.id, { ...r })
    }
    for (const [id, at] of data.spent) this.spent.set(id, at)
    // Journals from before v3.3 have no phoneAllowed list: their open Asks keep today's rule (phone permitted).
    const allowed = data.phoneAllowed === undefined ? null : new Set(data.phoneAllowed)
    for (const id of this.open_.keys()) this.phoneOk.set(id, allowed === null || allowed.has(id))
    for (const [id, from, until] of data.handoffs ?? []) {
      const u = Number.isFinite(until) ? until! : this.open_.get(id)?.expiresAt
      if (u !== undefined && KNOWN_CHANNELS.has(from)) this.handedOff.set(id, { from, until: u })
    }
    for (const [id, n] of data.shortHolds ?? []) if (this.open_.has(id) && Number.isInteger(n) && n > 0) this.shortHolds.set(id, n)
    this.known_ = (data.knownRecipients ?? []).filter((x) => typeof x === 'string').slice(-MAX_KNOWN_RECIPIENTS)
  }
}

export interface SettleContext {
  /** Phone answers: is this phone paired, and (R5-1) is `machinePub` the key it paired with? */
  isPaired?: (phoneId: string, machinePub?: string) => boolean
  extra?: AnswerVerifier
  isShared?: SharedOriginLookup
  /** The channel the answer arrived on, when the caller knows it (the device bridge says touch). */
  via?: AskChannel
}

/** The channel an answer came from: ctx.via, else a paired-phone id means phone, a transcript voice, else touch. */
function answerChannel(ans: AskAnswer, ctx: SettleContext): AskChannel {
  if (ctx.via) return ctx.via
  if (ans.via) return ans.via
  if (typeof ans.from?.phoneId === 'string') return 'phone'
  if (typeof ans.transcript === 'string') return 'voice'
  return 'touch'
}

// ---- F2 mic hook (Volt implements) ----

/** The gate refuses voice unless this is supplied: mic capture is off while the speaker plays the prompt. */
export interface MicGuard {
  speaking(on: boolean): void
}

// ---- F6 minimum: phone pairs only by touch on the device plus a single-use code ----

export interface PairingLogEntry {
  at: number
  event: 'pair' | 'unpair' | 'refused'
  phoneId: string
  reason?: string
}

export const PAIRING_CHECK_VERSION = 'ildra-pair-v1'

/**
 * F6 short check string shown on both the device and the phone. 6 decimal digits:
 * sha256(`ildra-pair-v1|<code>|<phonePub>|<deviceNonce>`), first 4 bytes as a big-endian uint32,
 * mod 1,000,000, zero-padded. Both sides compute it from the same transcript; a man in the middle that
 * swaps the phone key or the nonce changes it.
 */
export function pairingCheck(code: string, phonePub: string, deviceNonce: string): string {
  const h = createHash('sha256').update(`${PAIRING_CHECK_VERSION}|${code}|${phonePub}|${deviceNonce}`).digest()
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export interface PairingStart {
  /** 6-digit single-use code shown on the device, typed on the phone. */
  code: string
  /** 32 hex chars (16 random bytes), sent to the phone with the pairing session. */
  deviceNonce: string
  expiresAt: number
}

export type PairingStatus = { state: 'pending' } | { state: 'paired' } | { state: 'refused'; reason: string } | { state: 'unknown' }

export type PairingOffer = { ok: true; check: string; deviceNonce: string; expiresAt: number } | { ok: false; reason: string }

type PendingPair = { phonePub: string; transport: string; check: string; expiresAt: number }

/**
 * Phone pairing (F6). Three steps, all on the device's terms:
 * 1. begin('touch') on the device: code + deviceNonce. Never by voice, phone or a shared machine.
 * 2. offer(phoneId, phonePub, code) when the phone submits the code: spends the code, returns the
 *    6-digit check string the device shows (the phone computes the same with pairingCheck).
 * 3. confirm(phoneId, 'touch', matched) on the device: the user taps that both strings match.
 *    Only then is the phone paired. A mismatch, any channel but touch, or expiry refuses it.
 */
/**
 * Batch B: the daemon's authoritative pairing ledger. Phones and devices, append-only, journaled with the Ask journal
 * (same atomic write as the state it records). Each entry is chained to the previous one by SHA-256 (hash over prev
 * and the entry's fields), so an edited, dropped or reordered entry breaks the chain and the journal fails closed.
 * The paired phone reads it with `ildra.pairing.ledger.get`.
 */
export const PAIRING_LEDGER_KINDS = [
  'phone_paired', 'phone_rotated', 'phone_unpaired', 'pair_refused',
  'device_enroll_requested', 'device_enroll_replaced', 'device_enrolled', 'device_refused', 'device_revoked', 'device_expired',
  'deny_key_set', 'deny_key_revoked', 'deny_key_deny', 'deny_burst', 'verifier_rejected', 'phone_open',
  'unpair_requested', 'unpair_refused',
  // Shield B5: the ledger could not be trusted at load (kept aside, never restarted empty) and the phone's acknowledgement.
  'ledger_reset', 'ledger_ack',
] as const
export type PairingLedgerKind = (typeof PAIRING_LEDGER_KINDS)[number]
export interface PairingLedgerFields {
  kind: PairingLedgerKind
  /** The phone the entry is about. */
  phoneId?: string
  /** The device or key fingerprint the entry is about (deviceFingerprint: 16 digits). */
  fingerprint?: string
  oldFingerprint?: string
  /** Who did it: a phoneId, 'local_socket', 'device' or 'daemon'. */
  by?: string
  /** How: 'touch', 'locked_ask', 'deny_key', 'local_socket', 'device', 'phone'. */
  via?: string
  reason?: string
  /** The Ask it concerns (deny_key_deny, phone_unpaired via locked_ask). */
  askId?: string
  verb?: string
  uv?: string
  count?: number
  since?: number
  /** Shield deny key condition 6: 'deny_key' on every Deny the deny key settled. */
  source?: 'deny_key'
  /** P-256 move: the key's algorithm, set by the daemon from the key role (never from input): 'p256' for phone keys, 'ed25519' for device keys. Informational. */
  keyAlg?: 'p256' | 'ed25519'
  /** Shield B5: on ledger_reset, the head hash of the ledger that could not be trusted (when it had one). */
  oldHead?: string
}
export interface PairingLedgerEntry extends PairingLedgerFields { seq: number; at: number; prev: string; hash: string }
const LEDGER_FIELD_ORDER = ['seq', 'at', 'kind', 'phoneId', 'fingerprint', 'oldFingerprint', 'by', 'via', 'reason', 'askId', 'verb', 'uv', 'count', 'since', 'source', 'keyAlg', 'oldHead'] as const
const LEDGER_GENESIS = '0'.repeat(64)
function ledgerHash(prev: string, e: Omit<PairingLedgerEntry, 'prev' | 'hash'>): string {
  const body: Record<string, unknown> = {}
  for (const k of LEDGER_FIELD_ORDER) if ((e as Record<string, unknown>)[k] !== undefined) body[k] = (e as Record<string, unknown>)[k]
  return createHash('sha256').update(`ildra-pairing-ledger:v1|${prev}|${JSON.stringify(body)}`, 'utf8').digest('hex')
}
/**
 * Shield B9: the ledger's size bound. At most MAX_PAIRING_LEDGER entries (journal restore refuses more). Noisy kinds
 * (refusals and requests anyone on the network or the device can cause) are coalesced: at most NOISY_PER_MINUTE per
 * (kind, phoneId, verb, reason) in any 60 s, the next one kept carries count = 1 + those dropped; and none once the
 * ledger holds MAX_PAIRING_LEDGER - LEDGER_STATE_RESERVE entries, so the last 1,000 are only for state changes. A
 * full ledger refuses pairing changes (ledger_full). String fields are cut to LEDGER_STRING_MAX characters.
 */
export const MAX_PAIRING_LEDGER = 10_000
export const LEDGER_STATE_RESERVE = 1_000
export const NOISY_PER_MINUTE = 5
export const LEDGER_STRING_MAX = 64
const NOISY_LEDGER_KINDS: ReadonlySet<string> = new Set(['verifier_rejected', 'pair_refused', 'unpair_refused', 'device_enroll_requested', 'device_enroll_replaced', 'device_refused', 'device_expired'])
const LEDGER_CAPPED_STRINGS = ['phoneId', 'by', 'via', 'reason', 'verb', 'uv'] as const
export class PairingLedger {
  private readonly entries_: PairingLedgerEntry[] = []
  /** Shield B9: noisy entries dropped by coalescing, per key, not yet carried by a kept entry's count. */
  private readonly dropped = new Map<string, number>()
  onChange?: () => void
  constructor(private readonly now: () => number = Date.now) {}
  /** Shield B9: no room left for a state change. */
  full(): boolean { return this.entries_.length >= MAX_PAIRING_LEDGER }
  append(f: PairingLedgerFields): PairingLedgerEntry | null {
    const last = this.entries_.at(-1)
    const at = this.now()
    const g: Record<string, unknown> = { ...f }
    for (const k of LEDGER_CAPPED_STRINGS) if (typeof g[k] === 'string' && (g[k] as string).length > LEDGER_STRING_MAX) g[k] = (g[k] as string).slice(0, LEDGER_STRING_MAX)
    if (NOISY_LEDGER_KINDS.has(f.kind)) {
      const key = `${f.kind}|${g.phoneId ?? ''}|${g.verb ?? ''}|${g.reason ?? ''}`
      let recent = 0
      for (let i = this.entries_.length - 1; i >= 0 && recent < NOISY_PER_MINUTE; i--) {
        const e = this.entries_[i]!
        if (at - e.at >= 60_000) break
        if (`${e.kind}|${e.phoneId ?? ''}|${e.verb ?? ''}|${e.reason ?? ''}` === key) recent++
      }
      if (recent >= NOISY_PER_MINUTE || this.entries_.length >= MAX_PAIRING_LEDGER - LEDGER_STATE_RESERVE) {
        this.dropped.set(key, (this.dropped.get(key) ?? 0) + 1)
        return null
      }
      const d = this.dropped.get(key)
      if (d) { g.count = d + 1; this.dropped.delete(key) }
    } else if (this.full()) {
      throw new ApprovalDenied('the pairing ledger is full')
    }
    const base: Omit<PairingLedgerEntry, 'prev' | 'hash'> = { seq: (last?.seq ?? 0) + 1, at, ...(g as unknown as PairingLedgerFields) }
    for (const k of Object.keys(base)) if ((base as Record<string, unknown>)[k] === undefined) delete (base as Record<string, unknown>)[k]
    const prev = last?.hash ?? LEDGER_GENESIS
    const e: PairingLedgerEntry = { ...base, prev, hash: ledgerHash(prev, base) }
    this.entries_.push(e)
    this.onChange?.()
    return { ...e }
  }
  /** Entries with seq greater than `since`, oldest first, at most `limit`. */
  since(since = 0, limit = 500): PairingLedgerEntry[] {
    return this.entries_.filter((e) => e.seq > since).slice(0, limit).map((e) => ({ ...e }))
  }
  all(): readonly PairingLedgerEntry[] { return this.entries_ }
  /** Shield B5: the latest ledger_reset not yet acknowledged (ledger_ack), or null. Pairing changes are locked while set. */
  pendingReset(): PairingLedgerEntry | null {
    for (let i = this.entries_.length - 1; i >= 0; i--) {
      const e = this.entries_[i]!
      if (e.kind === 'ledger_ack') return null
      if (e.kind === 'ledger_reset') return { ...e }
    }
    return null
  }
  head(): { seq: number; hash: string } {
    const last = this.entries_.at(-1)
    return { seq: last?.seq ?? 0, hash: last?.hash ?? LEDGER_GENESIS }
  }
  toJSON(): PairingLedgerEntry[] { return this.entries_.map((e) => ({ ...e })) }
  /** @internal Throws when the chain does not verify (an edited, dropped or reordered entry): the journal fails closed. */
  restore(data: unknown): void {
    if (data === undefined) return
    if (!Array.isArray(data) || data.length > MAX_PAIRING_LEDGER) throw new Error('bad pairing ledger')
    let prev = LEDGER_GENESIS; let seq = 0
    const out: PairingLedgerEntry[] = []
    for (const raw of data) {
      const e = raw as PairingLedgerEntry
      if (!e || typeof e !== 'object' || e.seq !== seq + 1 || !Number.isFinite(e.at) || !(PAIRING_LEDGER_KINDS as readonly string[]).includes(e.kind) || e.prev !== prev) throw new Error('bad pairing ledger entry')
      const { prev: _p, hash, ...base } = e
      if (hash !== ledgerHash(prev, base)) throw new Error('pairing ledger chain broken')
      out.push({ ...e }); prev = hash; seq = e.seq
    }
    this.entries_.length = 0
    this.entries_.push(...out)
  }
}

export class PhonePairing {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly codes = new Map<string, { expiresAt: number; deviceNonce: string }>()
  private readonly pendingPairs = new Map<string, PendingPair>()
  /** Paired phones and the public key each paired with (R5-1: phone answers must come from that key). */
  private readonly phones = new Map<string, string>()
  /**
   * P-256 move: the phone's signing key (phones, a Secure Enclave P-256 point) is not its connection key. R5-1
   * binds the authenticated session identity that delivered the offer (origin.machinePub; the offered key when
   * the caller has no session) and checks answers against it (isPairedKey).
   */
  private readonly transports = new Map<string, string>()
  private readonly lastRefusal = new Map<string, string>()
  /** Ledger of every pairing, unpairing and refused attempt. */
  readonly log: PairingLogEntry[] = []
  onChange?: () => void
  /**
   * Shield deny key: at most one deny-only key per paired phone (condition 2: set only by a main-key-signed
   * enroll.confirm; a new one replaces it). Revoked with the phone's pairing: unpair or main-key rotation (condition 4).
   */
  private readonly denyKeys = new Map<string, { pub: string; at: number }>()
  /**
   * Batch B: the authoritative pairing ledger (append-only, chained). openJournal shares one with the device
   * enrollment and journals it in the same write; a bare PhonePairing keeps its own.
   */
  ledger: PairingLedger
  /** Condition 1: every deny-key signature refused for a verb other than ask.deny (ledger kind verifier_rejected). */
  get verifierLog(): { at: number; phoneId: string; verb: string; reason: 'verifier_rejected' }[] {
    return this.ledger.all().filter((e) => e.kind === 'verifier_rejected').map((e) => ({ at: e.at, phoneId: e.phoneId ?? '', verb: e.verb ?? '', reason: 'verifier_rejected' as const }))
  }
  /** Condition 6: every Deny settled by a deny-key signature (ledger kind deny_key_deny, via deny_key). */
  get denyLog(): { at: number; phoneId: string; id: string; source: 'deny_key' }[] {
    return this.ledger.all().filter((e) => e.kind === 'deny_key_deny').map((e) => ({ at: e.at, phoneId: e.phoneId ?? '', id: e.askId ?? '', source: 'deny_key' as const }))
  }
  static readonly DENY_BURST = 3
  static readonly DENY_BURST_WINDOW_MS = 60_000

  /** F6: wrong codes allowed before every open code is burned and a new device touch is needed. */
  static readonly MAX_WRONG_CODES = 5
  private wrongCodes = 0
  private readonly isShared?: SharedOriginLookup

  constructor(opts: { now?: () => number; ttlMs?: number; isShared?: SharedOriginLookup; ledger?: PairingLedger } = {}) {
    this.now = opts.now ?? Date.now
    this.ledger = opts.ledger ?? new PairingLedger(this.now)
    this.ttlMs = opts.ttlMs ?? 5 * 60_000
    this.isShared = opts.isShared
  }

  /**
   * Shield B5: pairing changes (pair, re-pair, unpair, deny key) are refused while the ledger has an unacknowledged
   * ledger_reset and a phone is paired to acknowledge it. With no phone paired, a touch pairing is the owner and
   * its confirm acknowledges the reset.
   */
  changesLocked(): boolean { return this.changeRefusal() !== null }
  /** Shield B5 and B9: why a pairing change is refused now (ledger_locked, ledger_full), or null. */
  changeRefusal(): 'ledger_locked' | 'ledger_full' | null {
    if (this.ledger.pendingReset() !== null && this.pairedCount() > 0) return 'ledger_locked'
    // Room for the change's own entries (an unpair may write two).
    if (this.ledger.all().length >= MAX_PAIRING_LEDGER - 2) return 'ledger_full'
    return null
  }

  /** True after too many wrong codes, until the next begin('touch'). */
  get lockedOut(): boolean {
    return this.wrongCodes >= PhonePairing.MAX_WRONG_CODES
  }

  private refuse(phoneId: string, reason: string): false {
    this.log.push({ at: this.now(), event: 'refused', phoneId, reason })
    this.ledger.append({ kind: 'pair_refused', phoneId, reason, via: 'touch' })
    if (phoneId && phoneId.length <= LEDGER_STRING_MAX) this.lastRefusal.set(phoneId, reason)
    this.onChange?.()
    return false
  }

  begin(confirmedBy: AskChannel, origin: AnswerOrigin = {}): PairingStart {
    if (originShared(origin, this.isShared)) throw new ApprovalDenied('a shared machine cannot start pairing')
    if (confirmedBy !== 'touch') throw new ApprovalDenied('phone pairing needs a touch on the device')
    this.wrongCodes = 0
    const code = String(randomInt(1_000_000)).padStart(6, '0')
    const deviceNonce = randomBytes(16).toString('hex')
    const expiresAt = this.now() + this.ttlMs
    this.codes.set(code, { expiresAt, deviceNonce })
    this.onChange?.()
    return { code, deviceNonce, expiresAt }
  }

  offer(phoneId: string, phonePub: string, code: string, origin: AnswerOrigin = {}): PairingOffer {
    const no = (reason: string): PairingOffer => { this.refuse(phoneId, reason); return { ok: false, reason } }
    if (this.lockedOut) return no('locked_out')
    { const why = this.changeRefusal(); if (why) return no(why) }
    if (typeof phoneId === 'string' && phoneId.length > LEDGER_STRING_MAX) return no('bad_phone_id')
    const c = this.codes.get(code)
    if (!c) {
      this.wrongCodes++
      if (this.lockedOut) {
        this.codes.clear()
        return no('locked_out')
      }
      return no('unknown_code')
    }
    this.codes.delete(code)
    if (originShared(origin, this.isShared)) return no('shared_machine')
    if (this.now() >= c.expiresAt) return no('expired')
    if (!phoneId) return no('no_phone_id')
    if (!phonePub) return no('no_phone_pub')
    // P-256 move (Shield rule 3): only a parsed 65-byte uncompressed P-256 point on the curve; anything else
    // (an Ed25519 key, a compressed point, SPKI or other wrapping) is refused.
    if (!rawPhoneKey(phonePub)) return no('bad_phone_key')
    const check = pairingCheck(code, phonePub, c.deviceNonce)
    const transport = typeof origin.machinePub === 'string' && origin.machinePub ? origin.machinePub : phonePub
    this.pendingPairs.set(phoneId, { phonePub, transport, check, expiresAt: c.expiresAt })
    this.onChange?.()
    this.lastRefusal.delete(phoneId)
    return { ok: true, check, deviceNonce: c.deviceNonce, expiresAt: c.expiresAt }
  }

  /** The check string the device should show for a pending phone, or null. */
  pendingCheck(phoneId: string): string | null {
    return this.pendingPairs.get(phoneId)?.check ?? null
  }

  confirm(phoneId: string, confirmedBy: AskChannel, matched: boolean): boolean {
    const pend = this.pendingPairs.get(phoneId)
    if (!pend) return this.refuse(phoneId, 'no_pending')
    if (confirmedBy !== 'touch') return this.refuse(phoneId, 'not_touch')
    this.pendingPairs.delete(phoneId)
    if (this.now() >= pend.expiresAt) return this.refuse(phoneId, 'expired')
    if (matched !== true) return this.refuse(phoneId, 'check_mismatch')
    { const why = this.changeRefusal(); if (why) return this.refuse(phoneId, why) }
    const reset = this.ledger.pendingReset()
    // Shield deny key condition 4: a main-key rotation (re-pair with another key) revokes the deny key, in this save.
    const before = this.phones.get(phoneId)
    const rotated = before !== undefined && before !== '' && before !== pend.phonePub
    if (before !== pend.phonePub && this.denyKeys.delete(phoneId)) this.ledger.append({ kind: 'deny_key_revoked', phoneId, reason: 'main_key_rotated', by: 'daemon' })
    this.phones.set(phoneId, pend.phonePub)
    this.transports.set(phoneId, pend.transport)
    this.lastRefusal.delete(phoneId)
    this.log.push({ at: this.now(), event: 'pair', phoneId })
    this.ledger.append({ kind: rotated ? 'phone_rotated' : 'phone_paired', phoneId, fingerprint: deviceFingerprint(pend.phonePub), via: 'touch', keyAlg: 'p256' })
    if (reset) this.ledger.append({ kind: 'ledger_ack', phoneId, by: 'touch', via: 'touch', since: reset.seq })
    this.onChange?.()
    return true
  }

  unpair(phoneId: string, meta: { by?: string; via?: string; askId?: string } = {}): boolean {
    // Shield B5: no pairing change while an unacknowledged ledger_reset is pending.
    if (this.changesLocked()) return false
    const key = this.phones.get(phoneId)
    const was = this.phones.delete(phoneId)
    this.transports.delete(phoneId)
    // Shield deny key condition 4: atomically with the unpair (one journal write: onChange runs once, below).
    const hadDeny = this.denyKeys.delete(phoneId)
    if (was) {
      this.log.push({ at: this.now(), event: 'unpair', phoneId })
      const save = this.ledger.onChange; this.ledger.onChange = undefined
      try {
        if (hadDeny) this.ledger.append({ kind: 'deny_key_revoked', phoneId, reason: 'unpaired', by: meta.by ?? 'daemon' })
        this.ledger.append({ kind: 'phone_unpaired', phoneId, ...(key ? { fingerprint: deviceFingerprint(key) } : {}), by: meta.by ?? 'local_socket', via: meta.via ?? 'local_socket', ...(meta.askId ? { askId: meta.askId } : {}) })
      } finally { this.ledger.onChange = save }
    }
    this.onChange?.()
    // Shield R7 ruling: the last phone gone ends the open phone Asks (no_paired_phone), by pairing state alone.
    if (was && this.phones.size === 0) { try { this.onLastUnpaired?.() } catch { /* a listener never changes the result */ } }
    return was
  }
  /** Shield B5/B6: after a ledger_reset, record the state that was kept (via ledger_reset), so the new chain backs it. */
  carryOverAfterReset(): void {
    for (const [id, key] of this.phones) if (key) this.ledger.append({ kind: 'phone_paired', phoneId: id, fingerprint: deviceFingerprint(key), by: 'daemon', via: 'ledger_reset', keyAlg: 'p256' })
    for (const [id, d] of this.denyKeys) this.ledger.append({ kind: 'deny_key_set', phoneId: id, fingerprint: deviceFingerprint(d.pub), by: 'daemon', via: 'ledger_reset', keyAlg: 'p256' })
  }
  /**
   * Shield B6: with a trusted ledger the ledger is authoritative for state. A paired phone (or deny key) whose key
   * does not match its latest ledger entry is dropped (pair_refused or deny_key_revoked, reason not_in_ledger), and a
   * phone the ledger says is paired but the state lost is recorded as unpaired (missing_from_state). True if anything changed.
   */
  reconcileWithLedger(): boolean {
    const all = this.ledger.all()
    const latest = (id: string, kinds: readonly string[]) => { for (let i = all.length - 1; i >= 0; i--) { const e = all[i]!; if (e.phoneId === id && kinds.includes(e.kind)) return e } return null }
    const PHONE = ['phone_paired', 'phone_rotated', 'phone_unpaired'] as const
    let changed = false
    for (const [id, key] of [...this.phones]) {
      if (!key) continue
      const e = latest(id, PHONE)
      if (!e || e.kind === 'phone_unpaired' || e.fingerprint !== deviceFingerprint(key)) {
        this.phones.delete(id); this.transports.delete(id); this.denyKeys.delete(id)
        this.ledger.append({ kind: 'pair_refused', phoneId: id, fingerprint: deviceFingerprint(key), reason: 'not_in_ledger', by: 'daemon', via: 'daemon' })
        changed = true
      }
    }
    for (const [id, d] of [...this.denyKeys]) {
      const e = latest(id, ['deny_key_set', 'deny_key_revoked'])
      if (!e || e.kind === 'deny_key_revoked' || e.fingerprint !== deviceFingerprint(d.pub)) {
        this.denyKeys.delete(id)
        this.ledger.append({ kind: 'deny_key_revoked', phoneId: id, reason: 'not_in_ledger', by: 'daemon' })
        changed = true
      }
    }
    for (const id of new Set(all.map((e) => e.phoneId).filter((x): x is string => typeof x === 'string'))) {
      const e = latest(id, PHONE)
      if (e && e.kind !== 'phone_unpaired' && !this.phones.has(id)) {
        this.ledger.append({ kind: 'phone_unpaired', phoneId: id, ...(e.fingerprint ? { fingerprint: e.fingerprint } : {}), reason: 'missing_from_state', by: 'daemon', via: 'daemon' })
        changed = true
      }
    }
    return changed
  }
  /** Shield B5: the paired phone acknowledges the pending ledger_reset (the caller checked its main-key signature). */
  ackReset(phoneId: string, seq: number, hash: string): boolean {
    const r = this.ledger.pendingReset()
    if (!r || r.seq !== seq || r.hash !== hash || !this.phones.get(phoneId)) return false
    this.ledger.append({ kind: 'ledger_ack', phoneId, by: phoneId, via: 'phone', since: r.seq })
    this.onChange?.()
    return true
  }
  /** Called when an unpair leaves no paired phone (the journal ends open phone Asks with no_paired_phone). */
  onLastUnpaired?: () => void

  /** paired > pending (not expired) > last refusal > unknown. */
  pairingStatus(phoneId: string): PairingStatus {
    if (this.phones.has(phoneId)) return { state: 'paired' }
    const pend = this.pendingPairs.get(phoneId)
    if (pend && this.now() < pend.expiresAt) return { state: 'pending' }
    if (pend) return { state: 'refused', reason: 'expired' }
    const reason = this.lastRefusal.get(phoneId)
    return reason !== undefined ? { state: 'refused', reason } : { state: 'unknown' }
  }

  isPaired(phoneId?: string): boolean {
    return phoneId === undefined ? this.phones.size > 0 : this.phones.has(phoneId)
  }

  /** The public key a paired phone paired with (F6 offer), or null. */
  phoneKey(phoneId: string): string | null {
    return this.phones.get(phoneId) || null
  }

  /** R5-1: paired with a key, and `pub` (the authenticated connection key) is the session identity bound at pairing. */
  isPairedKey(phoneId: string, pub: string | undefined): boolean {
    const want = this.transports.get(phoneId)
    return !!this.phones.get(phoneId) && typeof want === 'string' && want !== '' && typeof pub === 'string' && pub === want
  }

  /** Shield deny key condition 2: set (or replace) this paired phone's one deny-only key. The caller checked the main-key signature. */
  /** Shield D2a: would setDenyKey accept this key? Checked before anything changes, so a confirm is all or nothing. */
  canSetDenyKey(phoneId: string, pub: string): boolean {
    return !this.changesLocked() && !!this.phones.get(phoneId) && !!rawPhoneKey(pub) && pub !== this.phones.get(phoneId)
  }
  setDenyKey(phoneId: string, pub: string): boolean {
    if (!this.canSetDenyKey(phoneId, pub)) return false
    this.denyKeys.set(phoneId, { pub, at: this.now() })
    this.ledger.append({ kind: 'deny_key_set', phoneId, fingerprint: deviceFingerprint(pub), by: phoneId, via: 'phone', keyAlg: 'p256' })
    this.onChange?.()
    return true
  }
  denyKey(phoneId: string): string | null { return this.denyKeys.get(phoneId)?.pub ?? null }

  /**
   * Shield deny key condition 1: the signer's role comes from the stored keys, never from the message. The paired
   * main key may sign any verb. A signature by the stored deny-only key is valid only for 'ask.deny'; for every
   * other verb, listed or not, it is verifier_rejected and logged. Anything else is bad_signature.
   */
  verifyPhone(phoneId: string, verb: string, message: string, signature: unknown): { ok: true; role: 'main' | 'deny_only' } | { ok: false; reason: 'unpaired_phone' | 'verifier_rejected' | 'bad_signature' } {
    const main = this.phones.get(phoneId)
    if (!main) return { ok: false, reason: 'unpaired_phone' }
    // P-256 move (Shield rule 2): phone keys verify as ECDSA P-256 / SHA-256 only; an Ed25519 signature never passes.
    if (verifyPhoneSignature(main, message, signature)) return { ok: true, role: 'main' }
    const deny = this.denyKeys.get(phoneId)
    if (deny && verifyPhoneSignature(deny.pub, message, signature)) {
      if (verb === 'ask.deny') return { ok: true, role: 'deny_only' }
      this.rejectVerifier(phoneId, verb)
      return { ok: false, reason: 'verifier_rejected' }
    }
    return { ok: false, reason: 'bad_signature' }
  }
  /** Log a verifier_rejected (condition 1); also for a deny-key answer off the phone path (condition 7). */
  rejectVerifier(phoneId: string, verb: string): void {
    this.ledger.append({ kind: 'verifier_rejected', phoneId, verb, reason: 'verifier_rejected' })
    this.onChange?.()
  }
  /** Condition 6: journal a Deny settled by the deny key; more than 3 within 60 s flags the phone. */
  noteDenyKeyDeny(phoneId: string, id: string): void {
    const at = this.now()
    this.ledger.append({ kind: 'deny_key_deny', phoneId, askId: id, by: phoneId, via: 'phone', source: 'deny_key' })
    const recent = this.denyLog.filter((e) => e.phoneId === phoneId && at - e.at < PhonePairing.DENY_BURST_WINDOW_MS)
    if (recent.length > PhonePairing.DENY_BURST) this.ledger.append({ kind: 'deny_burst', phoneId, count: recent.length, since: recent[0]!.at })
    this.onChange?.()
  }
  /** Condition 6: the summary flag lives in the ledger: the last deny_burst for this phone after its last phone_open. */
  peekDenySummary(phoneId: string): { count: number; since: number; at: number } | null {
    const all = this.ledger.all()
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i]!
      if (e.phoneId !== phoneId) continue
      if (e.kind === 'phone_open') return null
      if (e.kind === 'deny_burst') return { count: e.count ?? 0, since: e.since ?? e.at, at: e.at }
    }
    return null
  }
  /** Condition 6: the 'denied from this phone' summary for this phone open (ledger phone_open clears it). */
  takeDenySummary(phoneId: string): { count: number; since: number; at: number } | null {
    const f = this.peekDenySummary(phoneId)
    this.ledger.append({ kind: 'phone_open', phoneId, by: phoneId, via: 'phone' })
    this.onChange?.()
    return f
  }
  /** Batch B: the number of paired phones (owner channels on the phone side). */
  pairedCount(): number { return [...this.phones.values()].filter((k) => k !== '').length }
  pairedIds(): string[] { return [...this.phones.keys()] }

  toJSON(): {
    phones: string[]; phoneKeys: Record<string, string>; log: PairingLogEntry[]; refused: Record<string, string>
    denyKeys: Record<string, { pub: string; at: number }>; phoneTransports: Record<string, string>; keyAlg: 'p256'
  } {
    return {
      phones: [...this.phones.keys()], phoneKeys: Object.fromEntries(this.phones),
      phoneTransports: Object.fromEntries(this.transports), keyAlg: 'p256',
      log: this.log.map((e) => ({ ...e })), refused: Object.fromEntries(this.lastRefusal),
      denyKeys: Object.fromEntries(this.denyKeys),
    }
  }

  /** @internal */
  restore(data: { phones: string[]; phoneKeys?: Record<string, string>; log?: PairingLogEntry[]; refused?: Record<string, string> }): void {
    // A phone paired before keys were kept (no phoneKeys entry) stays listed but cannot answer until re-paired.
    // P-256 move: a phone stored with a key that is not a P-256 point (an Ed25519 key from before) stays listed
    // but cannot answer or sign until re-paired. keyAlg in the record is informational and never read back.
    const tr = (data as { phoneTransports?: unknown }).phoneTransports
    const trs = tr && typeof tr === 'object' && !Array.isArray(tr) ? tr as Record<string, unknown> : {}
    for (const p of data.phones) {
      const k = data.phoneKeys?.[p]
      const key = rawPhoneKey(k) ? k as string : ''
      this.phones.set(p, key)
      const t = trs[p]
      if (key) this.transports.set(p, typeof t === 'string' && t ? t : key)
    }
    for (const [id, why] of Object.entries(data.refused ?? {})) this.lastRefusal.set(id, why)
    for (const e of data.log ?? []) this.log.push({ ...e })
    const d = data as { denyKeys?: unknown }
    const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
    for (const [id, k] of Object.entries(obj(d.denyKeys))) {
      const x = k as { pub?: unknown; at?: unknown }
      // Only for a phone still paired with a key (a deny key never outlives its pairing).
      if (this.phones.get(id) && rawPhoneKey(x?.pub) && typeof x.at === 'number') this.denyKeys.set(id, { pub: x.pub as string, at: x.at })
    }
  }
}

// ---- F8: a send Ask shows the recipient and the first line ----

export interface SendDetails {
  recipient: string
  message: string
}

/**
 * F8: first non-empty line, trimmed, at most 80 Unicode code points (the schema's maxLength counts code points):
 * a longer line keeps 79 and adds an ellipsis, never splitting a surrogate pair. '' when there is none; callers
 * refuse that rather than send an empty firstLine.
 */
export function firstLine(message: string): string {
  const line = message.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const points = Array.from(markHidden(line.trim()))
  return points.length > 80 ? `${points.slice(0, 79).join('')}…` : points.join('')
}

/**
 * Shield R5-5, R7-2: characters that change what a line looks like without showing themselves. A category rule
 * over pinned Unicode 16.0.0 data (unicode/hidden.ts, scripts/ildra/gen-hidden.ts), not a hand list: General
 * Category Cc, Cf, Zl and Zp, Default_Ignorable_Code_Point, Bidi_Control, the variation selectors and the tag
 * characters (bidi controls, zero-width characters, soft hyphen, U+034F, invisible operators, U+FE0F, tags and
 * U+2028/2029 among them; CR, LF and tab included).
 */
export const HIDDEN_RANGES: readonly (readonly [number, number])[] = HIDDEN_DATA.split(';').map((r) => {
  const [a, b] = r.split('-')
  return [parseInt(a!, 16), parseInt(b ?? a!, 16)] as const
})
const rx = (c: number): string => `\\u{${c.toString(16)}}`
const HIDDEN_CLASS = HIDDEN_RANGES.map(([a, b]) => (a === b ? rx(a) : `${rx(a)}-${rx(b)}`)).join('')
const HIDDEN_CHAR = new RegExp(`[${HIDDEN_CLASS}]`, 'u')
const HIDDEN_CHARS = new RegExp(`[${HIDDEN_CLASS}]`, 'gu')
/**
 * The protocol schema's AskRequest.recipient pattern, generated from the same table (a spec checks they are
 * equal): BMP code points as \\uXXXX escapes, astral ones as the characters themselves (the schema file holds
 * them as JSON surrogate escapes), so it reads the same in ECMAScript with the u flag (ajv's default) and in Python re.
 */
export const HIDDEN_SCHEMA_PATTERN = `^[^${HIDDEN_RANGES.map(([a, b]) => {
  const one = (c: number): string => (c <= 0xFFFF ? `\\u${c.toString(16).toUpperCase().padStart(4, '0')}` : String.fromCodePoint(c))
  return a === b ? one(a) : `${one(a)}-${one(b)}`
}).join('')}]+$`

/** True when `s` holds a hidden character (HIDDEN_RANGES). A recipient with one is refused (malformed). */
export function hasHiddenChar(s: string): boolean { return HIDDEN_CHAR.test(s) }

/**
 * Shield R5-5: the first-line display shows each hidden character as a visible marker, `⟦U+202E⟧` (a tab shows as a space), so a
 * reversed or split line cannot pass for a plain one. Display only: the digest covers the message's sha256.
 */
export function markHidden(s: string): string {
  return s.replace(HIDDEN_CHARS, (c) => c === '\t' ? ' ' : `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`)
}

/**
 * Flags on a recipient (Shield R5-5, v3.3), display and routing only (the recipient itself is in digest8):
 * mixed_script, lookalike (UTS #39 skeleton of a known contact or domain, different text), non_ascii (any
 * non-ASCII character in the address, local part or domain; R7-3), new_recipient (first send to it; informational). The first three are phone only
 * and no Auto rule covers them (PHONE_ONLY_FLAGS).
 */
export type RecipientFlag = 'mixed_script' | 'lookalike' | 'non_ascii' | 'new_recipient'
export const RECIPIENT_FLAGS: readonly RecipientFlag[] = ['mixed_script', 'lookalike', 'non_ascii', 'new_recipient']
export const PHONE_ONLY_FLAGS: ReadonlySet<RecipientFlag> = new Set(['mixed_script', 'lookalike', 'non_ascii'])
export function phoneOnlyRecipient(flags: readonly RecipientFlag[] | null | undefined): boolean {
  return !!flags && flags.some((f) => PHONE_ONLY_FLAGS.has(f))
}
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Cherokee', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Devanagari']
  .map((n) => [n, new RegExp(`\\p{Script=${n}}`, 'u')] as const)
const LETTER = /\p{L}/u

/** The scripts of the letters in `s`; a letter in none of SCRIPTS counts as its own 'Other' script. */
function scriptsOf(s: string): Set<string> {
  const out = new Set<string>()
  for (const ch of s) {
    if (!LETTER.test(ch)) continue
    out.add(SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? 'Other')
  }
  return out
}

/**
 * Shield R5-5, R7-3: 'mixed_script' when the recipient's domain mixes letter scripts (as a whole or within one
 * label, e.g. Cyrillic а in "pаypal.com"), or its local part does, or the address as a whole does (a Cyrillic
 * local part at a Latin domain). Shown, never refused: the digest still
 * binds the exact text, so the device approves what it showed.
 */
export function recipientFlags(recipient: string, known?: RecipientKnowledge): RecipientFlag[] {
  const r = recipient.normalize('NFC')
  const at = r.lastIndexOf('@')
  const local = at >= 0 ? r.slice(0, at) : ''
  const domain = at >= 0 ? r.slice(at + 1) : r
  const out: RecipientFlag[] = []
  // R7-3: the local part, the domain (and so each label), and the whole address are each checked; a Cyrillic
  // local part at a Latin domain mixes scripts across the address.
  if (scriptsOf(local).size > 1 || scriptsOf(domain).size > 1 || scriptsOf(`${local}${domain}`).size > 1) out.push('mixed_script')
  if (known && isLookalike(r, known)) out.push('lookalike')
  // R7-3: any non-ASCII character anywhere in the address (local part or domain).
  if (NON_ASCII_CHAR.test(r)) out.push('non_ascii')
  if (known && isNewRecipient(r, known)) out.push('new_recipient')
  return out
}

const FLAG_LABEL: Record<RecipientFlag, string> = { mixed_script: 'mixed script', lookalike: 'looks like a contact', non_ascii: 'non-ASCII', new_recipient: 'new recipient' }
// eslint-disable-next-line no-control-regex
const NON_ASCII_CHAR = /[^\u0000-\u007F]/

/**
 * Display form of a recipient: as is (punycode domain when non_ascii, v3.3), with a visible marker per flag,
 * e.g. "bob@xn--pypal-4ve.com (bob@pаypal.com) [⚠ mixed script, non-ASCII domain]".
 */
export function recipientDisplay(recipient: string, flags: readonly RecipientFlag[] = recipientFlags(recipient), ascii?: string | null): string {
  const a = ascii === undefined ? recipientAscii(recipient) : ascii
  const shown = flags.includes('non_ascii') && a && a !== recipient ? `${a} (${recipient})` : recipient
  // new_recipient is informational: the phone shows it from recipientFlags; the prompt text stays as it was.
  const domainPart = recipient.slice(recipient.lastIndexOf('@') + 1)
  const warn = flags.filter((f) => f !== 'new_recipient')
    .map((f) => (f === 'non_ascii' ? (NON_ASCII_CHAR.test(domainPart) ? 'non-ASCII domain' : 'non-ASCII address') : FLAG_LABEL[f]))
  return warn.length ? `${shown} [⚠ ${warn.join(', ')}]` : shown
}

/** Shield R5-5: a recipient carrying a hidden character; the Ask is refused as malformed. */
export class UnsafeRecipient extends ApprovalDenied {
  constructor() { super('a recipient may not contain bidi controls, zero-width characters, line breaks or other controls (malformed)') }
}

// ---- Gadget device mapping (protocol/README.md; eng/reference device_api v2) ----

/** The firmware's answer_id: 128 random bits as 32 lowercase hex, fresh per reply. */
export const DEVICE_ANSWER_ID = /^[0-9a-f]{32}$/
/** What the device shows for an Ask it may not answer (locked_ask and money: phone only). */
export const USE_YOUR_PHONE = 'Use your phone'
const DEVICE_REPLY_KEYS = ['answer', 'answer_id', 'digest8', 'hold_ms', 'id']

/**
 * Gadget `prompt.reply {id, answer_id, answer: "yes"|"no", digest8, hold_ms}` (snake_case, Ildra firmware fork)
 * to an AskAnswer body, or null when it is not exactly that. A stock reply (no digest8, hold_ms or answer_id)
 * never maps, so it can never approve.
 */
export function fromDeviceReply(msg: unknown): AskAnswer | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
  const m = msg as Record<string, unknown>
  if ((m.type ?? 'prompt.reply') !== 'prompt.reply') return null
  const keys = Object.keys(m).filter((k) => k !== 'type').sort()
  if (keys.join(',') !== DEVICE_REPLY_KEYS.join(',')) return null
  const h = m.hold_ms
  if ((m.answer !== 'yes' && m.answer !== 'no') || typeof m.id !== 'string' || typeof m.digest8 !== 'string'
    || typeof m.answer_id !== 'string' || !DEVICE_ANSWER_ID.test(m.answer_id)
    || typeof h !== 'number' || !Number.isFinite(h) || h < 0) return null
  return { id: m.id, answerId: m.answer_id, digest8: m.digest8, approved: m.answer === 'yes', holdMs: h }
}

export type DeviceMessage =
  | { type: 'prompt'; id: string; title: 'Ask'; text: string; ttl_s: number; digest8: string }
  | { type: 'display'; title: 'Ask'; body: typeof USE_YOUR_PHONE; ttl_s: number }

/** What the device gets for an open Ask: a Gadget prompt for touch, a "Use your phone" card for phone Asks. */
export function toDeviceMessage(req: AskRequest, now: number): DeviceMessage {
  const ttl_s = Math.max(0, Math.floor((req.expiresAt - now) / 1000))
  if (req.channel === 'touch') {
    // v3.3: a phone-only Ask (flagged recipient among them) never reaches the device prompt.
    if (phoneOnly(req.tier, req.amountMinor, req.recipientFlags)) return { type: 'display', title: 'Ask', body: USE_YOUR_PHONE, ttl_s }
    const text = req.recipient !== undefined ? `${req.action}\nTo ${recipientDisplay(req.recipient, req.recipientFlags ?? [], req.recipientAscii ?? null)}: ${req.firstLine ?? ''}` : req.action
    return { type: 'prompt', id: req.id, title: 'Ask', text, ttl_s, digest8: req.digest8 }
  }
  if (req.channel === 'phone') return { type: 'display', title: 'Ask', body: USE_YOUR_PHONE, ttl_s }
  throw new ApprovalDenied('voice Asks are not on the Gadget device path (voice is off in the pilot)')
}

// ---- F5 + F2 journal: totals, pending Asks and pairings survive a restart ----

const JOURNAL_VERSION = 1

function isEntry(e: unknown): e is WindowEntry {
  const x = e as WindowEntry
  return !!x && typeof x === 'object' && Number.isFinite(x.at) && Number.isInteger(x.count) && x.count >= 1 && Number.isInteger(x.amountMinor) && x.amountMinor >= 0
}

function isRequest(r: unknown): r is AskRequest {
  const x = r as AskRequest
  return !!x && typeof x.id === 'string' && /^[0-9a-f]{8}$/.test(x.digest8) && Number.isFinite(x.expiresAt) && Number.isFinite(x.openedAt)
    && KNOWN_CHANNELS.has(x.channel) && x.tier in TIER_RANK && (x.challenge === undefined || typeof x.challenge === 'string')
    && (x.amountMinor === undefined || (Number.isInteger(x.amountMinor) && x.amountMinor >= 0))
    && typeof x.action === 'string' && (x.currency === undefined ? x.amountMinor === undefined : x.currency === 'USD' && x.amountMinor !== undefined)
    && ['agentId', 'templateId', 'recipient', 'firstLine', 'recipientAscii', 'lookalikeOf'].every((k) => (x as unknown as Record<string, unknown>)[k] === undefined || typeof (x as unknown as Record<string, unknown>)[k] === 'string')
    && (x.kind === undefined || (x.kind === 'safety_verification' && x.tier === 'locked_ask') || (x.kind === 'practice' && x.action === PRACTICE_ACTION && x.amountMinor === undefined && x.recipient === undefined))
    && (x.recipientFlags === undefined || (Array.isArray(x.recipientFlags) && x.recipientFlags.every((f) => RECIPIENT_FLAGS.includes(f))))
}

function isLog(e: unknown): boolean {
  const x = e as PairingLogEntry
  return !!x && Number.isFinite(x.at) && ['pair', 'unpair', 'refused'].includes(x.event) && typeof x.phoneId === 'string'
}

function parseJournal(text: string) {
  const d = JSON.parse(text)
  if (!d || d.v !== JOURNAL_VERSION) throw new Error('bad version')
  const w = d.window
  if (!w || !Number.isFinite(w.lockedUntil) || !w.entries || typeof w.entries !== 'object') throw new Error('bad window')
  for (const list of Object.values(w.entries)) if (!Array.isArray(list) || !list.every(isEntry)) throw new Error('bad entry')
  const l = d.ledger
  if (!l || !Array.isArray(l.open) || !l.open.every(isRequest) || !Array.isArray(l.spent)) throw new Error('bad ledger')
  if (!l.spent.every((s: unknown) => Array.isArray(s) && typeof s[0] === 'string' && Number.isFinite(s[1]))) throw new Error('bad spent')
  // Journals from before answer ids (ad47477) have none; any present must be well formed.
  if (l.spentAnswers !== undefined && (!Array.isArray(l.spentAnswers)
    || !l.spentAnswers.every((s: unknown) => Array.isArray(s) && typeof s[0] === 'string' && Number.isFinite(s[1])))) throw new Error('bad spent answers')
  const p = d.pairing
  if (!p || !Array.isArray(p.phones) || !p.phones.every((x: unknown) => typeof x === 'string')) throw new Error('bad pairing')
  if (p.log !== undefined && (!Array.isArray(p.log) || !p.log.every(isLog))) throw new Error('bad pairing log')
  if (p.refused !== undefined && (!p.refused || typeof p.refused !== 'object' || Array.isArray(p.refused) || !Object.values(p.refused).every((x) => typeof x === 'string'))) throw new Error('bad pairing refused')
  if (d.settings !== undefined && (!d.settings || typeof d.settings !== 'object')) throw new Error('bad settings')
  // Batch A: { device: EnrolledDevice | null, pending }. A pre-batch-A record ({ pub, at }) carries no uv: it restores as
  // not enrolled (the phone confirms the device again), and does not fail the journal.
  if (d.device !== undefined && d.device !== null && (typeof d.device !== 'object' || Array.isArray(d.device)
    || (d.device.device !== undefined && d.device.device !== null && typeof d.device.device !== 'object'))) throw new Error('bad device')
  return { window: w, ledger: l, pairing: p, settings: d.settings, device: d.device, pairingLedger: d.pairingLedger as unknown, pairingLedgerMac: d.pairingLedgerMac as unknown }
}

/** v3.3: ask.deviceWindowSec, seconds an Ask stays on the device before it hands off to the phone. */
export const DEVICE_WINDOW_SEC = { min: 30, max: 300, default: 60 } as const
export const ASK_SETTING_KEYS = ['ask.deviceWindowSec'] as const
export type AskSettingKey = typeof ASK_SETTING_KEYS[number]

/**
 * Daemon Ask settings (v3.3), journaled. Set only through `ildra.settings.set` from the paired phone's key
 * (services/ildraAsk.ts); the stored (clamped) value is echoed back as `ildra.settings.value`.
 */
export class AskSettings {
  deviceWindowSec: number = DEVICE_WINDOW_SEC.default
  onChange?: () => void
  /** Store a setting; the value is clamped to its range and rounded. Null for an unknown key or a non-number. */
  set(key: unknown, value: unknown): { key: AskSettingKey; value: number } | null {
    if (key !== 'ask.deviceWindowSec' || typeof value !== 'number' || !Number.isFinite(value)) return null
    this.deviceWindowSec = Math.min(DEVICE_WINDOW_SEC.max, Math.max(DEVICE_WINDOW_SEC.min, Math.round(value)))
    this.onChange?.()
    return { key, value: this.deviceWindowSec }
  }
  get(key: AskSettingKey): number { return key === 'ask.deviceWindowSec' ? this.deviceWindowSec : NaN }
  toJSON(): { deviceWindowSec: number } { return { deviceWindowSec: this.deviceWindowSec } }
  restore(d: unknown): void {
    const v = (d as { deviceWindowSec?: unknown } | null)?.deviceWindowSec
    if (typeof v === 'number' && Number.isFinite(v)) this.deviceWindowSec = Math.min(DEVICE_WINDOW_SEC.max, Math.max(DEVICE_WINDOW_SEC.min, Math.round(v)))
  }
}

/** Shield R7-1: how long a device enrollment waits for the paired phone's confirm. */
export const DEVICE_ENROLL_TTL_MS = 10 * 60_000
const rawKey = (pub: unknown): Buffer | null => rawDeviceKey(pub)

/**
 * Shield R7-1: the one Ildra device whose bridge may answer touch and voice Asks, by its Ed25519 public key
 * (kept in the journal like the phone keys). A gateway pairing (`harness pair`, any device-role identity) grants
 * no touch authority. Enrollment: begin(pub) records a pending request (the device and the phone show the same
 * fingerprint); only the paired phone's key confirms it (`ildra.device.enroll.confirm`, checked by the service);
 * nothing else makes a key the device. A connection then answers touch only after signing a fresh core nonce with
 * that key (core/ildraAsk.ts challenge and prove). confirm(pub, false) on the enrolled key revokes it.
 */
export type EnrollSource = 'local_socket' | 'device'
export interface EnrolledDevice { pub: string; at: number; uv: EnrollUv; phoneId: string; nonce: string }
export interface PendingEnrollment { pub: string; at: number; expiresAt: number; nonce: string; source: EnrollSource }
/** Batch A: a pending enrollment replaced by a later enroll request (any source); the paired phone is alerted. */
export interface EnrollReplaced { oldFingerprint: string; newFingerprint: string; source: EnrollSource; at: number }

export class AskDeviceEnrollment {
  private dev_: EnrolledDevice | null = null
  private pending_: PendingEnrollment | null = null
  onChange?: () => void
  /** Batch B: enrollment events go to the pairing ledger (openJournal shares the journal's one). */
  ledger: PairingLedger | null = null
  constructor(private readonly now: () => number = Date.now) {}
  /**
   * Record a pending enrollment for `pub` with a fresh nonce the phone's confirm must sign. Any later request,
   * from the device or the local socket, replaces a pending one (returned as `replaced`, for the phone alert).
   * Null for a malformed key.
   */
  begin(pub: unknown, source: EnrollSource = 'device'): { devicePub: string; fingerprint: string; nonce: string; expiresAt: number; replaced: EnrollReplaced | null } | null {
    if (!rawKey(pub)) return null
    const at = this.now()
    const old = this.pending_ && at < this.pending_.expiresAt ? this.pending_ : null
    this.pending_ = { pub: pub as string, at, expiresAt: at + DEVICE_ENROLL_TTL_MS, nonce: randomBytes(32).toString('base64url'), source }
    this.onChange?.()
    const replaced = old ? { oldFingerprint: deviceFingerprint(old.pub), newFingerprint: deviceFingerprint(pub as string), source, at } : null
    if (replaced) this.ledger?.append({ kind: 'device_enroll_replaced', fingerprint: replaced.newFingerprint, oldFingerprint: replaced.oldFingerprint, by: source, via: source })
    this.ledger?.append({ kind: 'device_enroll_requested', fingerprint: deviceFingerprint(pub as string), by: source, via: source })
    return { devicePub: pub as string, fingerprint: deviceFingerprint(pub as string), nonce: this.pending_.nonce, expiresAt: this.pending_.expiresAt, replaced }
  }
  pending(): { devicePub: string; fingerprint: string; nonce: string; expiresAt: number; source: EnrollSource } | null {
    const p = this.pending_
    if (!p || this.now() >= p.expiresAt) return null
    return { devicePub: p.pub, fingerprint: deviceFingerprint(p.pub), nonce: p.nonce, expiresAt: p.expiresAt, source: p.source }
  }
  /**
   * The paired phone's signed answer (the caller has checked the phone key, uv and the signature). On the current
   * pending enrollment with this key and nonce: approved enrolls it (replacing any earlier device) and journals uv
   * and the phone; declined refuses it. Declined with the enrolled key and its enrollment nonce revokes it. Null
   * when there is no such enrollment.
   */
  confirm(pub: unknown, nonce: unknown, approved: boolean, by: { uv: EnrollUv; phoneId: string }): 'enrolled' | 'refused' | 'revoked' | 'expired' | null {
    const p = this.pending_
    if (!approved && this.dev_ && this.dev_.pub === pub && this.dev_.nonce === nonce && !(p && p.pub === pub && p.nonce === nonce)) {
      this.ledger?.append({ kind: 'device_revoked', fingerprint: deviceFingerprint(this.dev_.pub), by: by.phoneId, via: 'phone', uv: by.uv })
      this.revoke(); return 'revoked'
    }
    if (!p || p.pub !== pub || p.nonce !== nonce) return null
    this.pending_ = null
    if (this.now() >= p.expiresAt) { this.ledger?.append({ kind: 'device_expired', fingerprint: deviceFingerprint(p.pub), by: 'daemon' }); this.onChange?.(); return 'expired' }
    if (approved) this.dev_ = { pub: p.pub, at: this.now(), uv: by.uv, phoneId: by.phoneId, nonce: p.nonce }
    this.ledger?.append({ kind: approved ? 'device_enrolled' : 'device_refused', fingerprint: deviceFingerprint(p.pub), by: by.phoneId, via: 'phone', uv: by.uv, ...(approved ? { keyAlg: 'ed25519' as const } : {}) })
    this.onChange?.()
    return approved ? 'enrolled' : 'refused'
  }
  revoke(): void { this.dev_ = null; this.onChange?.() }
  /** The enrolled device key, or null. */
  device(): string | null { return this.dev_?.pub ?? null }
  /** The enrolled device record (key, when, the phone's uv and phone id), or null. */
  enrolled(): EnrolledDevice | null { return this.dev_ ? { ...this.dev_ } : null }
  toJSON(): { device: EnrolledDevice | null; pending: PendingEnrollment | null } {
    return { device: this.dev_, pending: this.pending_ }
  }
  restore(d: unknown): void {
    const x = d as { device?: Partial<EnrolledDevice> | null; pending?: Partial<PendingEnrollment> | null } | null
    if (!x || typeof x !== 'object') return
    const v = x.device
    if (v && rawKey(v.pub) && typeof v.at === 'number' && (ENROLL_UV as readonly unknown[]).includes(v.uv) && typeof v.phoneId === 'string' && typeof v.nonce === 'string') {
      this.dev_ = { pub: v.pub as string, at: v.at, uv: v.uv as EnrollUv, phoneId: v.phoneId, nonce: v.nonce }
    }
    const p = x.pending
    if (p && rawKey(p.pub) && typeof p.at === 'number' && typeof p.expiresAt === 'number' && typeof p.nonce === 'string' && (p.source === 'local_socket' || p.source === 'device')) {
      this.pending_ = { pub: p.pub as string, at: p.at, expiresAt: p.expiresAt, nonce: p.nonce, source: p.source }
    }
  }
}

/** Shield B5: a ledger_reset counts as this many unpair requests in the unpair rate limit (the limit never resets). */
export const UNPAIR_RESET_COUNT = 3

export interface ApprovalJournal {
  window: ApprovalWindow
  ledger: AskLedger
  pairing: PhonePairing
  /** v3.3 daemon Ask settings (ask.deviceWindowSec). */
  settings: AskSettings
  /** Shield R7-1: the enrolled Ildra device (its bridge alone answers touch and voice Asks). */
  device: AskDeviceEnrollment
  /** Batch B: the authoritative pairing ledger (phones and devices, append-only, chained, journaled). */
  pairingLedger: PairingLedger
  /** True when the file existed but could not be trusted; voice is off for one window. */
  recovered: boolean
  save(): void
}

/** realpath of the nearest existing ancestor, with the parts that do not exist yet put back (R3-1). */
function realpathNearest(p: string): string {
  const rest: string[] = []
  let cur = resolvePath(p)
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse())
    } catch {
      const up = dirname(cur)
      if (up === cur) return join(cur, ...rest.reverse())
      rest.push(basename(cur))
      cur = up
    }
  }
}

/** Shield R3-1: two folders overlap when, after following symlinks, one is the other or lies inside it. */
function foldersOverlap(a: string, b: string): boolean {
  const ra = realpathNearest(a)
  const rb = realpathNearest(b)
  const inside = (x: string, y: string) => x === y || x.startsWith(y.endsWith(sep) ? y : y + sep)
  return inside(ra, rb) || inside(rb, ra)
}

/**
 * Default install marker for a journal: `$ILDRA_MARKER_DIR` (or `~/.ildra/install-markers`), named by a
 * hash of the journal's absolute path, so it never shares the journal's folder.
 */
export function defaultMarkerPath(journalPath: string): string {
  const base = process.env.ILDRA_MARKER_DIR || join(homedir(), '.ildra', 'install-markers')
  const tag = createHash('sha256').update(resolvePath(journalPath)).digest('hex').slice(0, 16)
  return join(resolvePath(base), `${tag}.installed`)
}

/**
 * Open (or create) the 0600 journal at `path`. Every change to the window, ledger or pairing is written
 * through atomically. A corrupt or tampered file fails closed: totals cannot be trusted, so voice is
 * off for every agent for one full window, pending Asks are dropped (denied) and no phone is paired.
 */
export function openJournal(
  path: string,
  opts: {
    now?: () => number; windowMs?: number; ttlMs?: number; verifier?: AnswerVerifier; voiceMoneyLimitMinor?: number; bulkCount?: number
    /** Shield R7: the Ask service's journal (createIldraAsk) settles only core-stamped answers. */
    requireChannelStamp?: boolean
    /**
     * F5: install marker, written once. Marker present and journal missing fails closed. Defaults to
     * defaultMarkerPath(path). A marker in the journal's folder, or below it, is refused (Shield pilot review).
     */
    markerPath?: string
    /** Shield B1 to B4: the ledger MAC key file (32 bytes hex, 0600). Defaults to `<markerPath>.ledger-key`. */
    ledgerKeyPath?: string
  } = {},
): ApprovalJournal {
  const now = opts.now ?? Date.now
  const window = new ApprovalWindow({ now, windowMs: opts.windowMs, voiceMoneyLimitMinor: opts.voiceMoneyLimitMinor, bulkCount: opts.bulkCount })
  const ledger = new AskLedger({ now, ttlMs: opts.ttlMs, verifier: opts.verifier, requireChannelStamp: opts.requireChannelStamp === true })
  const pairingLedger = new PairingLedger(now)
  const pairing = new PhonePairing({ now, ledger: pairingLedger })
  const settings = new AskSettings()
  const device = new AskDeviceEnrollment(now)
  device.ledger = pairingLedger
  let recovered = false
  /** Shield B5: start the ledger with a ledger_reset (keeping the untrusted one aside in a 0600 file next to the journal). */
  const ledgerReset = (reason: string, untrusted: unknown): void => {
    let oldHead: string | undefined
    if (Array.isArray(untrusted) && untrusted.length > 0) {
      const h = (untrusted.at(-1) as { hash?: unknown } | null)?.hash
      if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) oldHead = h
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(`${path}.ledger-untrusted-${now()}.json`, JSON.stringify(untrusted), { mode: 0o600 })
      } catch { /* keeping a copy is best effort; the reset entry still records the old head */ }
    }
    pairingLedger.restore([])
    pairingLedger.append({ kind: 'ledger_reset', reason, by: 'daemon', count: UNPAIR_RESET_COUNT, ...(oldHead ? { oldHead } : {}) })
  }
  const marker = resolvePath(opts.markerPath ?? defaultMarkerPath(path))
  // Shield B1 to B4: the ledger head is MACed (HMAC-SHA256) with a key held by this host next to the install marker,
  // outside the journal's folder: an edited, truncated, deleted or re-chained ledger no longer verifies.
  const keyPath = resolvePath(opts.ledgerKeyPath ?? `${marker}.ledger-key`)
  let ledgerKey: Buffer | null = null
  try { const k = readFileSync(keyPath, 'utf8').trim(); if (/^[0-9a-f]{64}$/.test(k)) ledgerKey = Buffer.from(k, 'hex') } catch { /* none yet */ }
  const keyExisted = ledgerKey !== null
  const ledgerMac = (key: Buffer): string => { const h = pairingLedger.head(); return createHmac('sha256', key).update(`ildra-pairing-ledger-mac:v1|${h.seq}|${h.hash}`, 'utf8').digest('hex') }
  if (foldersOverlap(dirname(marker), dirname(resolvePath(path)))) {
    throw new ApprovalDenied('the install marker must not be in the journal\'s folder (or link into it): deleting that folder would delete both')
  }
  if (!existsSync(path) && existsSync(marker)) {
    // The journal was deleted after install: totals cannot be trusted.
    recovered = true
    window.lockedUntil = now() + window.windowMs
    ledgerReset('journal_missing', undefined)
  } else if (existsSync(path)) {
    let d: ReturnType<typeof parseJournal> | null = null
    try {
      d = parseJournal(readFileSync(path, 'utf8'))
      window.restore(d.window)
      ledger.restore(d.ledger)
      pairing.restore(d.pairing)
      settings.restore(d.settings)
      device.restore(d.device)
    } catch {
      recovered = true
      window.lockedUntil = now() + window.windowMs
      ledgerReset('journal_unreadable', d?.pairingLedger)
      d = null
    }
    if (d) {
      let why: string | null = null
      try { pairingLedger.restore(d.pairingLedger) } catch { why = 'chain_broken' }
      if (!why) {
        const mac = d.pairingLedgerMac
        if (ledgerKey) {
          const want = Buffer.from(ledgerMac(ledgerKey), 'hex')
          const got = typeof mac === 'string' && /^[0-9a-f]{64}$/.test(mac) ? Buffer.from(mac, 'hex') : Buffer.alloc(32)
          if (!timingSafeEqual(want, got)) why = 'mac_mismatch'
        } else if (pairingLedger.all().length > 0 || pairing.pairedCount() > 0) why = 'ledger_key_missing'
      }
      if (why) {
        // Shield B5: fail closed, never to empty. Voice is off for one window, the untrusted ledger is kept aside,
        // the new chain starts with a ledger_reset carrying its head (counted as UNPAIR_RESET_COUNT unpair requests
        // for the rate limit), the kept state is recorded (via ledger_reset), and pairing changes are locked until
        // the paired phone acknowledges it.
        recovered = true
        window.lockedUntil = now() + window.windowMs
        ledgerReset(why, d.pairingLedger)
        pairing.carryOverAfterReset()
      } else if (pairing.reconcileWithLedger()) {
        // Shield B6: the state did not match the trusted ledger; what the ledger does not back was dropped.
        recovered = true
        window.lockedUntil = now() + window.windowMs
      }
    }
  }
  const save = () => {
    const body = JSON.stringify({ v: JOURNAL_VERSION, window: window.toJSON(), ledger: ledger.toJSON(), pairing: pairing.toJSON(), settings: settings.toJSON(), device: device.toJSON(), pairingLedger: pairingLedger.toJSON(), pairingLedgerMac: ledgerMac(ledgerKey!) })
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, path)
  }
  if (!ledgerKey) {
    ledgerKey = randomBytes(32)
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, `${ledgerKey.toString('hex')}\n`, { mode: 0o600 })
  }
  void keyExisted
  window.onChange = save
  ledger.onChange = save
  pairing.onChange = save
  pairing.onLastUnpaired = () => { ledger.endPhoneAsks('no_paired_phone') }
  settings.onChange = save
  device.onChange = save
  pairingLedger.onChange = save
  save()
  if (!existsSync(marker)) {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, `${now()}\n`, { mode: 0o600 })
  }
  return { window, ledger, pairing, settings, device, pairingLedger, recovered, save }
}

// ---- ask ----

/** Production answers with an AskAnswer; reference mode answers with literal true. */
export type AnswerFn = (channel: AskChannel, prompt: string, req?: AskRequest) => unknown

export interface AskOptions {
  /**
   * Reference mode: no ledger, bare-boolean answers, caller-declared isWrite. Only for parity with
   * eng/reference; never in production. Without it the production rules below are enforced.
   */
  reference?: boolean
  available?: readonly string[] | null
  /** Caller hint; can only tighten (true makes a read a write). */
  isWrite?: boolean
  /** F4, required in production: the bridge's tool manifest and the tool being called. */
  kind?: { manifest: readonly ToolManifestEntry[] | null | undefined; tool: string }
  /** Amount in minor units (cents). Present means a money Ask (1 h expiry, $50 voice cap). */
  amountMinor?: number
  count?: number
  /** F5, required in production for money and send Asks. */
  window?: ApprovalWindow
  agentId?: string
  isPaired?: PairingGuard
  /** F2, required in production. */
  ledger?: AskLedger
  /** F2 extra check, called by the ledger after its own checks. Needs a ledger. */
  verifier?: AnswerVerifier
  /** F2: required for voice in production (Volt). */
  mic?: MicGuard
  /** F6: in production the phone answers only when that phone is paired here. */
  pairing?: PhonePairing
  /** F8: this Ask releases a send. Requires `send`. */
  isSend?: boolean
  send?: SendDetails
  /** Extra fields bound into the digest. */
  details?: Record<string, unknown>
  /** F12: gateway lookup for shared-account origins (sharedOriginFromPeers). */
  isShared?: SharedOriginLookup
  /** Display only: the template the agent runs. */
  templateId?: string
  /** The agent's own approval mode. 'auto' never loosens a template's Ask or locked_ask. */
  agentMode?: 'auto' | 'ask' | string
  /** v3.3: the person's known contacts and domains (lookalike, new_recipient), beyond the ledger's sent-to list. */
  contacts?: readonly string[]
  knownDomains?: readonly string[]
}

/**
 * Why an Ask ended: `approved` (only when approved is true); `denied` a person said no; `no_channel` no usable
 * channel (nothing was asked); `never` the template forbids it; `no_paired_phone` (Shield R7 ruling) the last
 * phone was unpaired while the Ask was open on the phone channel; otherwise the rejection reason of the answer
 * (expired among them). Wire: AskOutcomeReason.
 */
export type AskOutcomeReason = 'approved' | 'denied' | 'no_channel' | 'never' | 'no_paired_phone' | SettleReason
/** PM spec (v3): reason is always present; 'approved' exactly when approved is true. */
export type AskOutcome = AskResult & { reason: AskOutcomeReason; request?: AskRequest }

/** The `never` outcome for a wire consumer (ask() itself throws ApprovalDenied so the agent is told). */
/** ask(): re-prompts after hold_too_short before it gives up on a runaway answerer (the Ask stays open). */
export const MAX_REPROMPTS = 100
/** Rejections that leave the Ask open, so ask() waits for another answer. */
const KEEPS_ASK_OPEN: ReadonlySet<SettleReason> = new Set(['hold_too_short', 'stale_channel', 'wrong_channel'])
/**
 * Shield R7-10: refusals that never touch per-Ask state (only the aggregate unpaired counter). For an answer that
 * came through the core channel layer (stamped: every remote answer does), they leave the Ask open and do NOT count
 * toward MAX_REPROMPTS, so a flood cannot end an Ask early; the Ask still ends when it expires (ledger.get turns
 * null), then with reason expired. An unstamped in-process answer (a direct caller, a test) has no remote sender
 * to flood with and keeps the old bound. (no_authority from the connection is refused by the core before ask()
 * ever sees it.)
 */
const UNCOUNTED_REFUSALS: ReadonlySet<SettleReason> = new Set(['unpaired_phone', 'no_authority'])

/**
 * One settle step of ask()/practiceAsk(): 'again' (counted), 'free' (uncounted, Ask still live), 'expired', or
 * 'done'. An unpaired answer never ends an Ask (Shield R7 ruling), even with no phone paired; the pairing state
 * does (the last unpair ends open phone Asks with no_paired_phone: AskLedger.endPhoneAsks).
 */
function nextStep(ledger: AskLedger, id: string, ans: unknown, s: SettleResult, prompts: number): 'again' | 'free' | 'done' | 'expired' {
  if (s.ok) return 'done'
  if (UNCOUNTED_REFUSALS.has(s.reason) && stampedChannel(ans) !== undefined) return ledger.get(id) === null ? 'expired' : 'free'
  return (KEEPS_ASK_OPEN.has(s.reason) || UNCOUNTED_REFUSALS.has(s.reason)) && prompts < MAX_REPROMPTS ? 'again' : 'done'
}

export function neverOutcome(): AskOutcome { return { approved: false, channel: null, tier: 'never', reason: 'never' } }

/**
 * AskRequest.kind from the daemon's own inputs only: the template's safety_verification list, or the called
 * tool's single manifest entry with safetyVerification: true, stamped by a trusted source (R3-3, R5-2). Only for locked_ask.
 */
export function askKindFor(
  template: ApprovalTemplate, action: string, tier: Tier, kind?: { manifest: readonly ToolManifestEntry[] | null | undefined; tool: string },
): AskKind | undefined {
  if (tier !== 'locked_ask') return undefined
  if (Array.isArray(template.safety_verification) && template.safety_verification.includes(action)) return 'safety_verification'
  const e = kind ? lookupTool(kind.manifest, kind.tool) : 'missing'
  if (typeof e !== 'string' && e.safetyVerification === true && trustedEntry(e)) return 'safety_verification'
  return undefined
}

/** Run the Ask for an action. Never rejects before any prompt; Auto needs none; no channel fails closed. */
export async function ask(
  template: ApprovalTemplate,
  action: string,
  profile: ApprovalProfile | null | undefined,
  answerFn: AnswerFn,
  opts: AskOptions = {},
): Promise<AskOutcome> {
  const prod = opts.reference !== true
  if (opts.window && !opts.agentId) throw new ApprovalDenied('approval window needs an agentId')
  if (opts.verifier && !opts.ledger) throw new ApprovalDenied('an answer verifier needs a ledger')
  const sendTool = opts.kind ? isSendTool(opts.kind.manifest, opts.kind.tool) : false
  const isSend = opts.isSend === true || sendTool || opts.send !== undefined
  if (isSend && !(opts.send && typeof opts.send.recipient === 'string' && opts.send.recipient.trim() && typeof opts.send.message === 'string')) {
    throw new ApprovalDenied('a send Ask needs the recipient and the message')
  }
  if (isSend && firstLine(opts.send!.message) === '') throw new ApprovalDenied('a send Ask needs a non-empty first line')
  if (prod) {
    if (!opts.ledger) throw new ApprovalDenied('production Asks need a ledger (F2)')
    if (!opts.kind) throw new ApprovalDenied('production Asks need the tool manifest (F4)')
    const money = opts.amountMinor !== undefined || isSend
    if (money && !(opts.window && opts.agentId)) throw new ApprovalDenied('money and send Asks need an approval window (F5)')
  }
  let isWrite: boolean
  if (prod) {
    isWrite = classifyTool(opts.kind!.manifest, opts.kind!.tool) === 'write' || opts.isWrite === true
  } else {
    isWrite = opts.isWrite ?? true
    if (opts.kind && classifyTool(opts.kind.manifest, opts.kind.tool) === 'write') isWrite = true
    else if (opts.kind) isWrite = opts.isWrite ?? false
  }
  // agentMode is deliberately not an input to resolve(): Auto never loosens a template rule.
  let tier = resolve(template, action, profile, isWrite)
  if (tier === 'never') throw new ApprovalDenied(`never item: ${action}`)
  const malformed = (t: Tier): AskOutcome => ({ approved: false, channel: null, tier: t, reason: 'malformed' })
  // v3: a lone surrogate in the message (hashed as messageSha256) or any digest input refuses the Ask.
  // R5-5: a recipient that hides characters (bidi, zero-width, line breaks, controls) is refused the same way,
  // and so is one whose domain has no ASCII (IDNA) form (v3.3).
  const send = opts.send ? { ...opts.send, recipient: opts.send.recipient.normalize('NFC') } : undefined
  if (send && (hasLoneSurrogate(opts.send!.message) || hasLoneSurrogate(opts.send!.recipient))) return malformed(tier)
  if (send && (hasHiddenChar(send.recipient) || recipientAscii(send.recipient) === null)) return malformed(tier)
  const flags = send ? recipientFlags(send.recipient, {
    contacts: [...(opts.ledger?.knownRecipients() ?? []), ...(opts.contacts ?? [])], domains: opts.knownDomains ?? [],
  }) : []
  // v3.3 (Shield): no Auto rule covers a send to a flagged recipient (mixed_script, lookalike, non_ascii).
  if (tier === 'auto' && phoneOnlyRecipient(flags)) tier = 'ask'
  // Shield R7-4: a send is never Auto, whatever a manifest, a hint or a template rule says.
  if (tier === 'auto' && isSend) tier = 'ask'
  if (tier === 'auto') return { approved: true, channel: null, tier, reason: 'approved' }

  let suffix = ''
  let allowVoice = true
  if (opts.window && opts.agentId) {
    const w = opts.window.wouldExceed(opts.agentId, { amountMinor: opts.amountMinor, count: opts.count })
    allowVoice = w.voiceAllowed
    suffix = ` (running total today: ${w.total.count} actions, ${money(w.total.amountMinor)})`
  }
  const bound = opts.ledger
  if (bound && !opts.mic) allowVoice = false
  let isPaired = opts.isPaired
  if (bound) {
    const pairing = opts.pairing
    const legacy = opts.isPaired
    isPaired = (c) => !!pairing?.isPaired() && (!legacy || legacy(c))
  }
  // v3.3: phone-only also for a flagged recipient; the phone may take over a device Ask only when this
  // Ask's policy would also route it to the phone (early or timed handoff never upgrades a touch-only Ask).
  const channel = askChannelFor(tier, profile, opts.available, opts.amountMinor, { allowVoice, isPaired, phoneOnly: prod && phoneOnly(tier, opts.amountMinor, flags) })
  if (channel === null) {
    // Shield R7 ruling: a phone-only Ask whose only route is the phone, refused because no phone is paired, says
    // so (no_paired_phone); any other missing route stays no_channel.
    const noPhone = !!isPaired && phoneOnly(tier, opts.amountMinor, flags)
      && askChannelFor(tier, profile, opts.available, opts.amountMinor, { allowVoice, phoneOnly: true }) === 'phone'
    return { approved: false, channel: null, tier, reason: noPhone ? 'no_paired_phone' : 'no_channel' }
  }
  const phoneAllowed = channel === 'phone' || askChannelFor(tier, profile, opts.available, opts.amountMinor, { allowVoice, isPaired, phoneOnly: true }) === 'phone'

  const what = send ? `${action} to ${recipientDisplay(send.recipient, flags)}: "${firstLine(send.message)}"` : action
  const details = { ...opts.details, ...(send ? { recipient: send.recipient, messageSha256: createHash('sha256').update(send.message).digest('hex') } : {}) }
  const amount = opts.amountMinor !== undefined ? ` ${money(opts.amountMinor)}` : ''
  let prompt = `${tier.toUpperCase()}: ${what}${send ? amount : ''}${suffix}`

  let approved: boolean
  let reason: AskOutcomeReason
  let request: AskRequest | undefined
  if (bound) {
    let req: AskRequest
    try {
      req = bound.open({
        action, tier, channel, amountMinor: opts.amountMinor, details, agentId: opts.agentId, templateId: opts.templateId,
        ...(askKindFor(template, action, tier, opts.kind) ? { kind: askKindFor(template, action, tier, opts.kind)! } : {}),
        ...(send ? { recipient: send.recipient, firstLine: firstLine(send.message) } : {}),
        phoneAllowed, known: { contacts: opts.contacts ?? [], domains: opts.knownDomains ?? [] },
      })
    } catch (e) {
      if (e instanceof InvalidUnicode || e instanceof UnsafeRecipient) return malformed(tier)
      throw e
    }
    request = req
    if (req.challenge) prompt += `. Say "${req.challenge}" to approve.`
    const voice = channel === 'voice'
    const pairing = opts.pairing
    let ans: unknown
    let s: SettleResult
    let stateEnd: 'no_paired_phone' | null = null
    // DECISIONS ad47477: a short hold leaves the Ask open, so the person may hold again (until it expires).
    // The bound only stops a runaway answerer from pinning the daemon; the ledger itself counts nothing.
    for (let prompts = 0; ; ) {
      if (voice) opts.mic!.speaking(true)
      try {
        ans = await answerFn(channel, prompt, req)
      } finally {
        if (voice) opts.mic!.speaking(false)
      }
      const endedBy = bound.endedReason(req.id)
      if (endedBy !== null) { stateEnd = endedBy; s = { ok: false, reason: 'expired' }; break }
      s = bound.settle(ans as AskAnswer, { isPaired: pairing ? (id, pub) => (pub === undefined ? pairing.isPaired(id) : pairing.isPairedKey(id, pub)) : undefined, extra: opts.verifier, isShared: opts.isShared })
      // hold_too_short and stale_channel leave the Ask open: ask again on its (current) channel. R7-10:
      // unpaired_phone and no_authority leave it open too and are not counted (UNCOUNTED_REFUSALS).
      const step = nextStep(bound, req.id, ans, s, prompts)
      if (step === 'expired') { s = { ok: false, reason: 'expired' }; break }
      if (step === 'done') break
      if (step === 'again') prompts++
    }
    approved = stateEnd === null && s.ok && (ans as AskAnswer).approved === true
    reason = stateEnd ?? (s.ok ? (approved ? 'approved' : 'denied') : s.reason)
  } else {
    approved = (await answerFn(channel, prompt)) === true
    reason = approved ? 'approved' : 'denied'
  }
  if (approved && opts.window && opts.agentId) opts.window.record(opts.agentId, { amountMinor: opts.amountMinor, count: opts.count })
  // v3.3: an Ask handed off (timer or early) ended on the phone.
  const ended: AskChannel = bound && request && bound.handedOffFrom(request.id) !== null ? 'phone' : channel
  return bound ? { approved, channel: ended, tier, reason, request } : { approved, channel, tier, reason }
}

/**
 * PM Q52: the daemon's first-run practice Ask. kind 'practice', action PRACTICE_ACTION, tier ask; it carries
 * no action, tool, amount, recipient or detail (any of those refuses it: PracticeRefused), executes nothing and
 * never touches the approval window's totals. Short holds never close it (no hold_limit). Answered like any
 * Ask (same ledger, same channel rules), so the person learns the real gesture.
 */
export async function practiceAsk(
  answerFn: AnswerFn,
  opts: { ledger: AskLedger; pairing?: PhonePairing; available?: readonly string[] | null; profile?: ApprovalProfile | null; mic?: MicGuard; isShared?: SharedOriginLookup; agentId?: string } & Record<string, unknown>,
): Promise<AskOutcome & { practice: true }> {
  for (const k of ['action', 'tool', 'kind', 'amountMinor', 'currency', 'send', 'recipient', 'message', 'details', 'window', 'count', 'isSend', 'verifier']) {
    if (opts[k] !== undefined) throw new PracticeRefused(k)
  }
  if (!(opts.ledger instanceof AskLedger)) throw new ApprovalDenied('a practice Ask needs the ledger')
  const pairing = opts.pairing
  const channel = askChannelFor('ask', opts.profile, opts.available, undefined, { allowVoice: !!opts.mic, isPaired: () => !!pairing?.isPaired() })
  if (channel === null) return { approved: false, channel: null, tier: 'ask', reason: 'no_channel', practice: true }
  const req = opts.ledger.open({ action: PRACTICE_ACTION, tier: 'ask', channel, kind: 'practice', phoneAllowed: false, ...(opts.agentId ? { agentId: opts.agentId } : {}) })
  let prompt = `PRACTICE: hold to approve (nothing happens)`
  if (req.challenge) prompt += `. Say "${req.challenge}" to approve.`
  let ans: unknown
  let s: SettleResult
  for (let prompts = 0; ; ) {
    if (channel === 'voice') opts.mic!.speaking(true)
    try { ans = await answerFn(channel, prompt, req) } finally { if (channel === 'voice') opts.mic!.speaking(false) }
    const endedBy = opts.ledger.endedReason(req.id)
    if (endedBy !== null) return { approved: false, channel, tier: 'ask', reason: endedBy, request: req, practice: true }
    s = opts.ledger.settle(ans as AskAnswer, { isPaired: pairing ? (id, pub) => (pub === undefined ? pairing.isPaired(id) : pairing.isPairedKey(id, pub)) : undefined, isShared: opts.isShared })
    const step = nextStep(opts.ledger, req.id, ans, s, prompts)
    if (step === 'expired') { s = { ok: false, reason: 'expired' }; break }
    if (step === 'done') break
    if (step === 'again') prompts++
  }
  const approved = s.ok && (ans as AskAnswer).approved === true
  return { approved, channel, tier: 'ask', reason: s.ok ? (approved ? 'approved' : 'denied') : s.reason, request: req, practice: true }
}

// ---- Upstream #1340: phone Accept/Decline on MCP elicitations goes through the Ask gate ----

export interface McpElicitation {
  /** MCP server (connector) name. */
  server: string
  /** The elicitation's message as shown to the person. */
  message: string
  /** Tool that raised it, looked up in the manifest. Unknown means write. */
  tool?: string
}

/**
 * An MCP Accept is an approval: it never goes straight from the phone to the server. The daemon runs
 * it as an Ask (action `MCP <server>: <message>`, unlisted write so Ask) and only an approved, bound
 * answer becomes 'accept'. Anything else, including a gate error, is 'decline'.
 */
export async function answerMcpElicitation(
  template: ApprovalTemplate,
  el: McpElicitation,
  profile: ApprovalProfile | null | undefined,
  answerFn: AnswerFn,
  opts: Omit<AskOptions, 'reference' | 'kind' | 'isWrite'> & { manifest: readonly ToolManifestEntry[] | null | undefined },
): Promise<{ action: 'accept' | 'decline'; outcome?: AskOutcome; error?: string }> {
  const { manifest, ...rest } = opts
  try {
    const outcome = await ask(template, `MCP ${el.server}: ${el.message}`, profile, answerFn, {
      ...rest, kind: { manifest, tool: el.tool ?? '' }, isWrite: true,
    })
    return { action: outcome.approved && outcome.tier !== 'auto' ? 'accept' : 'decline', outcome }
  } catch (e) {
    return { action: 'decline', error: (e as Error).message }
  }
}

// ---- F13: upstream's phone elicitation handler cannot answer Ildra Ask panes directly ----

/** Prefix the daemon puts on an Ildra Ask shown in an agent pane, so every viewer can recognize it. */
export const ILDRA_ASK_MARKER = '[Ildra Ask '

export function ildraAskTitle(req: Pick<AskRequest, 'digest8'>, prompt: string): string {
  return `${ILDRA_ASK_MARKER}${req.digest8}] ${prompt}`
}

export function isIldraAskQuestion(question: string | null | undefined): boolean {
  return typeof question === 'string' && question.includes(ILDRA_ASK_MARKER)
}

/**
 * Which panes have an Ildra Ask open. While one is open, keystrokes from any remote viewer (phone,
 * web) to that pane are blocked: the Ask is answered only through the ledger (bound answer), never
 * by a key press on the pane's dialog. Local keyboard input on the device's own pane passes.
 */
export class AskPaneGuard {
  private readonly open_ = new Map<string, string>()

  open(paneId: string, requestId: string): void {
    this.open_.set(paneId, requestId)
  }

  close(paneId: string): void {
    this.open_.delete(paneId)
  }

  requestFor(paneId: string): string | null {
    return this.open_.get(paneId) ?? null
  }

  filterInput(paneId: string, from: 'local' | 'remote'): 'pass' | 'block' {
    return from === 'remote' && this.open_.has(paneId) ? 'block' : 'pass'
  }
}

/**
 * Replacement for upstream #1340's direct press. The phone asks the daemon; the daemon runs the
 * Accept as an Ask (answerMcpElicitation) and returns which button to press: '1' Accept only on an
 * approved bound answer, '2' Decline otherwise. An Ildra Ask pane is never pressed (key null): it is
 * answered through the ledger.
 */
export async function phoneElicitationPress(
  template: ApprovalTemplate,
  el: McpElicitation & { paneId: string },
  profile: ApprovalProfile | null | undefined,
  answerFn: AnswerFn,
  opts: Parameters<typeof answerMcpElicitation>[4] & { guard: AskPaneGuard },
): Promise<{ key: '1' | '2' | null; reason?: string }> {
  const { guard, ...rest } = opts
  if (guard.requestFor(el.paneId) !== null || isIldraAskQuestion(el.message)) return { key: null, reason: 'ildra_ask_pane' }
  const r = await answerMcpElicitation(template, el, profile, answerFn, rest)
  return r.action === 'accept' ? { key: '1' } : { key: '2', reason: r.error ?? r.outcome?.reason }
}
