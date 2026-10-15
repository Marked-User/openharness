/**
 * Ildra approval gates: Auto / Ask / locked_ask / Never, resolved from an agent template's permission
 * lists and the user's preference profile. Port of the Ildra reference (eng/reference/ildra_ref/
 * permissions.py) plus Shield's findings F1, F3, F4 and F5. Golden parity: approvals.golden.json is
 * generated from the reference by eng/reference/make_golden.py.
 *
 * Pure policy only. Wiring into the core (CoreApi, ports, bridge tools/call hold and release, ledger)
 * is a separate reviewed change (SCOPE P1).
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

import { createHash, randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

/** First 8 hex of sha256 over the exact action and its details (amount, recipient, message hash). */
export function actionDigest8(action: string, details: Record<string, unknown> = {}): string {
  return createHash('sha256').update(canonical({ action, details })).digest('hex').slice(0, 8)
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
  /** First 8 hex of sha256 over the exact action and its details. */
  digest8: string
  /** Epoch ms when the Ask opened. */
  openedAt: number
  /** Epoch ms; an answer at or after this is rejected. openedAt + 1 h with an amount, else + 24 h. */
  expiresAt: number
  channel: AskChannel
  tier: Tier
  /** Amount in minor units (cents), integer; present means this is a money Ask. */
  amountMinor?: number
  /** Daemon-drawn 2-word spoken challenge, voice Asks only. */
  challenge?: string
}

/** Where an answer came from (gateway trust). Shared-account machines (#1358) never answer. */
export interface AnswerOrigin {
  /** Paired phone id, required when channel is phone. */
  phoneId?: string
  /** True when the answering machine or phone is trusted only through machine sharing. */
  shared?: boolean
}

export interface AskAnswer {
  id: string
  digest8: string
  /** Only literal true approves. */
  approved: boolean
  transcript?: string
  from?: AnswerOrigin
  /** D5 (b) hook for Volt: signature over (id, digest, counter). Checked by an AnswerVerifier, not here. */
  signature?: string
}

/** Extra check after the built-in ones, e.g. D5 (b) signed answers (Volt). Must return literal true. */
export type AnswerVerifier = (req: AskRequest, ans: AskAnswer) => boolean

export type SettleReason =
  | 'malformed' | 'unknown_id' | 'replayed' | 'expired' | 'digest_mismatch' | 'challenge_mismatch'
  | 'verifier_rejected' | 'shared_machine' | 'unpaired_phone'
export type SettleResult = { ok: true } | { ok: false; reason: SettleReason }

/** Open Asks and spent ids. Every answer is settled at most once; a bad answer also spends the request. */
export class AskLedger {
  private readonly now: () => number
  private readonly ttlMs?: number
  private readonly verifier?: AnswerVerifier
  private readonly open_ = new Map<string, AskRequest>()
  private readonly spent = new Map<string, number>()
  onChange?: () => void

  /** `ttlMs` overrides the decided expiry; tests only. */
  constructor(opts: { now?: () => number; ttlMs?: number; verifier?: AnswerVerifier } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs
    this.verifier = opts.verifier
  }

