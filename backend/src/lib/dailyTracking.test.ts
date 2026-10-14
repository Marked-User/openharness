import { beforeEach, describe, expect, it, vi } from 'vitest'
const record = vi.hoisted(() => vi.fn())
vi.mock('./productUsage.js', () => ({ recordRelayUsage: record }))
import { CLIENT_SURFACES, TUI_SURFACES, presenceTracker, presenceWriteDue, recordRemoteUsage, recordTurnStarted, touchClientOnlineDay, touchDeviceOnlineDay, touchMachineOnlineDay, touchUserOnlineDay } from './dailyTracking.js'

beforeEach(() => { record.mockReset(); record.mockResolvedValue(undefined) })
it('forwards only the choice identity and a fixed metric, never device, agent or location', async () => {
  const now = new Date('2026-10-13T12:00:00Z')
  await touchUserOnlineDay('account', 'PRIVATE_MACHINE', now, { isNewConnection: true })
  await touchClientOnlineDay('account', 'mobile', now, { isNewConnection: true })
  await touchDeviceOnlineDay('account', 'PRIVATE_DEVICE', now, { isNewConnection: true, countryCode: 'VN' })
  await touchMachineOnlineDay('account', 'PRIVATE_MACHINE', now, { isNewConnection: true, countryCode: 'VN' })
  await recordRemoteUsage('account', 'PRIVATE_MACHINE', now)
  await recordTurnStarted('account', 'PRIVATE_MACHINE', 'PRIVATE_AGENT', now)
  expect(record.mock.calls.map(c => c[2])).toEqual(['relay_desktop_opens', 'relay_mobile_opens', 'relay_device_connections', 'relay_machine_connections', 'relay_remote_sessions', 'relay_turns_started'])
  expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE_')
  expect(JSON.stringify(record.mock.calls)).not.toContain('VN')
})
it('idle heartbeats add no analytics records', async () => {
  const now = new Date()
  await touchUserOnlineDay('a', 'm', now, { isNewConnection: false })
  await touchClientOnlineDay('a', 'tui', now, { isNewConnection: false })
  await touchDeviceOnlineDay('a', 'd', now, { isNewConnection: false })
  await touchMachineOnlineDay('a', 'm', now, { isNewConnection: false })
  expect(record).not.toHaveBeenCalled()
})

describe('presenceTracker', () => {
  const floors = { pingFloorMs: 5 * 60_000, openFloorMs: 10_000 }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('writes an open at once, holds pings to the floor, and never two writes at a time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T08:00:00.000Z'))
    const writes: boolean[] = []
    let release: () => void = () => {}
    const write = vi.fn((_now: Date, isNew: boolean) => {
      writes.push(isNew)
      return new Promise<void>((r) => { release = r })
    })
    const touch = presenceTracker(write, vi.fn(), floors)

    touch('open')
    touch('ping') // a write is in flight
    expect(writes).toEqual([true])
    release(); await flush()

    touch('ping') // within the floor
    expect(writes).toEqual([true])
    vi.setSystemTime(new Date('2026-10-07T08:05:00.000Z'))
    touch('ping')
    expect(writes).toEqual([true, false])
    release(); await flush()

    touch('open') // a reconnect storm is not a session per dial
    vi.setSystemTime(new Date('2026-10-07T08:05:05.000Z'))
    touch('open')
    expect(writes).toEqual([true, false, true])
    vi.useRealTimers()
  })

  it('hands a failed write to onError, and the next ping is still due', async () => {
    const onError = vi.fn()
    const write = vi.fn(async () => { throw new Error('mongo down') })
    const touch = presenceTracker(write, onError, floors)
    touch('ping')
    await flush()
    expect(onError).toHaveBeenCalledWith('ping', expect.any(Error))
    touch('ping')
    expect(write).toHaveBeenCalledTimes(2)
  })
})

describe('presenceWriteDue', () => {
  const FIVE_MIN = 5 * 60_000
  const t0 = new Date('2026-09-16T10:00:00.000Z')

  it('is due before anything has been written', () => {
    expect(presenceWriteDue({ dayKey: null, wroteAt: 0 }, t0, FIVE_MIN)).toBe(true)
  })

  it('is not due within the interval on the same UTC day', () => {
    const last = { dayKey: '2026-09-16', wroteAt: t0.getTime() }
    expect(presenceWriteDue(last, new Date(t0.getTime() + 15_000), FIVE_MIN)).toBe(false)
    expect(presenceWriteDue(last, new Date(t0.getTime() + FIVE_MIN - 1), FIVE_MIN)).toBe(false)
  })

  it('is due once the interval has elapsed', () => {
    const last = { dayKey: '2026-09-16', wroteAt: t0.getTime() }
    expect(presenceWriteDue(last, new Date(t0.getTime() + FIVE_MIN), FIVE_MIN)).toBe(true)
  })

  it('is due when the UTC day rolled over, even inside the interval', () => {
    const lateNight = new Date('2026-09-16T23:59:50.000Z')
    const last = { dayKey: '2026-09-16', wroteAt: lateNight.getTime() }
    expect(presenceWriteDue(last, new Date('2026-09-17T00:00:05.000Z'), FIVE_MIN)).toBe(true)
  })
})

it('keeps Harness OS and Orange Pi connections separate without storing identity', async () => {
  expect([...TUI_SURFACES]).toEqual(['tui', 'harness-os', 'harness-os-pi'])
  for (const surface of TUI_SURFACES) expect(CLIENT_SURFACES.has(surface)).toBe(true)
  for (const other of ['desktop', 'mobile', 'web', 'orangepi', '']) expect(TUI_SURFACES.has(other)).toBe(false)
  const now = new Date('2026-10-13T08:00:00.000Z')
  await touchClientOnlineDay('account', 'harness-os', now, { isNewConnection: true })
  await touchClientOnlineDay('account', 'harness-os-pi', now, { isNewConnection: true })
  expect(record.mock.calls).toEqual([
    ['account', now, 'relay_harness-os_opens'], ['account', now, 'relay_harness-os-pi_opens'],
  ])
})
