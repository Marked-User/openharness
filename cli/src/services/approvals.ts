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

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path'

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

/** AskRequest.kind: display only, never in digest8, only on locked_ask; set by the daemon, never the caller. */
export type AskKind = 'safety_verification'

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
export function phoneOnly(tier: Tier, amountMinor?: number | null): boolean {
  return tier === 'locked_ask' || amountMinor != null
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
}

/** Manifest sources whose send:false is believed (R3-3). */
export const TRUSTED_MANIFEST_OWNERS: ReadonlySet<string> = new Set(['first_party', 'bridge'])
export type ManifestSource = 'first_party' | 'bridge' | 'third_party'

/**
 * Shield R3-3: copy a manifest with `owner` set from where the daemon loaded it. Any owner the manifest
 * claims for itself is overwritten, so a third-party (store) manifest cannot pose as bridge-owned. An
 * unknown source is stamped third_party.
 */
export function stampManifest(entries: readonly ToolManifestEntry[] | null | undefined, source: ManifestSource): ToolManifestEntry[] {
  const owner: ManifestSource = source === 'first_party' || source === 'bridge' ? source : 'third_party'
  return (entries ?? []).map((e) => ({ ...e, owner }))
}

/**
 * F8 + Shield pilot review (a): a tool can send unless the manifest lists it with literal `send: false`
 * from a first-party or bridge-owned entry (R3-3; see stampManifest).
 * Missing from the manifest, no manifest, or any other value means it gets the recipient and first-line
 * checks. The caller can tighten (isSend, send details), never loosen.
 */
