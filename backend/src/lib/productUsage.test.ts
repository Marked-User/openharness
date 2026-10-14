import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  productUsagePreference: { findUnique: vi.fn(), upsert: vi.fn() },
  analyticsMachineState: { findFirst: vi.fn() },
  productUsageReceipt: { create: vi.fn(), findUnique: vi.fn() },
  productUsageTotal: { upsert: vi.fn(), update: vi.fn() },
  userDailyPresence: { deleteMany: vi.fn() }, userDailyClientPresence: { deleteMany: vi.fn() },
  userDailyRemoteUsage: { deleteMany: vi.fn() }, userDailyDevicePresence: { deleteMany: vi.fn() },
  machineDailyPresence: { deleteMany: vi.fn() }, agentDailyPresence: { deleteMany: vi.fn() },
  $transaction: vi.fn(), $runCommandRaw: vi.fn(),
}))
vi.mock('./prisma.js', () => ({ prisma: db }))
import { deleteLegacyProductUsage, ensureProductUsageExpiry, ingestProductUsage, ingestSetupUsage, productUsageChoice, recordRelayUsage, setProductUsageChoice } from './productUsage.js'
import type { ProductUsageReport } from '../types/productUsage.js'

const report: ProductUsageReport = { schemaVersion: 1, revision: 0, id: 'cf1c5a03-388c-4265-b5fb-a4c3d47e407f', day: '2026-10-13', counters: { turns_started: 4, turns_ended: 3 } }
const now = new Date('2026-10-13T12:00:00Z')
beforeEach(() => {
  vi.resetAllMocks()
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db))
  db.productUsagePreference.findUnique.mockResolvedValue(null)
  db.analyticsMachineState.findFirst.mockResolvedValue(null)
})

it('keeps the client and server vocabulary identical', () => {
  expect(readFileSync(new URL('../../../cli/src/lib/productUsageContract.ts', import.meta.url), 'utf8'))
    .toBe(readFileSync(new URL('../types/productUsage.ts', import.meta.url), 'utf8'))
})

describe('preference', () => {
  it('defaults on but preserves a prior off choice', async () => {
    expect(await productUsageChoice('private-account')).toEqual({ enabled: true, revision: 0 })
    db.analyticsMachineState.findFirst.mockResolvedValue({ id: 'old-setting' })
    expect(await productUsageChoice('private-account')).toEqual({ enabled: false, revision: 0 })
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 9 })
    expect(await productUsageChoice('private-account')).toEqual({ enabled: false, revision: 9 })
  })
  it('advances the queue generation on every saved choice', async () => {
    await setProductUsageChoice('account', false)
    expect(db.productUsagePreference.upsert.mock.calls[0][0]).toMatchObject({
      create: { userId: 'account', enabled: false, revision: 1 }, update: { enabled: false, revision: { increment: 1 } },
    })
  })
})

