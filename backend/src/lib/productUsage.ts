import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { PRODUCT_USAGE_DAYS, type ProductUsageChoice, type ProductUsageReport } from '../types/productUsage.js'

const DAY = 86_400_000
type Db = Pick<Prisma.TransactionClient, 'productUsagePreference' | 'analyticsMachineState'>

/** A pre-existing off choice wins over the new default. Never cache an enabled answer. */
export async function productUsageChoice(userId: string, db: Db = prisma): Promise<ProductUsageChoice> {
  const saved = await db.productUsagePreference.findUnique({ where: { userId }, select: { enabled: true, revision: true } })
  if (saved) return saved
  const off = await db.analyticsMachineState.findFirst({ where: { userId, consent: 'off' }, select: { id: true } })
  return { enabled: !off, revision: 0 }
}

export async function setProductUsageChoice(userId: string, enabled: boolean): Promise<ProductUsageChoice> {
  // Every explicit save advances the generation. A queue prepared before an off/on cycle is refused.
  return prisma.productUsagePreference.upsert({
    where: { userId }, create: { userId, enabled, revision: 1 },
    update: { enabled, revision: { increment: 1 } }, select: { enabled: true, revision: true },
  })
}

function validDay(day: string, now: Date): boolean {
  const stamp = Date.parse(day + 'T00:00:00.000Z')
  const today = Math.floor(now.getTime() / DAY) * DAY
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day
    && stamp <= today && stamp > today - PRODUCT_USAGE_DAYS * DAY
}

/** Identity is used for permission only. Neither it nor the report body reaches analytics storage. */
export async function ingestProductUsage(userId: string, report: ProductUsageReport, now = new Date()) {
  if (!validDay(report.day, now)) return { accepted: false, reason: 'EXPIRED' }
  try {
    return await prisma.$transaction(async tx => {
      const choice = await productUsageChoice(userId, tx)
      if (!choice.enabled || choice.revision !== report.revision) return { accepted: false, reason: 'CHOICE_CHANGED', ...choice }
      // Receipt and increments commit together; a lost HTTP response can be retried with the same id.
      await tx.productUsageReceipt.create({ data: {
        id: report.id, expiresAt: new Date(Date.parse(report.day) + (PRODUCT_USAGE_DAYS + 1) * DAY),
      } })
      for (const [metric, value] of Object.entries(report.counters)) {
        if (!value) continue
        await tx.productUsageTotal.upsert({
          where: { dayUtc_metric: { dayUtc: new Date(report.day), metric } },
          create: { dayUtc: new Date(report.day), metric, value }, update: { value: { increment: value } },
        })
      }
      return { accepted: true }
    })
  } catch (error) {
    // A competing first writer of a daily total is NOT a duplicate report: let the client retry it.
    if ((error as { code?: string }).code === 'P2002'
        && await prisma.productUsageReceipt.findUnique({ where: { id: report.id }, select: { id: true } })) return { accepted: true }
    throw error
  }
}

export type RelayUsageMetric = 'relay_desktop_opens' | 'relay_tui_opens' | 'relay_mobile_opens' | 'relay_web_opens'
  | 'relay_harness-os_opens' | 'relay_harness-os-pi_opens'
  | 'relay_device_connections' | 'relay_machine_connections' | 'relay_remote_sessions' | 'relay_turns_started'

let warnedAt = 0
/** Older clients still contribute totals. These are events, never distinct users or installations. */
export async function recordRelayUsage(userId: string, now: Date, metric: RelayUsageMetric): Promise<void> {
  try {
    if (!(await productUsageChoice(userId)).enabled) return
    const dayUtc = new Date(Math.floor(now.getTime() / DAY) * DAY)
    const where = { dayUtc_metric: { dayUtc, metric } }
    try {
      await prisma.productUsageTotal.upsert({ where, create: { dayUtc, metric, value: 1 }, update: { value: { increment: 1 } } })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      await prisma.productUsageTotal.update({ where, data: { value: { increment: 1 } } })
    }
  } catch {
    // Do not let analytics break a session or reach callers that log the account/agent and DB error.
    if (Date.now() - warnedAt >= 60_000) {
      warnedAt = Date.now()
      console.warn('[product-usage] Some aggregate counts are unavailable.')
    }
  }
}

/** These were individual histories, not anonymous totals. The existing delete control must cover them. */
export async function deleteLegacyProductUsage(userId: string): Promise<void> {
  await Promise.all([
    prisma.userDailyPresence.deleteMany({ where: { userId } }),
    prisma.userDailyClientPresence.deleteMany({ where: { userId } }),
    prisma.userDailyRemoteUsage.deleteMany({ where: { userId } }),
    prisma.userDailyDevicePresence.deleteMany({ where: { userId } }),
    prisma.machineDailyPresence.deleteMany({ where: { userId } }),
    prisma.agentDailyPresence.deleteMany({ where: { userId } }),
  ])
}

/** Run only in the singleton worker. Expiry is enforced by Mongo, including during application downtime. */
export async function ensureProductUsageExpiry(): Promise<void> {
  for (const [collection, field, seconds] of [
    ['product_usage_receipts', 'expiresAt', 0],
    ['product_usage_totals', 'dayUtc', 396 * DAY / 1000],
    ...['user_daily_presence', 'user_daily_client_presence', 'user_daily_remote_usage', 'user_daily_device_presence',
      'machine_daily_presence', 'agent_daily_presence', 'analytics_daily_buckets', 'analytics_daily_machines']
      .map(name => [name, 'dayUtc', PRODUCT_USAGE_DAYS * DAY / 1000]),
  ] as [string, string, number][]) {
    await prisma.$runCommandRaw({ createIndexes: collection, indexes: [{ key: { [field]: 1 }, name: 'product_usage_expiry', expireAfterSeconds: seconds }] })
  }
}
