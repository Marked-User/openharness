import { expect, it } from 'vitest'
import { dailyProductReview } from './dailyProductReview.js'
const row = (day: string, metric: string, value: number) => ({ dayUtc: new Date(day), metric, value })

it('keeps today out of comparisons and marks sparse or absent baselines honestly', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'launch_created', 3), row('2026-10-12', 'launch_failed', 1),
    row('2026-10-12', 'launch_failed_setup', 1), row('2026-10-13', 'launch_failed', 999),
  ], new Date('2026-10-13T12:00:00Z'))
  expect(r.comparisons[0].current).toMatchObject({ numerator: 1, denominator: 4, percent: 25 })
  expect(r.comparisons[0].previous.percent).toBeNull()
  expect(r.comparisons[0].differencePercentagePoints).toBeNull()
  expect(r.comparisons[0].evidence).toContain('Sparse')
  expect(r.investigate[0]).toMatchObject({ area: 'Agent setup', count: 1 })
})

it('uses matured original working-day cohorts and refuses to interpret missing follow-up coverage as zero', () => {
  const r = dailyProductReview([
    row('2026-10-11', 'working_installation_days', 10), row('2026-10-11', 'd1_returning_work_installations', 6),
    row('2026-10-12', 'working_installation_days', 8),
    row('2026-10-04', 'working_installation_days', 12), row('2026-10-04', 'd7_returning_work_installations', 3),
    row('2026-10-05', 'working_installation_days', 7),
  ], new Date('2026-10-13'))
  expect(r.retention[0].cohorts.at(-1)).toMatchObject({ day: '2026-10-11', workingInstallations: 10, returned: 6, percent: 60 })
  expect(r.retention[1].cohorts.find(c => c.day === '2026-10-04')).toMatchObject({ percent: 25 })
  expect(r.retention[0].cohorts.find(c => c.day === '2026-10-05')?.percent).toBeNull()
  expect(r.retention[0].cohorts[0].percent).toBeNull()
})

it('reports voluntary feedback separately, never as a task success rate', () => {
  const r = dailyProductReview([row('2026-10-12', 'feedback_useful', 2), row('2026-10-12', 'feedback_slow', 1)], new Date('2026-10-13'))
  expect(r.feedback).toMatchObject({ useful: 2, slow: 1 })
  expect(r.comparisons.find(c => c.name.startsWith('Useful'))?.current.denominator).toBe(3)
  expect(r.gaps.join(' ')).toContain('self-selected')
  expect(r).not.toHaveProperty('taskSuccessRate')
})

it('compares first-launch installation cohorts only after every 24-hour window can mature', () => {
  const r = dailyProductReview([
    row('2026-10-11', 'first_launch_installations', 4), row('2026-10-11', 'first_launch_work_24h_installations', 3),
    row('2026-10-11', 'first_launch_response_24h_installations', 2), row('2026-10-12', 'first_launch_installations', 99),
  ], new Date('2026-10-13'))
  expect(r.firstLaunchCohorts.cohorts.at(-1)).toMatchObject({ day: '2026-10-11', firstLaunchInstallations: 4, workingWithin24h: 3, observedResponsePercent: 50 })
  expect(r.firstLaunchCohorts.cohorts.some(c => c.day === '2026-10-12')).toBe(false)
  expect(r.firstLaunchCohorts.cohorts[0].observedResponsePercent).toBeNull()
})

it('keeps feedback denominators and setup coverage separate from daemon participation', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'feedback_useful', 2), row('2026-10-12', 'feedback_completed', 3), row('2026-10-12', 'feedback_not_completed', 1),
    row('2026-10-12', 'setup_desktop_sign_in_started', 5), row('2026-10-12', 'setup_desktop_sign_in_ok', 2),
  ], new Date('2026-10-13'))
  expect(r.comparisons.find(c => c.name.startsWith('Useful'))?.current.denominator).toBe(2)
  expect(r.comparisons.find(c => c.name.startsWith('Completed'))?.current).toMatchObject({ denominator: 4, percent: 75 })
  expect(r.recent.observedDays).toBe(0)
  expect(r.flows.find(f => f.channel === 'setup' && f.surface === 'desktop' && f.flow === 'sign_in')).toMatchObject({ started: 5, unmatchedStarts: 3 })
  expect(r.flows.find(f => f.channel === 'ui' && f.flow === 'update_stage')?.started).toBeNull()
})
it('uses complete calendar months rather than adding daily installations into MAU', () => {
  const r = dailyProductReview([
    row('2026-08-12', 'monthly_working_installations', 10), row('2026-09-12', 'monthly_working_installations', 8),
    row('2026-09-12', 'monthly_returning_installations', 6), row('2026-10-12', 'monthly_returning_installations', 99),
  ], new Date('2026-10-13'))
  expect(r.monthlyRetention).toMatchObject({ from: '2026-09-01', untilExclusive: '2026-10-01', percent: 60 })
})