describe('aggregate ingestion', () => {
  it('stores only totals and an unlinked receipt, in one transaction', async () => {
    expect(await ingestProductUsage('private-account', report, now)).toEqual({ accepted: true })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(db.productUsageTotal.upsert).toHaveBeenCalledTimes(2)
    expect(db.productUsageTotal.upsert.mock.calls[0][0]).toEqual({
      where: { dayUtc_metric: { dayUtc: new Date('2026-10-13'), metric: 'turns_started' } },
      create: { dayUtc: new Date('2026-10-13'), metric: 'turns_started', value: 4 }, update: { value: { increment: 4 } },
    })
    const stored = JSON.stringify([db.productUsageTotal.upsert.mock.calls, db.productUsageReceipt.create.mock.calls])
    for (const forbidden of ['private-account', 'userId', 'machineId', 'agentId', 'revision', 'counters', 'receivedAt']) expect(stored).not.toContain(forbidden)
  })
  it('rejects opted-out and stale queued uploads without receipts or counters', async () => {
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 1 })
    expect(await ingestProductUsage('a', report, now)).toMatchObject({ accepted: false, reason: 'CHOICE_CHANGED' })
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: true, revision: 2 })
    expect(await ingestProductUsage('a', report, now)).toMatchObject({ accepted: false, reason: 'CHOICE_CHANGED' })
    expect(db.productUsageReceipt.create).not.toHaveBeenCalled()
    expect(db.productUsageTotal.upsert).not.toHaveBeenCalled()
  })
  it.each(['2026-09-08', '2026-10-14', '2026-02-30', 'bad'])('refuses expired/future/invalid day %s', async day => {
    expect(await ingestProductUsage('a', { ...report, day }, now)).toEqual({ accepted: false, reason: 'EXPIRED' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
  it('accepts a previously committed receipt without incrementing again', async () => {
    db.productUsageReceipt.create.mockRejectedValue({ code: 'P2002' })
    db.productUsageReceipt.findUnique.mockResolvedValue({ id: report.id })
    expect(await ingestProductUsage('a', report, now)).toEqual({ accepted: true })
    expect(db.productUsageTotal.upsert).not.toHaveBeenCalled()
  })
  it('does not mistake a rolled-back aggregate creation race for a received report', async () => {
    db.productUsageTotal.upsert.mockRejectedValue({ code: 'P2002' })
    db.productUsageReceipt.findUnique.mockResolvedValue(null)
    await expect(ingestProductUsage('a', report, now)).rejects.toMatchObject({ code: 'P2002' })
  })
  it('fails closed when the preference cannot be checked', async () => {
    db.productUsagePreference.findUnique.mockRejectedValue(new Error('unavailable'))
    await expect(ingestProductUsage('a', report, now)).rejects.toThrow()
    expect(db.productUsageReceipt.create).not.toHaveBeenCalled()
  })
})

it('the legacy relay respects off and writes only an aggregate counter when on', async () => {
  db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 1 })
  await recordRelayUsage('private-account', now, 'relay_turns_started')
  expect(db.productUsageTotal.upsert).not.toHaveBeenCalled()
  db.productUsagePreference.findUnique.mockResolvedValue({ enabled: true, revision: 2 })
  await recordRelayUsage('private-account', now, 'relay_turns_started')
  expect(JSON.stringify(db.productUsageTotal.upsert.mock.calls)).not.toContain('private-account')
})

it('a relay metrics failure cannot interrupt work or log an identity or database error', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  db.productUsagePreference.findUnique.mockRejectedValue(new Error('PRIVATE_DATABASE_CANARY'))
  await expect(recordRelayUsage('PRIVATE_ACCOUNT_CANARY', now, 'relay_turns_started')).resolves.toBeUndefined()
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_')
  expect(db.productUsageTotal.upsert).not.toHaveBeenCalled()
  log.mockRestore()
})

it('the legacy delete path erases all six linked activity collections', async () => {
  await deleteLegacyProductUsage('account')
  for (const name of ['userDailyPresence', 'userDailyClientPresence', 'userDailyRemoteUsage', 'userDailyDevicePresence', 'machineDailyPresence', 'agentDailyPresence'] as const)
    expect(db[name].deleteMany).toHaveBeenCalledWith({ where: { userId: 'account' } })
})

it('installs database expiry for receipts, totals and every linked daily history', async () => {
  await ensureProductUsageExpiry()
  expect(db.$runCommandRaw).toHaveBeenCalledTimes(10)
  expect(db.$runCommandRaw.mock.calls[0][0]).toMatchObject({ createIndexes: 'product_usage_receipts', indexes: [{ expireAfterSeconds: 0 }] })
  expect(db.$runCommandRaw.mock.calls[2][0]).toMatchObject({ createIndexes: 'user_daily_presence', indexes: [{ expireAfterSeconds: 35 * 86400 }] })
})

it('setup ingestion never reads an account and expires after yesterday', async () => {
  const setup = { id: report.id, day: report.day, counters: { setup_desktop_sign_in_ok: 1 } }
  expect(await ingestSetupUsage(setup, now)).toEqual({ accepted: true })
  expect(db.productUsagePreference.findUnique).not.toHaveBeenCalled()
  expect(db.analyticsMachineState.findFirst).not.toHaveBeenCalled()
  expect(JSON.stringify(db.productUsageReceipt.create.mock.calls)).not.toContain('setup_desktop')
  expect(await ingestSetupUsage({ ...setup, day: '2026-10-11' }, now)).toMatchObject({ reason: 'EXPIRED' })
  expect(await ingestSetupUsage({ ...setup, day: '2026-10-12' }, now)).toMatchObject({ accepted: true })
})