  open(o: { action: string; tier: Tier; channel: AskChannel; amountMinor?: number; details?: Record<string, unknown> }): AskRequest {
    const openedAt = this.now()
    const req: AskRequest = {
      id: randomUUID(),
      digest8: actionDigest8(o.action, { ...o.details, amountMinor: o.amountMinor }),
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
    // Spent ids are kept until a further day past expiry so a late replay reads as replayed.
    for (const [id, at] of this.spent) if (at + OTHER_ASK_EXPIRY_MS < t) this.spent.delete(id)
  }

  pending(): number {
    this.prune()
    return this.open_.size
  }

  /** `isPaired` is consulted for phone answers; `extra` runs after the ledger's own verifier. */
  settle(ans: AskAnswer, ctx: { isPaired?: (phoneId: string) => boolean; extra?: AnswerVerifier } = {}): SettleResult {
    const r = this.check(ans, ctx)
    this.onChange?.()
    return r
  }

  private check(ans: AskAnswer, ctx: { isPaired?: (phoneId: string) => boolean; extra?: AnswerVerifier }): SettleResult {
    if (!ans || typeof ans !== 'object' || typeof ans.id !== 'string' || typeof ans.digest8 !== 'string') return { ok: false, reason: 'malformed' }
    const req = this.open_.get(ans.id)
    if (!req) {
      this.prune()
      return { ok: false, reason: this.spent.has(ans.id) ? 'replayed' : 'unknown_id' }
    }
    this.open_.delete(ans.id)
    this.spent.set(ans.id, req.expiresAt)
    if (this.now() >= req.expiresAt) return { ok: false, reason: 'expired' }
    if (ans.digest8 !== req.digest8) return { ok: false, reason: 'digest_mismatch' }
    if (ans.from?.shared === true) return { ok: false, reason: 'shared_machine' }
    if (req.channel === 'phone') {
      const id = ans.from?.phoneId
      if (typeof id !== 'string' || !ctx.isPaired || !ctx.isPaired(id)) return { ok: false, reason: 'unpaired_phone' }
    }
    if (req.challenge && ans.approved === true && !transcriptMatches(req.challenge, ans.transcript)) return { ok: false, reason: 'challenge_mismatch' }
    for (const v of [this.verifier, ctx.extra]) {
      if (!v) continue
      let ok = false
      try { ok = v(req, ans) === true } catch { ok = false }
      if (!ok) return { ok: false, reason: 'verifier_rejected' }
    }
    return { ok: true }
  }

  toJSON(): { open: AskRequest[]; spent: [string, number][] } {
    this.prune()
    return { open: [...this.open_.values()].map((r) => ({ ...r })), spent: [...this.spent] }
  }

  /** @internal journal restore. */
  restore(data: { open: AskRequest[]; spent: [string, number][] }): void {
    for (const r of data.open) this.open_.set(r.id, { ...r })
    for (const [id, at] of data.spent) this.spent.set(id, at)
  }
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

export class PhonePairing {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly codes = new Map<string, number>()
  private readonly phones = new Set<string>()
  /** Ledger of every pairing, unpairing and refused attempt. */
  readonly log: PairingLogEntry[] = []
  onChange?: () => void

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? 5 * 60_000
  }

  /**
   * Start pairing. Pairing is itself locked_ask: it needs a touch on the device, never voice or phone,
   * and never from a machine trusted only through sharing (#1358). Returns a 6-digit single-use code.
   */
  begin(confirmedBy: AskChannel, origin: { shared?: boolean } = {}): { code: string; expiresAt: number } {
    if (origin.shared === true) throw new ApprovalDenied('a shared machine cannot start pairing')
    if (confirmedBy !== 'touch') throw new ApprovalDenied('phone pairing needs a touch on the device')
    const code = String(randomInt(1_000_000)).padStart(6, '0')
    const expiresAt = this.now() + this.ttlMs
    this.codes.set(code, expiresAt)
    this.onChange?.()
    return { code, expiresAt }
  }

  /** Redeem a code for a phone. Single use; expired or unknown codes, and shared phones, fail. */
  complete(phoneId: string, code: string, origin: { shared?: boolean } = {}): boolean {
    const exp = this.codes.get(code)
    const refuse = (reason: string) => {
      this.log.push({ at: this.now(), event: 'refused', phoneId, reason })
      this.onChange?.()
      return false
    }
    if (exp === undefined) return refuse('unknown_code')
    this.codes.delete(code)
    if (origin.shared === true) return refuse('shared_machine')
    if (this.now() >= exp) return refuse('expired')
    if (!phoneId) return refuse('no_phone_id')
    this.phones.add(phoneId)
    this.log.push({ at: this.now(), event: 'pair', phoneId })
    this.onChange?.()
    return true
  }

  unpair(phoneId: string): void {
    if (this.phones.delete(phoneId)) this.log.push({ at: this.now(), event: 'unpair', phoneId })
    this.onChange?.()
  }

  isPaired(phoneId?: string): boolean {
    return phoneId === undefined ? this.phones.size > 0 : this.phones.has(phoneId)
  }

  toJSON(): { phones: string[]; log: PairingLogEntry[] } {
    return { phones: [...this.phones], log: this.log.map((e) => ({ ...e })) }
  }

  /** @internal */
  restore(data: { phones: string[]; log?: PairingLogEntry[] }): void {
    for (const p of data.phones) this.phones.add(p)
    for (const e of data.log ?? []) this.log.push({ ...e })
  }
}

// ---- F8: a send Ask shows the recipient and the first line ----

export interface SendDetails {
  recipient: string
  message: string
}

function firstLine(message: string): string {
  const line = message.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed
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
  const p = d.pairing
  if (!p || !Array.isArray(p.phones) || !p.phones.every((x: unknown) => typeof x === 'string')) throw new Error('bad pairing')
  if (p.log !== undefined && (!Array.isArray(p.log) || !p.log.every(isLog))) throw new Error('bad pairing log')
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

/**
 * Open (or create) the 0600 journal at `path`. Every change to the window, ledger or pairing is written
 * through atomically. A corrupt or tampered file fails closed: totals cannot be trusted, so voice is
 * off for every agent for one full window, pending Asks are dropped (denied) and no phone is paired.
 */
export function openJournal(
  path: string,
  opts: { now?: () => number; windowMs?: number; ttlMs?: number; verifier?: AnswerVerifier; voiceMoneyLimitMinor?: number; bulkCount?: number } = {},
): ApprovalJournal {
  const now = opts.now ?? Date.now
  const window = new ApprovalWindow({ now, windowMs: opts.windowMs, voiceMoneyLimitMinor: opts.voiceMoneyLimitMinor, bulkCount: opts.bulkCount })
  const ledger = new AskLedger({ now, ttlMs: opts.ttlMs, verifier: opts.verifier })
  const pairing = new PhonePairing({ now })
  let recovered = false
  if (existsSync(path)) {
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
  /** The agent's own approval mode. 'auto' never loosens a template's Ask or locked_ask. */
  agentMode?: 'auto' | 'ask' | string
}

export type AskOutcome = AskResult & { reason?: SettleReason; request?: AskRequest }

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
  if (opts.isSend && !(opts.send && typeof opts.send.recipient === 'string' && opts.send.recipient.trim() && typeof opts.send.message === 'string')) {
    throw new ApprovalDenied('a send Ask needs the recipient and the message')
  }
  if (prod) {
    if (!opts.ledger) throw new ApprovalDenied('production Asks need a ledger (F2)')
    if (!opts.kind) throw new ApprovalDenied('production Asks need the tool manifest (F4)')
    const money = opts.amountMinor !== undefined || opts.isSend === true || opts.send !== undefined
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
  if (tier === 'auto') return { approved: true, channel: null, tier }

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
  const channel = askChannelFor(tier, profile, opts.available, opts.amountMinor, { allowVoice, isPaired })
  if (channel === null) return { approved: false, channel: null, tier }

  const send = opts.send
  const what = send ? `${action} to ${send.recipient}: "${firstLine(send.message)}"` : action
  const details = { ...opts.details, ...(send ? { recipient: send.recipient, messageSha256: createHash('sha256').update(send.message).digest('hex') } : {}) }
  const amount = opts.amountMinor !== undefined ? ` ${money(opts.amountMinor)}` : ''
  let prompt = `${tier.toUpperCase()}: ${what}${send ? amount : ''}${suffix}`

  let approved: boolean
  let reason: SettleReason | undefined
  let request: AskRequest | undefined
  if (bound) {
    const req = bound.open({ action, tier, channel, amountMinor: opts.amountMinor, details })
    request = req
    if (req.challenge) prompt += `. Say "${req.challenge}" to approve.`
    const voice = channel === 'voice'
    if (voice) opts.mic!.speaking(true)
    let ans: unknown
    try {
      ans = await answerFn(channel, prompt, req)
    } finally {
      if (voice) opts.mic!.speaking(false)
    }
    const pairing = opts.pairing
    const s = bound.settle(ans as AskAnswer, { isPaired: pairing ? (id) => pairing.isPaired(id) : undefined, extra: opts.verifier })
    approved = s.ok && (ans as AskAnswer).approved === true
    reason = s.ok ? undefined : s.reason
  } else {
    approved = (await answerFn(channel, prompt)) === true
  }
  if (approved && opts.window && opts.agentId) opts.window.record(opts.agentId, { amountMinor: opts.amountMinor, count: opts.count })
  return bound ? { approved, channel, tier, reason, request } : { approved, channel, tier }
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
