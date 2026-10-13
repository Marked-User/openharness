import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PRODUCT_USAGE_DAYS, PRODUCT_USAGE_MAX_COUNT, PRODUCT_USAGE_METRICS,
  type ProductUsageChoice, type ProductUsageMetric, type ProductUsageReport } from '../lib/productUsageContract.js'

const DAY = 86_400_000
const key = (now: number) => new Date(now).toISOString().slice(0, 10)
const week = (now: number) => { const d = new Date(now); return key(now - ((d.getUTCDay() + 6) % 7) * DAY) }
type Counters = Partial<Record<ProductUsageMetric, number>>
interface State {
  revision: number
  activeDay: string | null
  workDay: string | null
  workWeek: string | null
  workedBefore: boolean
  days: Record<string, Counters>
  pending: ProductUsageReport | null
}
const fresh = (revision: number): State => ({ revision, activeDay: null, workDay: null, workWeek: null,
  workedBefore: false, days: {}, pending: null })
export interface ProductUsageDeps {
  file: string
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  now?(): number
  uuid?(): string
}

/** A reporting component of the gateway service; the core never waits for it.
 * Counts lifecycle facts only. No transcript, prompt, response, tool or error object enters this API.
 * Agent identifiers live only in the bounded in-memory duration map and never reach disk or HTTP.
 */