export function isSendTool(manifest: readonly ToolManifestEntry[] | null | undefined, toolName: string): boolean {
  const e = manifest?.find((x) => x.name === toolName)
  if (!e || e.send !== false) return true
  return !(typeof e.owner === 'string' && TRUSTED_MANIFEST_OWNERS.has(e.owner))
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
 * and display-only fields are not covered (so a device-to-phone handoff keeps the digest).
 */
export function actionDigest8(action: string, fields: Record<string, unknown> = {}): string {
  if ('action' in fields) throw new ApprovalDenied('a digest field may not be named action')
  return createHash('sha256').update(canonicalJson({ ...fields, action }), 'utf8').digest('hex').slice(0, 8)
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
  /** Send Asks: first non-empty line of the message, trimmed, at most 80 chars. Display only. */
  firstLine?: string
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
export interface AskAttempt { id: string; answerId: string; channel: AskChannel; reason: 'hold_too_short' | 'stale_channel'; holdMs?: number; at: number }
/** Attempts kept per journal (oldest dropped first). */
export const MAX_ATTEMPTS = 200

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
  /** Asks moved by handoff: id to the channel they left (answers from it are stale_channel). */
  private readonly handedOff = new Map<string, AskChannel>()
  onChange?: () => void
  /** Called with each ildra.ask.attempt as it is recorded (the daemon forwards it to the phone). */
  onAttempt?: (a: AskAttempt) => void

  /** `ttlMs` overrides the decided expiry; tests only. */
  constructor(opts: { now?: () => number; ttlMs?: number; verifier?: AnswerVerifier } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs
    this.verifier = opts.verifier
  }

  open(o: {
    action: string; tier: Tier; channel: AskChannel; amountMinor?: number; details?: Record<string, unknown>
    agentId?: string; templateId?: string; recipient?: string; firstLine?: string; kind?: AskKind
  }): AskRequest {
    if (o.kind !== undefined && (o.kind !== 'safety_verification' || o.tier !== 'locked_ask')) throw new ApprovalDenied('AskRequest.kind is safety_verification on a locked_ask only')
    if (phoneOnly(o.tier, o.amountMinor) && o.channel !== 'phone') {
      throw new ApprovalDenied('locked_ask and money Asks are answered on the paired phone only')
    }
    for (const k of DIGEST_RESERVED) if (o.details && k in o.details) throw new ApprovalDenied(`a detail may not be named ${k}`)
    if (o.firstLine !== undefined && (typeof o.firstLine !== 'string' || o.firstLine === '')) throw new ApprovalDenied('a send Ask needs a non-empty first line')
    const openedAt = this.now()
    const currency = o.amountMinor !== undefined ? ('USD' as const) : undefined
    const req: AskRequest = {
      id: randomUUID(),
      digest8: actionDigest8(o.action, { ...o.details, agentId: o.agentId, tier: o.tier, amountMinor: o.amountMinor, currency }),
      action: o.action,
      ...(o.agentId !== undefined ? { agentId: o.agentId } : {}),
      ...(o.templateId !== undefined ? { templateId: o.templateId } : {}),
      ...(o.recipient !== undefined ? { recipient: o.recipient } : {}),
      ...(o.firstLine !== undefined ? { firstLine: o.firstLine } : {}),
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
    this.onChange?.()
    return req
  }

  private prune(): void {
    const t = this.now()
    for (const [id, r] of this.open_) if (t >= r.expiresAt) { this.open_.delete(id); this.spent.set(id, r.expiresAt) }
    for (const id of this.handedOff.keys()) if (!this.open_.has(id)) this.handedOff.delete(id)
    // Spent ids are kept until a further day past expiry so a late replay reads as replayed.
    for (const [id, at] of this.spent) if (at + OTHER_ASK_EXPIRY_MS < t) this.spent.delete(id)
    for (const [id, at] of this.spentAnswers) if (at + OTHER_ASK_EXPIRY_MS < t) this.spentAnswers.delete(id)
  }

  /** Recorded ildra.ask.attempt events, oldest first (copies). */
  attempts(): AskAttempt[] {
    return this.attempts_.map((a) => ({ ...a }))
  }

  pending(): number {
    this.prune()
    return this.open_.size
  }

  /**
   * DECISIONS (60 s device-to-phone handoff, protocol ildra.ask.handoff): move an open Ask to another channel.
   * Same id and digest8 (channel is not in the digest), expiresAt unchanged. Only touch to phone. Answers on
   * the old channel are rejected after it (a device answer carries no paired phone id). Null when the Ask is
   * not open, has expired, or the move is not touch to phone.
   */
  handoff(id: string, to: AskChannel): { id: string; from: AskChannel; to: AskChannel; at: number } | null {
    const req = this.open_.get(id)
    const at = this.now()
    if (!req || at >= req.expiresAt || req.channel !== 'touch' || to !== 'phone') return null
    this.open_.set(id, { ...req, channel: to })
    this.handedOff.set(id, req.channel)
    this.onChange?.()
    return { id, from: req.channel, to, at }
  }

  /** `isPaired` is consulted for phone answers; `extra` runs after the ledger's own verifier. */
  settle(ans: AskAnswer, ctx: SettleContext = {}): SettleResult {
    const r = this.check(ans, ctx)
    this.onChange?.()
    return r
  }

  private attempt(req: AskRequest, ans: AskAnswer, channel: AskChannel, reason: AskAttempt['reason']): SettleResult {
    const h = ans.holdMs
    const a: AskAttempt = {
      id: req.id, answerId: ans.answerId, channel, reason,
      ...(typeof h === 'number' && Number.isFinite(h) && h >= 0 ? { holdMs: h } : {}), at: this.now(),
    }
    this.attempts_.push(a)
    if (this.attempts_.length > MAX_ATTEMPTS) this.attempts_ = this.attempts_.slice(-MAX_ATTEMPTS)
    try { this.onAttempt?.({ ...a }) } catch { /* a listener never changes the result */ }
    return { ok: false, reason }
  }

  private check(ans: AskAnswer, ctx: SettleContext): SettleResult {
    if (!ans || typeof ans !== 'object' || typeof ans.id !== 'string' || typeof ans.digest8 !== 'string'
      || typeof ans.answerId !== 'string' || !ANSWER_ID.test(ans.answerId)) return { ok: false, reason: 'malformed' }
    const answerSeen = this.spentAnswers.has(ans.answerId)
    const req = this.open_.get(ans.id)
    this.spentAnswers.set(ans.answerId, Math.max(this.now(), req?.expiresAt ?? 0))
    if (!req) {
      this.prune()
      return { ok: false, reason: answerSeen || this.spent.has(ans.id) ? 'replayed' : 'unknown_id' }
    }
    const spend = (reason: SettleReason): SettleResult => {
      this.open_.delete(ans.id)
      this.handedOff.delete(ans.id)
      this.spent.set(ans.id, req.expiresAt)
      return { ok: false, reason }
    }
    // v3.1 (decided order): after a handoff, any answer (approve or deny, even with a reused answerId) from the
    // channel the Ask left is stale_channel, checked before replayed: logged as an attempt, never approves, and
    // the Ask stays open for its current channel. Replayed still spends the Ask on the current channel.
    const left = this.handedOff.get(req.id)
    if (left !== undefined && this.now() < req.expiresAt && answerChannel(ans, ctx) === left) return this.attempt(req, ans, left, 'stale_channel')
    if (answerSeen) return spend('replayed')
    if (this.now() >= req.expiresAt) return spend('expired')
    if (ans.digest8 !== req.digest8) return spend('digest_mismatch')
    if (originShared(ans.from, ctx.isShared)) return spend('shared_machine')
    if (req.channel === 'phone') {
      const id = ans.from?.phoneId
      if (typeof id !== 'string' || !ctx.isPaired || !ctx.isPaired(id)) return spend('unpaired_phone')
    }
    if (req.channel === 'touch' && ans.approved === true) {
      const h = ans.holdMs
      // DECISIONS ad47477: a short hold leaves the Ask open for a proper one; its answerId is spent.
      if (typeof h !== 'number' || !Number.isFinite(h) || h < DEVICE_HOLD_MIN_MS) return this.attempt(req, ans, req.channel, 'hold_too_short')
    }
    this.open_.delete(ans.id)
    this.handedOff.delete(ans.id)
    this.spent.set(ans.id, req.expiresAt)
    if (req.challenge && ans.approved === true && !transcriptMatches(req.challenge, ans.transcript)) return { ok: false, reason: 'challenge_mismatch' }
    for (const v of [this.verifier, ctx.extra]) {
      if (!v) continue
      let ok = false
      try { ok = v(req, ans) === true } catch { ok = false }
      if (!ok) return { ok: false, reason: 'verifier_rejected' }
    }
    return { ok: true }
  }

  toJSON(): { open: AskRequest[]; spent: [string, number][]; spentAnswers: [string, number][]; attempts: AskAttempt[]; handoffs: [string, AskChannel][] } {
    this.prune()
    return {
      open: [...this.open_.values()].map((r) => ({ ...r })), spent: [...this.spent], spentAnswers: [...this.spentAnswers],
      attempts: this.attempts(), handoffs: [...this.handedOff],
    }
  }

  /** @internal journal restore. */
  restore(data: { open: AskRequest[]; spent: [string, number][]; spentAnswers?: [string, number][]; attempts?: AskAttempt[]; handoffs?: [string, AskChannel][] }): void {
    for (const [id, at] of data.spentAnswers ?? []) this.spentAnswers.set(id, at)
    this.attempts_ = (data.attempts ?? []).filter((a) => a && typeof a.id === 'string' && (a.reason === 'hold_too_short' || a.reason === 'stale_channel'))
      .slice(-MAX_ATTEMPTS).map((a) => ({ ...a }))
    for (const r of data.open) {
      // Pilot review A1: a locked_ask or money Ask opened on the device or voice before the phone-only rule
      // is denied on restore (spent), never answerable.
      if (phoneOnly(r.tier, r.amountMinor) && r.channel !== 'phone') this.spent.set(r.id, r.expiresAt)
      else this.open_.set(r.id, { ...r })
    }
    for (const [id, at] of data.spent) this.spent.set(id, at)
    for (const [id, from] of data.handoffs ?? []) if (this.open_.has(id) && KNOWN_CHANNELS.has(from)) this.handedOff.set(id, from)
  }
}

export interface SettleContext {
  isPaired?: (phoneId: string) => boolean
  extra?: AnswerVerifier
  isShared?: SharedOriginLookup
  /** The channel the answer arrived on, when the caller knows it (the device bridge says touch). */
  via?: AskChannel
}

/** The channel an answer came from: ctx.via, else a paired-phone id means phone, a transcript voice, else touch. */
function answerChannel(ans: AskAnswer, ctx: SettleContext): AskChannel {
  if (ctx.via) return ctx.via
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

type PendingPair = { phonePub: string; check: string; expiresAt: number }

/**
 * Phone pairing (F6). Three steps, all on the device's terms:
 * 1. begin('touch') on the device: code + deviceNonce. Never by voice, phone or a shared machine.
 * 2. offer(phoneId, phonePub, code) when the phone submits the code: spends the code, returns the
 *    6-digit check string the device shows (the phone computes the same with pairingCheck).
 * 3. confirm(phoneId, 'touch', matched) on the device: the user taps that both strings match.
 *    Only then is the phone paired. A mismatch, any channel but touch, or expiry refuses it.
 */
export class PhonePairing {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly codes = new Map<string, { expiresAt: number; deviceNonce: string }>()
  private readonly pendingPairs = new Map<string, PendingPair>()
  private readonly phones = new Set<string>()
  private readonly lastRefusal = new Map<string, string>()
  /** Ledger of every pairing, unpairing and refused attempt. */
  readonly log: PairingLogEntry[] = []
  onChange?: () => void

  /** F6: wrong codes allowed before every open code is burned and a new device touch is needed. */
  static readonly MAX_WRONG_CODES = 5
  private wrongCodes = 0
  private readonly isShared?: SharedOriginLookup

  constructor(opts: { now?: () => number; ttlMs?: number; isShared?: SharedOriginLookup } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? 5 * 60_000
    this.isShared = opts.isShared
  }

  /** True after too many wrong codes, until the next begin('touch'). */
  get lockedOut(): boolean {
    return this.wrongCodes >= PhonePairing.MAX_WRONG_CODES
  }

  private refuse(phoneId: string, reason: string): false {
    this.log.push({ at: this.now(), event: 'refused', phoneId, reason })
    if (phoneId) this.lastRefusal.set(phoneId, reason)
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
    const check = pairingCheck(code, phonePub, c.deviceNonce)
    this.pendingPairs.set(phoneId, { phonePub, check, expiresAt: c.expiresAt })
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
    this.phones.add(phoneId)
    this.lastRefusal.delete(phoneId)
    this.log.push({ at: this.now(), event: 'pair', phoneId })
    this.onChange?.()
    return true
  }

  unpair(phoneId: string): void {
    if (this.phones.delete(phoneId)) this.log.push({ at: this.now(), event: 'unpair', phoneId })
    this.onChange?.()
  }

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

  toJSON(): { phones: string[]; log: PairingLogEntry[]; refused: Record<string, string> } {
    return { phones: [...this.phones], log: this.log.map((e) => ({ ...e })), refused: Object.fromEntries(this.lastRefusal) }
  }

  /** @internal */
  restore(data: { phones: string[]; log?: PairingLogEntry[]; refused?: Record<string, string> }): void {
    for (const p of data.phones) this.phones.add(p)
    for (const [id, why] of Object.entries(data.refused ?? {})) this.lastRefusal.set(id, why)
    for (const e of data.log ?? []) this.log.push({ ...e })
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
  const points = Array.from(line.trim())
  return points.length > 80 ? `${points.slice(0, 79).join('')}…` : points.join('')
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
    const text = req.recipient !== undefined ? `${req.action}\nTo ${req.recipient}: ${req.firstLine ?? ''}` : req.action
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
    && ['agentId', 'templateId', 'recipient', 'firstLine'].every((k) => (x as unknown as Record<string, unknown>)[k] === undefined || typeof (x as unknown as Record<string, unknown>)[k] === 'string')
    && (x.kind === undefined || (x.kind === 'safety_verification' && x.tier === 'locked_ask'))
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
  return { window: w, ledger: l, pairing: p }
}

export interface ApprovalJournal {
  window: ApprovalWindow
  ledger: AskLedger
  pairing: PhonePairing
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
    /**
     * F5: install marker, written once. Marker present and journal missing fails closed. Defaults to
     * defaultMarkerPath(path). A marker in the journal's folder, or below it, is refused (Shield pilot review).
     */
    markerPath?: string
  } = {},
): ApprovalJournal {
  const now = opts.now ?? Date.now
  const window = new ApprovalWindow({ now, windowMs: opts.windowMs, voiceMoneyLimitMinor: opts.voiceMoneyLimitMinor, bulkCount: opts.bulkCount })
  const ledger = new AskLedger({ now, ttlMs: opts.ttlMs, verifier: opts.verifier })
  const pairing = new PhonePairing({ now })
  let recovered = false
  const marker = resolvePath(opts.markerPath ?? defaultMarkerPath(path))
  if (foldersOverlap(dirname(marker), dirname(resolvePath(path)))) {
    throw new ApprovalDenied('the install marker must not be in the journal\'s folder (or link into it): deleting that folder would delete both')
  }
  if (!existsSync(path) && existsSync(marker)) {
    // The journal was deleted after install: totals cannot be trusted.
    recovered = true
    window.lockedUntil = now() + window.windowMs
  } else if (existsSync(path)) {
    try {
      const d = parseJournal(readFileSync(path, 'utf8'))
      window.restore(d.window)
      ledger.restore(d.ledger)
      pairing.restore(d.pairing)
    } catch {
      recovered = true
      window.lockedUntil = now() + window.windowMs
    }
  }
  const save = () => {
    const body = JSON.stringify({ v: JOURNAL_VERSION, window: window.toJSON(), ledger: ledger.toJSON(), pairing: pairing.toJSON() })
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, path)
  }
  window.onChange = save
  ledger.onChange = save
  pairing.onChange = save
  save()
  if (!existsSync(marker)) {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, `${now()}\n`, { mode: 0o600 })
  }
  return { window, ledger, pairing, recovered, save }
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
}

/**
 * Why an Ask ended: `approved` (only when approved is true); `denied` a person said no; `no_channel` no usable
 * channel (nothing was asked); `never` the template forbids it; otherwise the rejection reason of the answer
 * (expired among them). Wire: AskOutcomeReason.
 */
export type AskOutcomeReason = 'approved' | 'denied' | 'no_channel' | 'never' | SettleReason
/** PM spec (v3): reason is always present; 'approved' exactly when approved is true. */
export type AskOutcome = AskResult & { reason: AskOutcomeReason; request?: AskRequest }

/** The `never` outcome for a wire consumer (ask() itself throws ApprovalDenied so the agent is told). */
/** ask(): re-prompts after hold_too_short before it gives up on a runaway answerer (the Ask stays open). */
export const MAX_REPROMPTS = 100

export function neverOutcome(): AskOutcome { return { approved: false, channel: null, tier: 'never', reason: 'never' } }

/**
 * AskRequest.kind from the daemon's own inputs only: the template's safety_verification list, or the called
 * tool's manifest entry with safetyVerification: true from a trusted owner (R3-3). Only for locked_ask.
 */
export function askKindFor(
  template: ApprovalTemplate, action: string, tier: Tier, kind?: { manifest: readonly ToolManifestEntry[] | null | undefined; tool: string },
): AskKind | undefined {
  if (tier !== 'locked_ask') return undefined
  if (Array.isArray(template.safety_verification) && template.safety_verification.includes(action)) return 'safety_verification'
  const e = kind?.manifest?.find((m) => m.name === kind.tool)
  if (e && e.safetyVerification === true && typeof e.owner === 'string' && TRUSTED_MANIFEST_OWNERS.has(e.owner)) return 'safety_verification'
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
  const malformed = (t: Tier): AskOutcome => ({ approved: false, channel: null, tier: t, reason: 'malformed' })
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
  const tier = resolve(template, action, profile, isWrite)
  if (tier === 'never') throw new ApprovalDenied(`never item: ${action}`)
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
  const channel = askChannelFor(tier, profile, opts.available, opts.amountMinor, { allowVoice, isPaired, phoneOnly: prod && phoneOnly(tier, opts.amountMinor) })
  if (channel === null) return { approved: false, channel: null, tier, reason: 'no_channel' }

  const send = opts.send
  // v3: a lone surrogate in the message (hashed as messageSha256) or any digest input refuses the Ask.
  if (send && (hasLoneSurrogate(send.message) || hasLoneSurrogate(send.recipient))) return malformed(tier)
  const what = send ? `${action} to ${send.recipient}: "${firstLine(send.message)}"` : action
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
      })
    } catch (e) {
      if (e instanceof InvalidUnicode) return malformed(tier)
      throw e
    }
    request = req
    if (req.challenge) prompt += `. Say "${req.challenge}" to approve.`
    const voice = channel === 'voice'
    const pairing = opts.pairing
    let ans: unknown
    let s: SettleResult
    // DECISIONS ad47477: a short hold leaves the Ask open, so the person may hold again (until it expires).
    // The bound only stops a runaway answerer from pinning the daemon; the ledger itself counts nothing.
    for (let prompts = 0; ; prompts++) {
      if (voice) opts.mic!.speaking(true)
      try {
        ans = await answerFn(channel, prompt, req)
      } finally {
        if (voice) opts.mic!.speaking(false)
      }
      s = bound.settle(ans as AskAnswer, { isPaired: pairing ? (id) => pairing.isPaired(id) : undefined, extra: opts.verifier, isShared: opts.isShared })
      // hold_too_short and stale_channel leave the Ask open: ask again on its (current) channel.
      if (s.ok || (s.reason !== 'hold_too_short' && s.reason !== 'stale_channel') || prompts >= MAX_REPROMPTS) break
    }
    approved = s.ok && (ans as AskAnswer).approved === true
    reason = s.ok ? (approved ? 'approved' : 'denied') : s.reason
  } else {
    approved = (await answerFn(channel, prompt)) === true
    reason = approved ? 'approved' : 'denied'
  }
  if (approved && opts.window && opts.agentId) opts.window.record(opts.agentId, { amountMinor: opts.amountMinor, count: opts.count })
  return bound ? { approved, channel, tier, reason, request } : { approved, channel, tier, reason }
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
