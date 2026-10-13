/** Aggregate-only daily report. Run with a read-only database identity; never prints identifiers. */
import { PrismaClient } from '@prisma/client'
import { DAILY_PRODUCT_METRICS, dailyProductUsage } from './analytics/dailyProductUsage.js'
const days = Number(process.argv[2] ?? 14)
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Choose 1–90 days')
const db = new PrismaClient()
try {
  const today = Math.floor(Date.now() / 86400000) * 86400000
  const rows = await db.productUsageTotal.findMany({
    // Retention always needs the two preceding complete weeks, even for a one-day daily view.
    where: { dayUtc: { gte: new Date(today - Math.max(days - 1, 20) * 86400000), lt: new Date(today + 86400000) }, metric: { in: [...DAILY_PRODUCT_METRICS] } },
    select: { dayUtc: true, metric: true, value: true }, orderBy: [{ dayUtc: 'asc' }, { metric: 'asc' }], take: 3000,
  })
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), timezone: 'UTC',
    definitions: {
      population: 'Reporting signed-in computers, including staff and both service environments; opted-out accounts excluded. Not unique people.',
      active: 'An attached desktop/terminal window or a reported agent turn; background presence can count.',
      working: 'At least one new observed agent turn; human and automated work are combined.',
      first: 'First measured work since the current preference generation, not account signup or task success.',
      activation: 'No signup-to-value activation rate is inferred from first measured work. This report has no signup denominator or task-success signal.',
      weekly: 'Monday–Sunday UTC; compare weekly_returning_installations in a complete week with weekly_working_installations in the preceding complete week.',
      outcomes: 'Matched observed turn ends and interruptions, not task success. Missing or interrupted telemetry is not a failed task.',
      relay: 'Legacy relay event totals are separate; never add them to the client counters.',
      coverage: 'New local counters need updated clients. Delayed/offline reports and privacy changes can affect counts; today is incomplete.',
    }, ...dailyProductUsage(rows, days, new Date()) }, null, 2))
} catch { console.error('Could not read aggregate product usage. Check the read-only connection and schema.'); process.exitCode = 1 }
finally { await db.$disconnect() }
