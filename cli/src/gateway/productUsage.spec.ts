import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PRODUCT_USAGE_METRICS } from '../lib/productUsageContract.js'
import { createProductUsage, type ProductUsageDeps } from './productUsage.js'

let dir: string, file: string, now: number, enabled: boolean, revision: number
let usage: ReturnType<typeof createProductUsage>
let sent: unknown[], retry: boolean
let request: ReturnType<typeof vi.fn<ProductUsageDeps['request']>>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-product-usage-')); file = join(dir, 'counts.json')
  now = Date.parse('2026-10-12T10:00:00Z'); enabled = true; revision = 0; sent = []; retry = false
  request = vi.fn(async (method: string, _path: string, body?: unknown) => {
    if (method === 'GET') return { status: 200, body: { data: { enabled, revision } } }
    sent.push(structuredClone(body))
    return { status: retry ? 503 : 200, body: { data: { accepted: !retry } } }
  })
  usage = createProductUsage({ file, now: () => now, request })
})
afterEach(async () => { await usage.stop(); rmSync(dir, { recursive: true, force: true }) })
const totals = () => {
  const result: Record<string, number> = {}
  for (const report of sent as { counters: Record<string, number> }[]) for (const [k, v] of Object.entries(report.counters)) result[k] = (result[k] ?? 0) + v
  return result
}

it('keeps first-launch 24-hour value counts on their original cohort day across restart, without an identity', async () => {
  await usage.sync()
  now = Date.parse('2026-10-12T23:30:00Z')
  usage.launch({ id: 'PRIVATE_CREATION_CANARY', phase: 'start' }); await usage.sync(); await usage.stop()
  usage = createProductUsage({ file, now: () => now, request }); await usage.sync()
  now += 2 * 3600000
  usage.observe('turn_started', 'PRIVATE_AGENT_CANARY', false)
  usage.observe('text_delta', 'PRIVATE_AGENT_CANARY', false)
  usage.observe('text_delta', 'PRIVATE_AGENT_CANARY', false)
  usage.observe('turn_ended', 'PRIVATE_AGENT_CANARY', false)
  await usage.sync(); await usage.sync()
  expect(totals()).toMatchObject({ first_launch_installations: 1, first_launch_work_24h_installations: 1, first_launch_response_24h_installations: 1 })
  const cohortReports = (sent as { day: string; counters: Record<string, number> }[]).filter(r => r.counters.first_launch_response_24h_installations)
  expect(cohortReports.map(r => r.day)).toEqual(['2026-10-12'])
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_')
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_')
})

it('does not count late work as first-launch 24-hour value or restart the cohort for another launch', async () => {
  await usage.sync(); usage.launch({ id: 'synthetic-creation-1', phase: 'start' })
  now += 86400001
  usage.launch({ id: 'synthetic-creation-2', phase: 'start' })
  usage.observe('turn_started', 'a', false); usage.observe('text_delta', 'a', false)
  await usage.sync(); await usage.sync()
  expect(totals().first_launch_installations).toBe(1)
  expect(totals().first_launch_response_24h_installations).toBeUndefined()
})

it('collects nothing before it can check the preference, and respects off', async () => {
  usage.observe('turn_started', 'private-agent', false)
  enabled = false
  await usage.sync()
  usage.observe('turn_started', 'private-agent', false)
  usage.opened('desktop'); await usage.sync()
  expect(sent).toEqual([])
})

it('reduces turns locally, excludes replay, and never persists or uploads agent identity', async () => {
  await usage.sync()
  usage.opened('desktop')
  usage.observe('turn_started', 'PRIVATE_CANARY', true)
  usage.observe('turn_started', 'PRIVATE_CANARY', false)
  usage.observe('turn_started', 'PRIVATE_CANARY', false)
  now += 22_000
  usage.observe('turn_ended', 'PRIVATE_CANARY', false)
  usage.observe('turn_ended', 'PRIVATE_CANARY', false)
  await usage.sync()
  expect(totals()).toMatchObject({ active_installation_days: 1, working_installation_days: 1, first_work_installations: 1,
    weekly_working_installations: 1, turns_started: 1, turns_ended: 1, duration_10s_to_1m: 1, desktop_opens: 1 })
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_CANARY')
  expect(sent[0]).not.toHaveProperty('userId')
})

