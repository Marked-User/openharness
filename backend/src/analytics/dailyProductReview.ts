import { PRODUCT_FEEDBACK, PRODUCT_USAGE_ACTIONS } from '../types/productUsage.js'
import { DAILY_PRODUCT_METRICS } from './dailyProductUsage.js'

type Row = { dayUtc: Date; metric: string; value: number }
const DAY = 86400000
const dayKey = (stamp: number) => new Date(stamp).toISOString().slice(0, 10)
const rate = (n: number, d: number) => d > 0 && n >= 0 && n <= d ? Math.round(n / d * 1000) / 10 : null
const sum = (c: Record<string, number>, names: string[]) => names.reduce((n, key) => n + (c[key] ?? 0), 0)

/** Descriptive triage, not an automatic verdict or a causal claim about the latest release. */
export function dailyProductReview(rows: Row[], now: Date) {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const byDay = new Map<string, Record<string, number>>()
  for (const row of rows) {
    if (!DAILY_PRODUCT_METRICS.includes(row.metric as typeof DAILY_PRODUCT_METRICS[number]) || !Number.isSafeInteger(row.value) || row.value < 0) continue
    const key = row.dayUtc.toISOString().slice(0, 10), c = byDay.get(key) ?? {}
    c[row.metric] = (c[row.metric] ?? 0) + row.value; byDay.set(key, c)
  }
  const window = (from: number, until: number) => {
    const counters: Record<string, number> = {}
    let observedDays = 0
    for (let day = from; day < until; day += DAY) {
      const c = byDay.get(dayKey(day))
      if (!c) continue
      if (Object.keys(c).some(k => !k.startsWith('relay_'))) observedDays++
      for (const [k, n] of Object.entries(c)) counters[k] = (counters[k] ?? 0) + n
    }
    return { from: dayKey(from), untilExclusive: dayKey(until), observedDays, counters }
  }
  const recent = window(today - 7 * DAY, today), baseline = window(today - 14 * DAY, today - 7 * DAY)
  const comparison = (name: string, numerator: string[], denominator: string[]) => {
    const side = (w: typeof recent) => {
      const n = sum(w.counters, numerator), d = sum(w.counters, denominator)
      return { numerator: n, denominator: d, percent: rate(n, d), observedDays: w.observedDays }
    }
    const current = side(recent), previous = side(baseline)
    return { name, current, previous,
      differencePercentagePoints: current.percent !== null && previous.percent !== null ? Math.round((current.percent - previous.percent) * 10) / 10 : null,
      evidence: current.denominator < 20 || previous.denominator < 20 || recent.observedDays < 7 || baseline.observedDays < 7
        ? 'Sparse or incomplete; inspect individual synthetic reproductions, do not claim a trend.'
        : 'Descriptive comparison only. Repeated work is not independent sampling; releases, adoption and population changes can confound it.',
    }
  }
  const comparisons = [
    comparison('Observed new-harness launch failure', ['launch_failed'], ['launch_created', 'launch_failed']),
    comparison('First response took at least one minute', ['response_1m_to_5m', 'response_over_5m'],
      ['response_under_10s', 'response_10s_to_1m', 'response_1m_to_5m', 'response_over_5m']),
    comparison('Matched turn ended without an observed text response', ['turns_ended_without_response'], ['turns_ended', 'turns_interrupted']),
    comparison('Matched turn interrupted', ['turns_interrupted'], ['turns_ended', 'turns_interrupted']),
    comparison('Useful among voluntary feedback responses', ['feedback_useful'], PRODUCT_FEEDBACK.map(a => `feedback_${a}`)),
    ...PRODUCT_USAGE_ACTIONS.map(action => comparison(`${action}: request refusal`, [`${action}_failed`], [`${action}_ok`, `${action}_failed`])),
  ]
  const c = recent.counters
  const signals = [
    { area: 'Agent setup', count: c.launch_failed_setup ?? 0, next: 'Reproduce a first launch on a clean machine; verify engine installation, tmux and native hook preparation.' },
    { area: 'Sign-in or permission', count: c.launch_failed_auth ?? 0, next: 'Exercise expired sign-in and reconnect with a test account; verify recovery and the visible explanation.' },
    { area: 'Dependency availability', count: c.launch_failed_unavailable ?? 0, next: 'Test an unavailable model/service and recovery; verify that a saved launch starts exactly once.' },
    { area: 'Launch choices', count: c.launch_failed_invalid ?? 0, next: 'Reproduce invalid project/model selections with fixtures; verify validation before starting work.' },
    { area: 'Unknown launch refusal', count: c.launch_failed_other ?? 0, next: 'Exercise launch failure fixtures and add a justified fixed category; do not retrieve user error messages.' },
    { area: 'Response wait', count: c.turns_waiting_over_1m ?? 0, next: 'Benchmark the same synthetic task and toolchain before/after; separate model wait from Harness overhead locally.' },
    { area: 'No observed response', count: c.turns_ended_without_response ?? 0, next: 'Reproduce interruptions, provider failures and tool-only turns; a missing text event alone does not establish task failure.' },
    { area: 'Launch outcome coverage', count: (c.launch_unobserved ?? 0) + (c.launch_unconfirmed ?? 0), next: 'Verify receipt polling, window close and daemon restart; unknown outcomes must not be counted as failed launches.' },
  ].filter(s => s.count > 0).sort((a, b) => b.count - a.count)
  const retention = [1, 7].map(lag => {
    const cohorts = Array.from({ length: 7 }, (_, i) => {
      const stamp = today - (lag + 7 - i) * DAY, cohort = byDay.get(dayKey(stamp)) ?? {}
      const denominator = cohort.working_installation_days ?? 0
      const followUpObserved = (byDay.get(dayKey(stamp + lag * DAY))?.working_installation_days ?? 0) > 0
      const returned = denominator && followUpObserved ? cohort[`d${lag}_returning_work_installations`] ?? 0 : null
      return { day: dayKey(stamp), workingInstallations: denominator || null, returned,
        percent: returned === null ? null : rate(returned, denominator) }
    })
    return { day: lag, definition: `Observed work on both the cohort's UTC day and UTC day +${lag}. Installation counts, not people.`, cohorts }
  })
  return {
    recent: { from: recent.from, untilExclusive: recent.untilExclusive, observedDays: recent.observedDays },
    baseline: { from: baseline.from, untilExclusive: baseline.untilExclusive, observedDays: baseline.observedDays },
    comparisons, investigate: signals, retention,
    firstLaunchCohorts: {
      definition: 'Participating installations after their first measured new-harness launch attempt. Work/response within 24 hours, counted locally on the original launch day. This is not signup activation or a same-task success rate; updated existing users are included.',
      cohorts: Array.from({ length: 7 }, (_, i) => {
        // A full UTC launch day needs the following UTC day to finish its 24-hour windows.
        const day = dayKey(today - (8 - i) * DAY), c = byDay.get(day) ?? {}
        const starts = c.first_launch_installations ?? 0
        const working = starts ? c.first_launch_work_24h_installations ?? 0 : null
        const responding = starts ? c.first_launch_response_24h_installations ?? 0 : null
        return { day, firstLaunchInstallations: starts || null, workingWithin24h: working, respondingWithin24h: responding,
          observedResponsePercent: responding === null ? null : rate(responding, starts) }
      }),
      caveat: 'No observed response is not proof of failure. Opt-outs, disconnected clients, late uploads and resets can reduce follow-up coverage.',
    },
    firstUse: { firstMeasuredWork: c.first_work_installations ?? null, firstObservedResponse: c.first_response_installations ?? null,
      launchAttempts: c.launch_started ?? null, observedLaunchesCreated: c.launch_created ?? null,
      interpretation: 'Post-sign-in first-use signals; these stage counts are not one signup cohort or a signup conversion rate. Already installed clients enter measurement when updated.' },
    feedback: Object.fromEntries(PRODUCT_FEEDBACK.map(answer => [answer, c[`feedback_${answer}`] ?? 0])),
    gaps: [
      'Pre-sign-in setup and sign-in drop-off are not observed: signed-out clients send no reports. Test those paths synthetically.',
      'Durable launch outcomes require observed receipt replies; status polling adds no attempts. Missing outcomes, restarts and the 15-minute observation bound reduce coverage.',
      'Human and automated work are combined. App-open time is not productive use; technical completion is not task success.',
      'Feedback is voluntary and self-selected, not a representative satisfaction survey or a success rate for all tasks.',
      'Late reports, opt-outs, reinstallations and preference resets affect return counts. Today and immature return cohorts are excluded here.',
    ],
    nextReview: [
      'Choose one observed friction and write a falsifiable hypothesis, target metric, guardrails and comparison window before changing code.',
      'Reproduce with synthetic inputs, profile or benchmark the same workload, then add a regression test and review the fix.',
      'Record the released commit and rollout time. Compare matured equal-length windows; inspect participation changes and competing releases.',
      'Keep, revise or revert based on evidence. With little data, report uncertainty and continue observing instead of declaring a win.',
    ],
  }
}
