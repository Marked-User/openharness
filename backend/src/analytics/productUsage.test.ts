import { describe, expect, it } from 'vitest'
import { productUsageReport, SOURCES, validateOptions, type UsageData } from './productUsage.js'

function fixture(): UsageData {
  return { historyFrom: '2026-07-12', users: [
    { userId: 'a', signupDay: '2026-09-18', emailDomain: 'autonomous.ai' },
    { userId: 'b', signupDay: '2026-09-20', emailDomain: 'example.com' },
  ], rows: { desktop: [], clients: [], devices: [], remote: [], machines: [], agents: [], collector: [] },
  coverage: Object.fromEntries(SOURCES.map(s => [s, { rows: 100, firstDay: '2026-09-16', lastDay: '2026-10-09' }])) as UsageData['coverage'] }
}
const opts = { asOf: '2026-10-10', days: 30 }

describe('product usage metrics', () => {
  it('deduplicates people across machines and surfaces, and excludes the partial day', () => {
    const data = fixture()
    data.rows.desktop = [
      { day: '2026-10-09', userId: 'a', machineId: 'm1' },
      { day: '2026-10-09', userId: 'a', machineId: 'm2' },
      { day: '2026-10-10', userId: 'b', machineId: 'm3' },
    ]
    data.rows.clients = [{ day: '2026-10-09', userId: 'a', surface: 'tui' }, { day: '2026-10-09', userId: 'b', surface: 'mobile' }]
    const result = productUsageReport(data, opts)
    expect(result.windows.day.appUsers).toBe(2)
    expect(result.windows.day.surfaces).toEqual({ desktop: 1, tui: 1, mobile: 1, web: 0 })
    expect(result.windows.day.workingUsers).toBe(0)
    expect(result.daily).toHaveLength(30)
    expect(result.daily.at(-1)?.from).toBe('2026-10-09')
  })

  it('counts distinct machine/agent pairs across days and reconciles rather than adds counters', () => {
    const data = fixture()
    data.rows.machines = [
      { day: '2026-10-08', userId: 'a', machineId: 'm1', turnsStarted: 5 },
      { day: '2026-10-09', userId: 'a', machineId: 'm1', turnsStarted: 10 },
      { day: '2026-10-09', userId: 'b', machineId: 'm2', turnsStarted: 0 },
    ]
    data.rows.agents = [
      { day: '2026-10-08', userId: 'a', machineId: 'm1', agentId: 'same', turnsStarted: 4 },
      { day: '2026-10-09', userId: 'a', machineId: 'm1', agentId: 'same', turnsStarted: 9 },
      { day: '2026-10-09', userId: 'a', machineId: 'm2', agentId: 'same', turnsStarted: 1 },
    ]
    const period = productUsageReport(data, opts).period
    expect(period).toMatchObject({ connectedOwners: 2, workingUsers: 1, turnsStarted: 15, agentTurnsStarted: 14, turnCounterDelta: 1, activeAgents: 2 })
  })

  it('uses only matured, non-left-censored cohorts for exact-day retention', () => {
    const data = fixture()
    data.rows.machines = [
      { day: '2026-09-16', userId: 'old', turnsStarted: 1 },
      { day: '2026-10-02', userId: 'a', turnsStarted: 1 },
      { day: '2026-10-09', userId: 'a', turnsStarted: 1 },
      { day: '2026-10-03', userId: 'b', turnsStarted: 1 },
      { day: '2026-10-10', userId: 'b', turnsStarted: 1 },
    ]
    const retention = productUsageReport(data, opts).firstObservedWorkRetention
    expect(retention.excludedLeftCensoredUsers).toBe(1)
    expect(retention.exactDayRetention[1]).toEqual({ day: 7, eligible: 1, returned: 1, rate: 1 })
    expect(retention.exactDayRetention[2]).toEqual({ day: 14, eligible: 0, returned: 0, rate: null })
  })

  it('compares distinct prior-week users and applies exclusions before all denominators', () => {
    const data = fixture()
    data.rows.machines = [
      { day: '2026-09-26', userId: 'a', turnsStarted: 100 },
      { day: '2026-09-27', userId: 'b', turnsStarted: 10 },
      { day: '2026-10-03', userId: 'b', turnsStarted: 2 },
      { day: '2026-10-09', userId: 'unknown', turnsStarted: 3 },
    ]
    const result = productUsageReport(data, { ...opts, excludeEmailDomains: ['AUTONOMOUS.AI'] })
    expect(result.weeklyWorkReturn).toEqual({ previousUsers: 1, currentUsers: 2, returned: 1, rate: 1, currentOnly: 1, previousOnly: 0 })
    expect(result.population).toMatchObject({ excludedAccounts: 1, knownAccounts: 1, observedUsersWithoutAccountRow: 1 })
    expect(result.intensity.medianTurns).toBe(7.5)
    expect(result.intensity.top1Share).toBe(12 / 15)
    expect(JSON.stringify(result)).not.toContain('"userId"')
    expect(JSON.stringify(result)).not.toContain('"machineId"')
  })

  it('requires a full seven-day observation window for signup activation', () => {
    const data = fixture()
    data.users = [
      { userId: 'a', signupDay: '2026-10-03', emailDomain: 'example.com' },
      { userId: 'b', signupDay: '2026-10-04', emailDomain: 'example.com' },
      { userId: 'c', signupDay: '2026-09-15', emailDomain: 'example.com' },
    ]
    data.rows.machines = [{ day: '2026-10-09', userId: 'a', turnsStarted: 1 }, { day: '2026-10-09', userId: 'b', turnsStarted: 1 }]
    expect(productUsageReport(data, opts).signupActivationWithin7Days).toEqual({ eligible: 1, activated: 1, rate: 1 })
  })

  it('keeps empty data and late instrumentation visible instead of inventing a rate', () => {
    const data = fixture()
    data.coverage.clients = { rows: 3, firstDay: '2026-10-07', lastDay: '2026-10-09' }
    data.coverage.collector = { rows: 97, firstDay: '2026-08-11', lastDay: '2026-08-24' }
    const result = productUsageReport(data, opts)
    expect(result.windows.week.observedCoverage.clients.startsBeforeWindow).toBe(false)
    expect(result.windows.week.observedCoverage.collector.hasRowsOnFinalDay).toBe(false)
    expect(result.intensity.top1Share).toBeNull()
    expect(result.intensity.medianTurns).toBeNull()
    expect(result.weeklyWorkReturn.rate).toBeNull()
  })

  it('rejects invalid dates and unbounded report ranges', () => {
    for (const asOf of ['2026-02-30', '2026-10-10T01:00:00Z', 'bad']) expect(() => validateOptions({ ...opts, asOf })).toThrow()
    for (const days of [0, -1, 366, 1.5, NaN]) expect(() => validateOptions({ ...opts, days })).toThrow()
  })
})