it('keeps the receipt immutable across uncertain responses and process restarts', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true
  await usage.sync(); const first = structuredClone(sent[0]); await usage.stop()
  usage = createProductUsage({ file, now: () => now, request })
  retry = false; await usage.sync()
  expect(sent[1]).toEqual(first)
  expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull()
})

it('drops a pre-opt-out queue even if the next observed choice is on again', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true; await usage.sync()
  revision = 2; retry = false
  await usage.sync()
  expect(sent).toHaveLength(1)
  expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull()
})

it('counts repeat days and consecutive weeks once, independently of event volume', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); usage.observe('turn_ended', 'a', false); await usage.sync()
  now = Date.parse('2026-10-13T10:00:00Z')
  usage.observe('turn_started', 'a', false); usage.observe('turn_ended', 'a', false, true); await usage.sync()
  now = Date.parse('2026-10-19T10:00:00Z')
  usage.observe('turn_started', 'a', false); await usage.sync()
  // Cohort returns use earlier day buckets; the bounded uploader sends one day per sync.
  for (let i = 0; i < 4; i++) await usage.sync()
  expect(totals()).toMatchObject({ working_installation_days: 3, repeat_work_installation_days: 2,
    first_work_installations: 1, weekly_working_installations: 2, weekly_returning_installations: 1, turns_interrupted: 1 })
})

it('treats unknown preference and unavailable servers as missing coverage', async () => {
  request.mockResolvedValue({ status: 503, body: {} })
  await usage.sync(); usage.observe('turn_started', 'a', false)
  expect(sent).toHaveLength(0)
})

it('rebuilds a persisted report from its allowlist, removing content injected into local storage', async () => {
  await usage.stop()
  writeFileSync(file, JSON.stringify({ revision: 0, days: { '2026-10-12': { turns_started: 1, prompt: 'PRIVATE_CANARY' } },
    pending: { schemaVersion: 1, revision: 0, id: 'cf1c5a03-388c-4265-b5fb-a4c3d47e407f', day: '2026-10-12',
      counters: { turns_ended: 1, result: 'PRIVATE_CANARY' }, prompt: 'PRIVATE_CANARY' } }))
  usage = createProductUsage({ file, now: () => now, request })
  await usage.sync(); await usage.sync()
  expect(totals()).toEqual({ turns_ended: 1, turns_started: 1 })
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_CANARY')
})

it('expires pending reports instead of replaying them beyond the server dedupe window', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true; await usage.sync()
  now += 36 * 86400000; retry = false
  await usage.sync()
  expect(sent).toHaveLength(1)
})

it('can discard its queue when the signed-in account changes', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true; await usage.sync()
  await usage.stop(true)
  expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull()
  expect(JSON.parse(readFileSync(file, 'utf8')).days).toEqual({})
})

it('ignores an oversized local file and starts a bounded queue', async () => {
  await usage.stop(); writeFileSync(file, ' '.repeat(300_000))
  usage = createProductUsage({ file, now: () => now, request })
  await usage.sync(); usage.observe('turn_started', 'a', false); await usage.sync()
  expect(totals().turns_started).toBe(1)
  expect(readFileSync(file).length).toBeLessThan(64 * 1024)
})

it('counts first-response latency, silent waits and errors once without reading content', async () => {
  await usage.sync(); usage.observe('turn_started', 'PRIVATE_AGENT', false)
  now += 61_000; await usage.sync(); await usage.sync()
  usage.observe('error', 'PRIVATE_AGENT', false); usage.observe('error', 'PRIVATE_AGENT', false)
  usage.observe('text_delta', 'PRIVATE_AGENT', true)
  usage.observe('text_delta', 'PRIVATE_AGENT', false); usage.observe('text_delta', 'PRIVATE_AGENT', false)
  usage.observe('turn_ended', 'PRIVATE_AGENT', false)
  usage.observe('turn_started', 'another', false); usage.observe('turn_ended', 'another', false)
  await usage.sync()
  expect(totals()).toMatchObject({ turns_waiting_over_1m: 1, turns_with_error: 1, turns_with_response: 1,
    response_1m_to_5m: 1, first_response_installations: 1, turns_ended_without_response: 1 })
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_AGENT')
})

