import type { Prisma, PrismaClient } from '@prisma/client'
import { SOURCES, shiftDay, validateOptions, type Coverage, type UsageData, type UsageOptions, type UsageRow, type UsageUser } from './productUsage.js'

const QUERY_OPTIONS = { maxTimeMS: 15_000, allowDiskUse: false }
const MAX_ROWS = 100_000
type Reader = { aggregateRaw(args: { pipeline: Prisma.InputJsonObject[]; options: Prisma.InputJsonObject }): PromiseLike<unknown> }
const dateString = (field: string) => ({ $dateToString: { date: field, format: '%Y-%m-%d', timezone: 'UTC' } })

/** Only bounded read aggregates; deliberately does not import the application's startup or Prisma singleton. */
export async function readProductUsage(db: PrismaClient, opts: UsageOptions): Promise<UsageData> {
  validateOptions(opts)
  const historyFrom = shiftDay(opts.asOf, -Math.max(90, opts.days))
  const until = { $date: `${opts.asOf}T00:00:00.000Z` }
  const since = { $date: `${historyFrom}T00:00:00.000Z` }
  async function read<T>(model: Reader, pipeline: Prisma.InputJsonObject[]): Promise<T[]> {
    const result = await model.aggregateRaw({ pipeline: [...pipeline, { $limit: MAX_ROWS + 1 }], options: QUERY_OPTIONS })
    if (!Array.isArray(result)) throw new Error('Unexpected database aggregation response')
    if (result.length > MAX_ROWS) throw new Error('Usage query exceeded 100,000 rows; narrow the date range or aggregate on the server')
    return result as T[]
  }
  const users = await read<UsageUser>(db.user, [
    { $match: { createdAt: { $lt: until } } },
    { $project: { _id: 0, userId: { $toString: '$_id' }, signupDay: dateString('$createdAt'),
      emailDomain: { $arrayElemAt: [{ $split: [{ $toLower: { $ifNull: ['$email', ''] } }, '@'] }, -1] } } },
  ])
  const models: Record<typeof SOURCES[number], Reader> = {
    desktop: db.userDailyPresence, clients: db.userDailyClientPresence, devices: db.userDailyDevicePresence,
    remote: db.userDailyRemoteUsage, machines: db.machineDailyPresence, agents: db.agentDailyPresence, collector: db.analyticsDailyBucket,
  }
  const rows = {} as UsageData['rows'], coverage = {} as UsageData['coverage']
  // Sequential bounded aggregates keep load predictable on the production read replica/primary.
  for (const source of SOURCES) {
    const stats = await read<Coverage>(models[source], [
      { $match: { dayUtc: { $lt: until } } },
      { $group: { _id: null, rows: { $sum: 1 }, first: { $min: '$dayUtc' }, last: { $max: '$dayUtc' } } },
      { $project: { _id: 0, rows: 1, firstDay: dateString('$first'), lastDay: dateString('$last') } },
    ])
    coverage[source] = stats[0] ?? { rows: 0, firstDay: null, lastDay: null }
    rows[source] = await read<UsageRow>(models[source], [
      { $match: { dayUtc: { $gte: since, $lt: until } } },
      { $project: { _id: 0, day: dateString('$dayUtc'), userId: 1, machineId: 1, agentId: 1, surface: 1,
        turnsStarted: { $ifNull: ['$turnsStarted', 0] }, connections: { $ifNull: ['$connections', 0] }, sessions: { $ifNull: ['$sessions', 0] } } },
    ])
  }
  return { users, rows, coverage, historyFrom }
}