export function createProductUsage(deps: ProductUsageDeps) {
  const now = deps.now ?? Date.now, uuid = deps.uuid ?? randomUUID
  let state = fresh(-1), enabled = false, stopped = false, active = false
  let syncing: Promise<void> | null = null, persistTimer: ReturnType<typeof setTimeout> | undefined
  const running = new Map<string, number>()
  try {
    if (statSync(deps.file).size > 64 * 1024) throw new Error('Usage queue exceeds its bound')
    // Reconstruct every field; even a corrupted local file cannot introduce a new upload property.
    const saved = JSON.parse(readFileSync(deps.file, 'utf8')) as State
    if (Number.isSafeInteger(saved.revision) && saved.revision >= 0) {
      state = fresh(saved.revision)
      for (const field of ['activeDay', 'workDay', 'workWeek'] as const) {
        if (typeof saved[field] === 'string' && validDay(saved[field]!)) state[field] = saved[field]
      }
      state.workedBefore = saved.workedBefore === true
      for (const [day, counters] of Object.entries(saved.days ?? {})) if (validDay(day)) state.days[day] = clean(counters)
      const pending = saved.pending
      if (pending && pending.schemaVersion === 1 && pending.revision === state.revision && validDay(pending.day)
          && typeof pending.id === 'string' && /^[a-f0-9-]{36}$/.test(pending.id)) {
        state.pending = { schemaVersion: 1, revision: state.revision, id: pending.id, day: pending.day, counters: clean(pending.counters) }
      }
    }
  } catch { /* Missing or unreadable telemetry must not affect a session. */ }

  function validDay(day: string): boolean {
    const stamp = Date.parse(day + 'T00:00:00.000Z'), today = Math.floor(now() / DAY) * DAY
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(stamp) && key(stamp) === day
      && stamp <= today && stamp > today - PRODUCT_USAGE_DAYS * DAY
  }
  function clean(input: Counters): Counters {
    const result: Counters = {}
    for (const metric of PRODUCT_USAGE_METRICS) {
      const value = input?.[metric]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= PRODUCT_USAGE_MAX_COUNT) result[metric] = value
    }
    return result
  }
  function persist(): boolean {
    clearTimeout(persistTimer); persistTimer = undefined
    for (const field of ['activeDay', 'workDay', 'workWeek'] as const) if (state[field] && !validDay(state[field]!)) state[field] = null
    for (const day of Object.keys(state.days)) if (!validDay(day)) delete state.days[day]
    if (state.pending && !validDay(state.pending.day)) state.pending = null
    try {
      mkdirSync(dirname(deps.file), { recursive: true, mode: 0o700 })
      writeFileSync(deps.file + '.tmp', JSON.stringify(state), { mode: 0o600 })
      renameSync(deps.file + '.tmp', deps.file)
      return true
    } catch { enabled = false; return false }
  }
  function dirty(): void {
    if (!persistTimer) { persistTimer = setTimeout(persist, 1000); persistTimer.unref() }
  }
  function add(metric: ProductUsageMetric): void {
    const counters = state.days[key(now())] ??= {}
    counters[metric] = Math.min(PRODUCT_USAGE_MAX_COUNT, (counters[metric] ?? 0) + 1)
    dirty()
  }
  function markActive(): void {
    if (!enabled || stopped) return
    if (state.activeDay !== key(now())) { state.activeDay = key(now()); add('active_installation_days') }
  }
  function choice(value: ProductUsageChoice): void {
    if (state.revision !== value.revision || !value.enabled) {
      state = fresh(value.revision); running.clear()
      enabled = false
      if (!persist()) return
    }
    enabled = value.enabled && !stopped
  }
  async function syncOnce(): Promise<void> {
    try {
      const response = await deps.request('GET', '/api/product-usage/settings')
      if (stopped) return
      const body = response.body.data as ProductUsageChoice | undefined
      if (response.status !== 200 || typeof body?.enabled !== 'boolean'
          || !Number.isSafeInteger(body.revision) || body.revision < 0) { enabled = false; running.clear(); return }
      choice(body)
      if (!enabled) return
      if (active) markActive()
      if (!state.pending) {
        const day = Object.keys(state.days).sort().find(d => validDay(d) && Object.keys(state.days[d]).length)
        if (!day) return
        state.pending = { schemaVersion: 1, revision: state.revision, id: uuid(), day, counters: state.days[day] }
        delete state.days[day]
      }
      // Persist the immutable receipt before sending. A crash or ambiguous response retries that id.
      if (!persist()) return
      const report = state.pending
      if (!report) return
      const answer = await deps.request('POST', '/api/product-usage/report', report)
      if (stopped) return
      const result = answer.body.data as { accepted?: boolean; reason?: string } | undefined
      if (answer.status === 200 && result?.accepted === true) { state.pending = null; persist() }
      else if (result?.reason === 'CHOICE_CHANGED') { enabled = false; state = fresh(-1); running.clear(); persist() }
      else if (result?.reason === 'EXPIRED') { state.pending = null; persist() }
    } catch { enabled = false; running.clear() /* No error text or request body in logs. */ }
  }
  const sync = (): Promise<void> => syncing ??= syncOnce().finally(() => { syncing = null })
  const timer = setInterval(() => { void sync() }, 60_000)
  timer.unref()

  return {
    sync,
    presence(value: boolean): void { active = value; if (value) markActive() },
    opened(surface: 'desktop' | 'tui'): void {
      if (!enabled || stopped) return
      markActive(); add(surface === 'desktop' ? 'desktop_opens' : 'tui_opens')
    },
    observe(type: 'turn_started' | 'turn_ended', agent: string, replay: boolean, interrupted = false): void {
      if (!enabled || stopped || replay || !agent || agent.length > 256) return
      if (type === 'turn_started') {
        if (running.has(agent) || running.size >= 1000) return
        running.set(agent, now()); markActive(); add('turns_started')
        if (state.workDay !== key(now())) {
          add('working_installation_days')
          add(state.workedBefore ? 'repeat_work_installation_days' : 'first_work_installations')
          state.workDay = key(now()); state.workedBefore = true
        }
        const currentWeek = week(now())
        if (state.workWeek !== currentWeek) {
          add('weekly_working_installations')
          if (state.workWeek === key(Date.parse(currentWeek) - 7 * DAY)) add('weekly_returning_installations')
          state.workWeek = currentWeek
        }
      } else {
        const started = running.get(agent)
        if (started == null) return
        running.delete(agent)
        add(interrupted ? 'turns_interrupted' : 'turns_ended')
        const elapsed = Math.max(0, now() - started)
        add(elapsed < 10_000 ? 'duration_under_10s' : elapsed < 60_000 ? 'duration_10s_to_1m' : elapsed < 300_000 ? 'duration_1m_to_5m' : 'duration_over_5m')
      }
    },
    stop(discard = false): void {
      stopped = true; enabled = false; clearInterval(timer); running.clear()
      if (discard) state = fresh(-1)
      persist()
    },
  }
}