it('attributes D1/D7 return to the original working day, surviving restarts and deduplicating turns', async () => {
  const work = async () => { usage.observe('turn_started', 'a', false); usage.observe('turn_ended', 'a', false); await usage.sync() }
  await usage.sync(); await work(); await usage.stop()
  now += 86400000; usage = createProductUsage({ file, now: () => now, request }); await usage.sync()
  await work(); await work()
  now += 6 * 86400000; await work()
  await usage.sync() // the remaining current-day batch
  const returns = (sent as {day: string; counters: Record<string, number>}[]).filter(r => r.counters.d1_returning_work_installations || r.counters.d7_returning_work_installations)
  expect(returns.map(r => r.day)).toEqual(['2026-10-12', '2026-10-12'])
  expect(totals()).toMatchObject({ d1_returning_work_installations: 1, d7_returning_work_installations: 1 })
})

it('accepts only known scalar counters and stops diagnostics with the privacy choice', async () => {
  await usage.sync(); usage.counter('create_requests'); usage.counter('PRIVATE_CANARY' as never); await usage.sync()
  enabled = false; await usage.sync(); usage.counter('create_failed'); await usage.sync()
  expect(totals()).toEqual({ create_requests: 1, create_installation_days: 1, create_first_installations: 1, measurement_v2_installation_days: 1 })
})

it('counts a read the apps make on their own for reliability only, never as a feature someone used', async () => {
  // agent_recent after every agent update, dsh_list on every connect, the pickers' model lists and
  // session previews: prod's first day read 41,179 "history" requests across 72 "history"
  // installation-days, almost every active one, without anyone opening a history.
  await usage.sync()
  for (const metric of ['history_requests', 'history_ok', 'history_under_1s', 'history_page_requests',
    'store_list_requests', 'model_list_requests', 'model_list_failed'] as const) usage.counter(metric)
  usage.counter('search_requests')
  await usage.sync()
  expect(totals()).toEqual({ measurement_v2_installation_days: 1,
    history_requests: 1, history_ok: 1, history_under_1s: 1, history_page_requests: 1,
    store_list_requests: 1, model_list_requests: 1, model_list_failed: 1,
    search_requests: 1, search_installation_days: 1, search_first_installations: 1 })
})

it('tracks a durable launch through polls without persisting its receipt or counting polls as attempts', async () => {
  await usage.sync()
  const id = 'PRIVATE_CREATION_CANARY'
  usage.launch({ id, phase: 'start' }); usage.launch({ id, phase: 'start' })
  usage.launch({ id, phase: 'pending', wait: 'install' }); usage.launch({ id, phase: 'pending', wait: 'install' })
  now += 65_000
  usage.launch({ id, phase: 'failed', failure: 'setup' }); usage.launch({ id, phase: 'failed', failure: 'setup' })
  await usage.sync()
  expect(totals()).toEqual({ measurement_v2_installation_days: 1, first_launch_installations: 1, launch_started: 1, launch_wait_install: 1, launch_failed: 1, launch_failed_setup: 1, launch_1m_to_5m: 1 })
  expect(JSON.stringify(sent) + readFileSync(file, 'utf8')).not.toContain(id)
})

it('calls an unobserved launch unknown, not failed, and drops launch observations on opt-out', async () => {
  await usage.sync(); usage.launch({ id: 'fixture-creation-one', phase: 'start' })
  now += 16 * 60_000; await usage.sync()
  expect(totals()).toEqual({ measurement_v2_installation_days: 1, first_launch_installations: 1, launch_started: 1, launch_unobserved: 1 })
  usage.launch({ id: 'fixture-creation-two', phase: 'start' }); enabled = false; await usage.sync()
  enabled = true; revision++; await usage.sync()
  usage.launch({ id: 'fixture-creation-two', phase: 'created' }); await usage.sync()
  expect(totals().launch_created).toBeUndefined()
})


