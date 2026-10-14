import { readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProductUsageLaunchSignal } from '../lib/productUsageSignals.js'
import { PRODUCT_USAGE_ACTIONS, PRODUCT_USAGE_AUTOMATIC_ACTIONS, PRODUCT_USAGE_DAYS, PRODUCT_USAGE_MAX_COUNT, PRODUCT_USAGE_METRICS,
  type ProductUsageChoice, type ProductUsageMetric, type ProductUsageReport } from '../lib/productUsageContract.js'

const DAY = 86_400_000
const MAX_QUEUE_BYTES = 256 * 1024
// A report stays below the server's 8 KiB body bound even with the complete vocabulary.
const MAX_REPORT_METRICS = 64
const metricSet = new Set<string>(PRODUCT_USAGE_METRICS)
// Feature reach is a person's use; the reads the apps make on their own count only their reliability.
const requestActions = new Map(PRODUCT_USAGE_ACTIONS.filter(action => !PRODUCT_USAGE_AUTOMATIC_ACTIONS.includes(action))
  .map(action => [`${action}_requests`, action]))
const key = (now: number) => new Date(now).toISOString().slice(0, 10)
const week = (now: number) => { const d = new Date(now); return key(now - ((d.getUTCDay() + 6) % 7) * DAY) }
type Counters = Partial<Record<ProductUsageMetric, number>>
interface State {
  revision: number
  activeDay: string | null
  workDay: string | null
  workWeek: string | null
  workMonth: string | null
  measurementDay: string | null
  featureDays: Partial<Record<typeof PRODUCT_USAGE_ACTIONS[number], string>>
  featuresUsed: typeof PRODUCT_USAGE_ACTIONS[number][]
  workedBefore: boolean
  respondedBefore: boolean
  launchedBefore: boolean
  firstLaunchAt: number | null
  launchWorked: boolean
  launchResponded: boolean
  workDays: string[]
  days: Record<string, Counters>
  pending: ProductUsageReport | null
}
const fresh = (revision: number): State => ({ revision, activeDay: null, workDay: null, workWeek: null,
  workMonth: null, measurementDay: null, featureDays: {}, featuresUsed: [],
  workedBefore: false, respondedBefore: false, launchedBefore: false, firstLaunchAt: null,
  launchWorked: false, launchResponded: false, workDays: [], days: {}, pending: null })
export interface ProductUsageDeps {
  file: string
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  now?(): number
  uuid?(): string
  /** Test seam for a slow or unavailable disk; never called from an event observer. */
  write?(file: string, value: string): Promise<void>
}

/** A reporting component of the gateway service; the core never waits for it.
 * Counts lifecycle facts only. No transcript, prompt, response, tool or error object enters this API.
 * Agent identifiers live only in the bounded in-memory duration map and never reach disk or HTTP.
 */
