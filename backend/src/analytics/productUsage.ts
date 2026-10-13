/** Product-wide usage from relay observations. No account identifiers leave this reducer. */
export const DAY_MS = 86_400_000
export const SOURCES = ['desktop', 'clients', 'devices', 'remote', 'machines', 'agents', 'collector'] as const
export type Source = typeof SOURCES[number]
export interface UsageRow {
  day: string
  userId: string
  machineId?: string
  agentId?: string
  surface?: string
  turnsStarted?: number
  connections?: number
  sessions?: number
}
export interface UsageUser { userId: string; signupDay: string; emailDomain: string }
export interface Coverage { rows: number; firstDay: string | null; lastDay: string | null }
export interface UsageData {
  users: UsageUser[]
  rows: Record<Source, UsageRow[]>
  coverage: Record<Source, Coverage>
  historyFrom: string
}
export interface UsageOptions { asOf: string; days: number; excludeEmailDomains?: string[] }

export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
}
export function shiftDay(day: string, offset: number): string {
  return new Date(Date.parse(day) + offset * DAY_MS).toISOString().slice(0, 10)
}
export function validateOptions(opts: UsageOptions): void {
  if (!validDay(opts.asOf)) throw new Error('asOf must be a real UTC date (YYYY-MM-DD)')
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 365) throw new Error('days must be an integer from 1 to 365')
}
const distinct = (rows: UsageRow[]) => new Set(rows.map(r => r.userId))
const sum = (rows: UsageRow[], field: 'turnsStarted' | 'sessions') => rows.reduce((n, r) => n + (r[field] ?? 0), 0)
const rate = (n: number, denominator: number) => denominator ? n / denominator : null
const countOverlap = (a: Set<string>, b: Set<string>) => [...a].filter(id => b.has(id)).length
function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

