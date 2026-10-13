import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { readProductUsage } from './readProductUsage.js'

function mockDb(result: unknown = []) {
  const aggregateRaw = vi.fn().mockResolvedValue(result)
  const models = ['user', 'userDailyPresence', 'userDailyClientPresence', 'userDailyDevicePresence', 'userDailyRemoteUsage',
    'machineDailyPresence', 'agentDailyPresence', 'analyticsDailyBucket']
  return { aggregateRaw, db: Object.fromEntries(models.map(m => [m, { aggregateRaw }])) as unknown as PrismaClient }
}

describe('read-only usage extraction', () => {
  it('bounds every query and projects only usage fields, with an exclusive UTC cutoff', async () => {
    const { db, aggregateRaw } = mockDb()
    const result = await readProductUsage(db, { asOf: '2026-10-10', days: 30 })
    expect(result.historyFrom).toBe('2026-07-12')
    expect(result.coverage.collector).toEqual({ rows: 0, firstDay: null, lastDay: null })
    expect(aggregateRaw).toHaveBeenCalledTimes(15)
    for (const [args] of aggregateRaw.mock.calls) {
      expect(args.options).toEqual({ maxTimeMS: 15000, allowDiskUse: false })
      expect(args.pipeline.at(-1)).toEqual({ $limit: 100001 })
      expect(JSON.stringify(args)).not.toMatch(/\$out|\$merge|passwordHash|apiKey|externalId|hostname/)
      expect(JSON.stringify(args.pipeline[0])).toContain('2026-10-10T00:00:00.000Z')
    }
    expect(aggregateRaw.mock.calls[0][0].pipeline[1].$project.email).toBeUndefined()
  })

  it('fails rather than silently truncating a large result or accepting a malformed response', async () => {
    await expect(readProductUsage(mockDb(new Array(100001).fill({})).db, { asOf: '2026-10-10', days: 30 })).rejects.toThrow('100,000')
    await expect(readProductUsage(mockDb({ cursor: {} }).db, { asOf: '2026-10-10', days: 30 })).rejects.toThrow('Unexpected')
  })
})