export function createProductUsage(deps: ProductUsageDeps) {
  const now = deps.now ?? Date.now, uuid = deps.uuid ?? randomUUID
  let state = fresh(-1), enabled = false, stopped = false, active = false
  let syncing: Promise<void> | null = null, persistTimer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<boolean> | null = null, writeAgain = false
  const running = new Map<string, { started: number; response: boolean; error: boolean; waited: boolean }>()
  const launches = new Map<string, { started: number; done: boolean; waits: Set<string> }>()
  try {
    if (statSync(deps.file).size > MAX_QUEUE_BYTES) throw new Error('Usage queue exceeds its bound')
    // Reconstruct every field; even a corrupted local file cannot introduce a new upload property.
    const saved = JSON.parse(readFileSync(deps.file, 'utf8')) as State
    if (Number.isSafeInteger(saved.revision) && saved.revision >= 0) {
      state = fresh(saved.revision)
      for (const field of ['activeDay', 'workDay', 'workWeek', 'measurementDay'] as const) {
        if (typeof saved[field] === 'string' && validDay(saved[field]!)) state[field] = saved[field]
      }
      if (typeof saved.workMonth === 'string' && /^\d{4}-\d{2}$/.test(saved.workMonth)) state.workMonth = saved.workMonth
      for (const action of PRODUCT_USAGE_ACTIONS) {
        if (validDay(saved.featureDays?.[action] ?? '')) state.featureDays[action] = saved.featureDays![action]
        if (saved.featuresUsed?.includes(action)) state.featuresUsed.push(action)
      }
      state.workedBefore = saved.workedBefore === true
      state.respondedBefore = saved.respondedBefore === true
      state.launchedBefore = saved.launchedBefore === true
      state.firstLaunchAt = Number.isSafeInteger(saved.firstLaunchAt) && saved.firstLaunchAt! <= now()
        && validDay(key(saved.firstLaunchAt!)) ? saved.firstLaunchAt : null
      state.launchWorked = saved.launchWorked === true
      state.launchResponded = saved.launchResponded === true
      state.workDays = Array.isArray(saved.workDays) ? [...new Set(saved.workDays.filter(d => typeof d === 'string' && validDay(d)))].slice(-35) : []
      for (const [day, counters] of Object.entries(saved.days ?? {})) if (validDay(day)) state.days[day] = clean(counters)
      const pending = saved.pending
      if (pending && pending.schemaVersion === 1 && pending.revision === state.revision && validDay(pending.day)
          && typeof pending.id === 'string' && /^[a-f0-9-]{36}$/.test(pending.id)) {
        const restored = { schemaVersion: 1 as const, revision: state.revision, id: pending.id, day: pending.day, counters: clean(pending.counters) }
        if (Buffer.byteLength(JSON.stringify(restored)) <= 8192) state.pending = restored
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
  function snapshot(): string {
    clearTimeout(persistTimer); persistTimer = undefined
    for (const field of ['activeDay', 'workDay', 'workWeek', 'measurementDay'] as const) if (state[field] && !validDay(state[field]!)) state[field] = null
    for (const day of Object.keys(state.days)) if (!validDay(day)) delete state.days[day]
    for (const action of PRODUCT_USAGE_ACTIONS) if (!validDay(state.featureDays[action] ?? '')) delete state.featureDays[action]
    state.workDays = state.workDays.filter(validDay)
    if (state.firstLaunchAt !== null && !validDay(key(state.firstLaunchAt))) state.firstLaunchAt = null
    if (state.pending && !validDay(state.pending.day)) state.pending = null
    // Size each day once, keeping the most recent ones. Repeatedly serializing a full
    // offline backlog to remove its oldest day would stall the gateway on a reconnect.
    let bytes = Buffer.byteLength(JSON.stringify({ ...state, days: {} })) + 1024
    const kept: State['days'] = {}
    let pruned = false
    for (const day of Object.keys(state.days).sort().reverse()) {
      const size = Buffer.byteLength(JSON.stringify(state.days[day])) + 16
      if (bytes + size > MAX_QUEUE_BYTES) { pruned = true; continue }
      kept[day] = state.days[day]; bytes += size
    }
    state.days = kept
    if (pruned) (state.days[key(now())] ??= {}).measurement_queue_pruned = 1
    return JSON.stringify(state)
  }
  function persist(): Promise<boolean> {
    writeAgain = true
    // Coalesce concurrent saves to one in-flight write and the latest bounded state.
    // A slow disk must not create a promise/file queue or block the relay's event loop.
    return writing ??= (async () => {
      try {
        do {
          writeAgain = false
          const value = snapshot()
          if (deps.write) await deps.write(deps.file, value)
          else {
            await mkdir(dirname(deps.file), { recursive: true, mode: 0o700 })
            await writeFile(deps.file + '.tmp', value, { mode: 0o600 })
            await rename(deps.file + '.tmp', deps.file)
          }
        } while (writeAgain)
        return true
      } catch { enabled = false; return false }
    })().finally(() => { writing = null })
  }
  function dirty(): void {
    if (!persistTimer) { persistTimer = setTimeout(() => { void persist() }, 1000); persistTimer.unref() }
  }
  function add(metric: ProductUsageMetric, day = key(now())): void {
    if (state.measurementDay !== key(now())) {
      state.measurementDay = key(now())
      ;(state.days[state.measurementDay] ??= {}).measurement_v2_installation_days = 1
    }
    const counters = state.days[day] ??= {}
    counters[metric] = Math.min(PRODUCT_USAGE_MAX_COUNT, (counters[metric] ?? 0) + 1)
    dirty()
  }
  function markActive(): void {
    if (!enabled || stopped) return
    if (state.activeDay !== key(now())) { state.activeDay = key(now()); add('active_installation_days') }
  }
  function launchValue(response: boolean): void {
    if (state.firstLaunchAt === null || now() < state.firstLaunchAt || now() - state.firstLaunchAt > DAY) return
    const field = response ? 'launchResponded' : 'launchWorked'
    if (!state[field]) {
      state[field] = true
      add(response ? 'first_launch_response_24h_installations' : 'first_launch_work_24h_installations', key(state.firstLaunchAt))
    }
  }
  async function choice(value: ProductUsageChoice): Promise<void> {
    if (state.revision !== value.revision || (!value.enabled && (enabled || state.pending || Object.keys(state.days).length))) {
      state = fresh(value.revision); running.clear(); launches.clear()
      enabled = false
      if (!await persist()) return
    }
    enabled = value.enabled && !stopped
  }
  async function syncOnce(): Promise<void> {
    try {
      const response = await deps.request('GET', '/api/product-usage/settings')
      if (stopped) return
      const body = response.body.data as ProductUsageChoice | undefined
      if (response.status !== 200 || typeof body?.enabled !== 'boolean'
          || !Number.isSafeInteger(body.revision) || body.revision < 0) { enabled = false; running.clear(); launches.clear(); return }
      await choice(body)
      if (!enabled) return
      for (const turn of running.values()) if (!turn.response && !turn.waited && now() - turn.started >= 60_000) {
        turn.waited = true; add('turns_waiting_over_1m')
      }
      for (const [id, launch] of launches) {
        if (!launch.done && now() - launch.started >= 15 * 60_000) { launch.done = true; add('launch_unobserved') }
        if (now() - launch.started >= 35 * 60_000) launches.delete(id)
      }
      if (active) markActive()
      if (!state.pending) {
        const day = Object.keys(state.days).sort().find(d => validDay(d) && Object.keys(state.days[d]).length)
        if (!day) return
        const counters = Object.fromEntries(Object.entries(state.days[day]).slice(0, MAX_REPORT_METRICS)) as Counters
        state.pending = { schemaVersion: 1, revision: state.revision, id: uuid(), day, counters }
        for (const metric of Object.keys(counters)) delete state.days[day][metric as ProductUsageMetric]
        if (!Object.keys(state.days[day]).length) delete state.days[day]
      }
      // Persist the immutable receipt before sending. A crash or ambiguous response retries that id.
      if (!await persist() || stopped || !enabled) return
      const report = state.pending
      if (!report) return
      const answer = await deps.request('POST', '/api/product-usage/report', report)
      if (stopped) return
      const result = answer.body.data as { accepted?: boolean; reason?: string } | undefined
      if (answer.status === 200 && result?.accepted === true) { state.pending = null; await persist() }
      else if (result?.reason === 'CHOICE_CHANGED') { enabled = false; state = fresh(-1); running.clear(); launches.clear(); await persist() }
      else if (result?.reason === 'EXPIRED') { state.pending = null; await persist() }
    } catch { enabled = false; running.clear(); launches.clear() /* No error text or request body in logs. */ }
  }
  const sync = (): Promise<void> => syncing ??= syncOnce().finally(() => { syncing = null })
  const timer = setInterval(() => { void sync() }, 60_000)
  timer.unref()

  return {
    sync,
    counter(metric: ProductUsageMetric): void {
      if (!enabled || stopped || !metricSet.has(metric)) return
      add(metric)
      const action = requestActions.get(metric)
      if (action && state.featureDays[action] !== key(now())) {
        add(`${action}_installation_days`)
        add(`${action}_${state.featuresUsed.includes(action) ? 'repeat_installation_days' : 'first_installations'}`)
        if (!state.featuresUsed.includes(action)) state.featuresUsed.push(action)
        state.featureDays[action] = key(now())
      }
    },
    launch(signal: ProductUsageLaunchSignal): void {
      if (!enabled || stopped || !signal || typeof signal.id !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(signal.id)) return
      if (signal.phase === 'start') {
        if (launches.has(signal.id)) return
        if (!state.launchedBefore) {
          state.launchedBefore = true; state.firstLaunchAt = now(); add('first_launch_installations')
        }
        if (launches.size >= 1000) {
          const oldest = launches.keys().next().value!
          if (!launches.get(oldest)!.done) add('launch_unobserved')
          launches.delete(oldest)
        }
        launches.set(signal.id, { started: now(), done: false, waits: new Set() }); add('launch_started'); return
      }
      const launch = launches.get(signal.id)
      if (!launch || launch.done) return
      if (signal.phase === 'pending') {
        const wait = ['install', 'model', 'native'].includes(signal.wait ?? '') ? signal.wait! : 'other'
        if (!launch.waits.has(wait)) { launch.waits.add(wait); add(`launch_wait_${wait}` as ProductUsageMetric) }
        return
      }
      if (!['created', 'failed', 'cancelled', 'unconfirmed'].includes(signal.phase)) return
      launch.done = true
      add(`launch_${signal.phase}` as ProductUsageMetric)
      if (signal.phase === 'failed') {
        const kind = ['setup', 'auth', 'unavailable', 'invalid'].includes(signal.failure ?? '') ? signal.failure! : 'other'
        add(`launch_failed_${kind}` as ProductUsageMetric)
      }
      const elapsed = Math.max(0, now() - launch.started)
      add(elapsed < 10_000 ? 'launch_under_10s' : elapsed < 60_000 ? 'launch_10s_to_1m' : elapsed < 300_000 ? 'launch_1m_to_5m' : 'launch_over_5m')
    },
    presence(value: boolean): void { active = value; if (value) markActive() },
    opened(surface: 'desktop' | 'tui'): void {
      if (!enabled || stopped) return
      markActive(); add(surface === 'desktop' ? 'desktop_opens' : 'tui_opens')
    },
    observe(type: 'turn_started' | 'turn_ended' | 'text_delta' | 'error', agent: string, replay: boolean, interrupted = false): void {
      if (!enabled || stopped || replay || !agent || agent.length > 256) return
      if (type === 'turn_started') {
        if (running.has(agent)) return
        if (running.size >= 1000) { add('turn_observation_overflow'); return }
        running.set(agent, { started: now(), response: false, error: false, waited: false }); markActive(); add('turns_started')
        launchValue(false)
        if (state.workDay !== key(now())) {
          if (state.workDay && now() - Date.parse(state.workDay) >= 7 * DAY) add('reactivated_after_7d_installations')
          add('working_installation_days')
          add(state.workedBefore ? 'repeat_work_installation_days' : 'first_work_installations')
          state.workDay = key(now()); state.workedBefore = true
          // Return counters belong to the earlier working-day cohort, not today's new starts.
          // Only these date flags stay here; no server-side installation/user join is needed.
          for (const [lag, metric] of [[1, 'd1_returning_work_installations'], [7, 'd7_returning_work_installations'], [28, 'd28_returning_work_installations']] as const) {
            const cohort = key(now() - lag * DAY)
            if (state.workDays.includes(cohort)) add(metric, cohort)
          }
          state.workDays = [...state.workDays.filter(validDay), key(now())]
        }
        const currentMonth = key(now()).slice(0, 7)
        if (state.workMonth !== currentMonth) {
          add('monthly_working_installations')
          const prior = new Date(currentMonth + '-01T00:00:00Z'); prior.setUTCMonth(prior.getUTCMonth() - 1)
          if (state.workMonth === key(prior.getTime()).slice(0, 7)) add('monthly_returning_installations')
          state.workMonth = currentMonth
        }
        const currentWeek = week(now())
        if (state.workWeek !== currentWeek) {
          add('weekly_working_installations')
          if (state.workWeek === key(Date.parse(currentWeek) - 7 * DAY)) add('weekly_returning_installations')
          state.workWeek = currentWeek
        }
      } else {
        const turn = running.get(agent)
        if (!turn) return
        const elapsed = Math.max(0, now() - turn.started)
        if (!turn.response && !turn.waited && elapsed >= 60_000) { turn.waited = true; add('turns_waiting_over_1m') }
        if (type === 'error') {
          if (!turn.error) { turn.error = true; add('turns_with_error') }
          return
        }
        if (type === 'text_delta') {
          if (!turn.response) {
            turn.response = true; add('turns_with_response')
            // Do not attribute a response from a turn already running when the first launch began.
            if (state.firstLaunchAt !== null && turn.started >= state.firstLaunchAt) launchValue(true)
            if (!state.respondedBefore) { state.respondedBefore = true; add('first_response_installations') }
            add(elapsed < 10_000 ? 'response_under_10s' : elapsed < 60_000 ? 'response_10s_to_1m' : elapsed < 300_000 ? 'response_1m_to_5m' : 'response_over_5m')
          }
          return
        }
        running.delete(agent)
        if (!turn.response) add('turns_ended_without_response')
        add(interrupted ? 'turns_interrupted' : 'turns_ended')
        add(elapsed < 10_000 ? 'duration_under_10s' : elapsed < 60_000 ? 'duration_10s_to_1m' : elapsed < 300_000 ? 'duration_1m_to_5m' : 'duration_over_5m')
      }
    },
    stop(discard = false): Promise<boolean> {
      stopped = true; enabled = false; clearInterval(timer); running.clear(); launches.clear()
      if (discard) state = fresh(-1)
      return persist()
    },
  }
}