export function productUsageReport(data: UsageData, opts: UsageOptions) {
  validateOptions(opts)
  const from = shiftDay(opts.asOf, -opts.days)
  const domains = new Set((opts.excludeEmailDomains ?? []).map(d => d.trim().toLowerCase()).filter(Boolean))
  const excluded = new Set(data.users.filter(u => domains.has(u.emailDomain.toLowerCase())).map(u => u.userId))
  const users = data.users.filter(u => !excluded.has(u.userId) && u.signupDay < opts.asOf)
  const knownUsers = new Set(data.users.map(u => u.userId))
  const rows = Object.fromEntries(SOURCES.map(source => [source, data.rows[source].filter(r =>
    r.day >= data.historyFrom && r.day < opts.asOf && !excluded.has(r.userId),
  )])) as Record<Source, UsageRow[]>
  const inRange = (source: Source, start: string, end: string) => rows[source].filter(r => r.day >= start && r.day < end)
  const working = (start: string, end: string) => inRange('machines', start, end).filter(r => (r.turnsStarted ?? 0) > 0)
  const apps = (start: string, end: string) => [...inRange('desktop', start, end),
    ...inRange('clients', start, end).filter(r => ['tui', 'mobile', 'web'].includes(r.surface ?? ''))]

  function summary(start: string, end: string) {
    const machines = inRange('machines', start, end), work = working(start, end)
    const agents = inRange('agents', start, end).filter(r => (r.turnsStarted ?? 0) > 0)
    const clients = inRange('clients', start, end), remote = inRange('remote', start, end)
    const turnsStarted = sum(machines, 'turnsStarted'), agentTurnsStarted = sum(agents, 'turnsStarted')
    return {
      from: start, toExclusive: end,
      appUsers: distinct(apps(start, end)).size,
      workingUsers: distinct(work).size,
      connectedOwners: distinct(machines).size,
      connectedMachines: new Set(machines.map(r => r.machineId)).size,
      workingMachines: new Set(work.map(r => r.machineId)).size,
      activeAgents: new Set(agents.map(r => JSON.stringify([r.machineId, r.agentId]))).size,
      turnsStarted, agentTurnsStarted, turnCounterDelta: turnsStarted - agentTurnsStarted,
      surfaces: {
        desktop: distinct(inRange('desktop', start, end)).size,
        tui: distinct(clients.filter(r => r.surface === 'tui')).size,
        mobile: distinct(clients.filter(r => r.surface === 'mobile')).size,
        web: distinct(clients.filter(r => r.surface === 'web')).size,
      },
      hardwareOwners: distinct(inRange('devices', start, end)).size,
      remoteOfferUsers: distinct(remote).size,
      remoteOffers: sum(remote, 'sessions'),
      observedCoverage: Object.fromEntries(SOURCES.map(source => [source, {
        startsBeforeWindow: data.coverage[source].firstDay !== null && data.coverage[source].firstDay! < start,
        hasRowsOnFinalDay: data.coverage[source].lastDay === shiftDay(end, -1) ||
          inRange(source, shiftDay(end, -1), end).length > 0,
      }])),
    }
  }

  const workDays = new Map<string, Set<string>>()
  for (const r of working(data.historyFrom, opts.asOf)) {
    const days = workDays.get(r.userId) ?? new Set<string>()
    days.add(r.day)
    workDays.set(r.userId, days)
  }
  const firstWork = [...workDays].map(([id, days]) => ({ id, first: [...days].sort()[0], days }))
  // The initial observed day is left-censored. Neither these nor later cohorts imply a new account.
  const boundary = [data.historyFrom, data.coverage.machines.firstDay ?? opts.asOf].sort().at(-1)!
  const cohorts = firstWork.filter(u => u.first > boundary && u.first >= from)
  const exactDayRetention = [1, 7, 14].map(offset => {
    const eligible = cohorts.filter(u => shiftDay(u.first, offset) < opts.asOf)
    const returned = eligible.filter(u => u.days.has(shiftDay(u.first, offset))).length
    return { day: offset, eligible: eligible.length, returned, rate: rate(returned, eligible.length) }
  })
  const signupEligible = users.filter(u => u.signupDay > boundary && u.signupDay >= from && shiftDay(u.signupDay, 7) <= opts.asOf)
  const activated = signupEligible.filter(u => [...(workDays.get(u.userId) ?? [])]
    .some(day => day >= u.signupDay && day < shiftDay(u.signupDay, 7))).length
  const previousWork = distinct(working(shiftDay(opts.asOf, -14), shiftDay(opts.asOf, -7)))
  const currentWork = distinct(working(shiftDay(opts.asOf, -7), opts.asOf))
  const returned = countOverlap(previousWork, currentWork)

  const power = new Map<string, { turns: number; days: Set<string> }>()
  for (const r of working(from, opts.asOf)) {
    const p = power.get(r.userId) ?? { turns: 0, days: new Set<string>() }
    p.turns += r.turnsStarted ?? 0
    p.days.add(r.day)
    power.set(r.userId, p)
  }
  const ranked = [...power.values()].sort((a, b) => b.turns - a.turns)
  const totalTurns = ranked.reduce((n, p) => n + p.turns, 0)
  const turns = ranked.map(p => p.turns).sort((a, b) => a - b)
  const activeDays = ranked.map(p => p.days.size).sort((a, b) => a - b)
  const orphanIds = distinct(SOURCES.flatMap(source => inRange(source, from, opts.asOf)).filter(r => !knownUsers.has(r.userId)))
  const daily = Array.from({ length: opts.days }, (_, i) => {
    const day = shiftDay(from, i)
    const point = summary(day, shiftDay(day, 1))
    const { observedCoverage: _coverage, ...counts } = point
    return counts
  })
  return {
    schemaVersion: 1,
    range: { from, toExclusive: opts.asOf, days: opts.days, timezone: 'UTC', historyFrom: data.historyFrom },
    population: { excludedEmailDomains: [...domains].sort(), excludedAccounts: excluded.size,
      knownAccounts: users.length, accountsCreatedInPeriod: users.filter(u => u.signupDay >= from).length,
      observedUsersWithoutAccountRow: orphanIds.size },
    definitions: {
      appUsers: 'Distinct accounts observed in desktop, TUI, mobile or web presence; an open client is not proof of active work. Surface counts overlap.',
      workingUsers: 'Distinct owners of machines with at least one observed turn_started; includes automated work and only connected, reporting machines.',
      turnsStarted: 'Machine relay counter. Agent counters are an independent reconciliation, never added to machine counters.',
      activeAgents: 'Distinct (machineId, agentId) pairs across the window, not the sum of daily distinct counts.',
      remoteOffers: 'Accepted P2P offers, not confirmed successful sessions; relay-only remote use is not represented.',
      retention: 'Exact-day return after first observed work in the loaded history; excludes its initial, left-censored day. Not signup retention.',
      coverage: 'Earliest/latest stored observations before the cutoff, across all accounts. Not proof of continuous instrumentation; absent observations do not prove inactivity.',
    },
    coverage: data.coverage,
    period: summary(from, opts.asOf),
    windows: { day: summary(shiftDay(opts.asOf, -1), opts.asOf), week: summary(shiftDay(opts.asOf, -7), opts.asOf),
      previousWeek: summary(shiftDay(opts.asOf, -14), shiftDay(opts.asOf, -7)), month: summary(shiftDay(opts.asOf, -30), opts.asOf) },
    weeklyWorkReturn: { previousUsers: previousWork.size, currentUsers: currentWork.size, returned,
      rate: rate(returned, previousWork.size), currentOnly: currentWork.size - returned, previousOnly: previousWork.size - returned },
    firstObservedWorkRetention: { cohorts: cohorts.length, excludedLeftCensoredUsers: firstWork.filter(u => u.first <= boundary).length, exactDayRetention },
    signupActivationWithin7Days: { eligible: signupEligible.length, activated, rate: rate(activated, signupEligible.length) },
    intensity: { workingUsers: ranked.length, medianTurns: quantile(turns, .5), p90Turns: quantile(turns, .9),
      medianActiveDays: quantile(activeDays, .5), usersWithAtLeast5ActiveDays: ranked.filter(p => p.days.size >= 5).length,
      top1Share: rate(ranked.slice(0, 1).reduce((n, p) => n + p.turns, 0), totalTurns),
      top5Share: rate(ranked.slice(0, 5).reduce((n, p) => n + p.turns, 0), totalTurns),
      top10Share: rate(ranked.slice(0, 10).reduce((n, p) => n + p.turns, 0), totalTurns),
      topAccounts: ranked.slice(0, 10).map((p, i) => ({ rank: i + 1, turns: p.turns, activeDays: p.days.size })) },
    daily,
  }
}