it('batches the complete vocabulary below the wire bound without losing counts', async () => {
  await usage.sync()
  for (const metric of PRODUCT_USAGE_METRICS) usage.counter(metric)
  for (let i = 0; i < Math.ceil(PRODUCT_USAGE_METRICS.length / 64) + 3; i++) await usage.sync()
  for (const report of sent) expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(8192)
  for (const metric of PRODUCT_USAGE_METRICS) expect(totals()[metric], metric).toBeGreaterThanOrEqual(1)
  expect(JSON.parse(readFileSync(file, 'utf8')).days).toEqual({})
})

it('counts feature reach and repeat use once per installation day, independently of requests', async () => {
  await usage.sync()
  usage.counter('store_install_requests'); usage.counter('store_install_requests'); await usage.sync()
  await usage.stop()
  usage = createProductUsage({ file, now: () => now, request }); await usage.sync()
  usage.counter('store_install_requests'); await usage.sync()
  now += 86400000
  usage.counter('store_install_requests'); await usage.sync()
  expect(totals()).toMatchObject({ store_install_requests: 4, store_install_installation_days: 2,
    store_install_first_installations: 1, store_install_repeat_installation_days: 1 })
})

it('attributes four-week return to its original day and counts consecutive calendar months', async () => {
  const work = () => { usage.observe('turn_started', 'synthetic', false); usage.observe('turn_ended', 'synthetic', false) }
  await usage.sync(); work(); await usage.sync()
  now += 28 * 86400000; work()
  await usage.sync(); await usage.sync()
  expect(totals()).toMatchObject({ d28_returning_work_installations: 1, monthly_working_installations: 2,
    monthly_returning_installations: 1, reactivated_after_7d_installations: 1 })
  const report = (sent as { day: string; counters: Record<string, number> }[]).find(r => r.counters.d28_returning_work_installations)
  expect(report?.day).toBe('2026-10-12')
})

it('keeps memory and disk bounded during a long reporting outage', async () => {
  await usage.sync()
  for (let day = 0; day < 35; day++) {
    for (const metric of PRODUCT_USAGE_METRICS) usage.counter(metric)
    now += 86400000
  }
  await usage.stop()
  expect(Buffer.byteLength(readFileSync(file))).toBeLessThanOrEqual(256 * 1024)
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).days).length).toBeLessThanOrEqual(35)
})

it('does not upload before persistence or block observers on a slow disk, and fences stop during a save', async () => {
  await usage.stop()
  let release: (() => void) | undefined, writes = 0, block = false
  usage = createProductUsage({ file, now: () => now, request, write: async (_file, data) => {
    writes++
    if (block) await new Promise<void>(resolve => { release = resolve })
    writeFileSync(file, data)
  } })
  await usage.sync(); block = true
  usage.counter('create_requests')
  const flushing = usage.sync()
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const before = writes
  for (let i = 0; i < 1000; i++) usage.counter('create_requests')
  expect(writes).toBe(before)
  expect(sent).toHaveLength(0)
  const stopped = usage.stop(true)
  block = false; release!()
  await stopped; await flushing
  expect(sent).toHaveLength(0)
  expect(JSON.parse(readFileSync(file, 'utf8')).days).toEqual({})
})

it('drops a corrupt oversized pending report without sending an oversized request', async () => {
  await usage.stop()
  writeFileSync(file, JSON.stringify({ revision: 0, pending: {
    schemaVersion: 1, revision: 0, id: '12345678-1234-4234-8234-123456789012', day: '2026-10-12',
    counters: Object.fromEntries(PRODUCT_USAGE_METRICS.map(metric => [metric, 100000])),
  } }))
  usage = createProductUsage({ file, now: () => now, request })
  await usage.sync()
  expect(sent).toHaveLength(0)
  usage.observe('turn_started', 'PRIVATE_AGENT', false); await usage.sync()
  expect(totals().turns_started).toBe(1)
  expect(Buffer.byteLength(JSON.stringify(sent[0]))).toBeLessThan(8192)
})
