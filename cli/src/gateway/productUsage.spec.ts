import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
afterEach(() => { usage.stop(); rmSync(dir, { recursive: true, force: true }) })
const totals = () => {
  const result: Record<string, number> = {}
  for (const report of sent as { counters: Record<string, number> }[]) for (const [k, v] of Object.entries(report.counters)) result[k] = (result[k] ?? 0) + v
  return result
}

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
  await usage.sync(); const first = structuredClone(sent[0]); usage.stop()
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
  expect(totals()).toMatchObject({ working_installation_days: 3, repeat_work_installation_days: 2,
    first_work_installations: 1, weekly_working_installations: 2, weekly_returning_installations: 1, turns_interrupted: 1 })
})

it('treats unknown preference and unavailable servers as missing coverage', async () => {
  request.mockResolvedValue({ status: 503, body: {} })
  await usage.sync(); usage.observe('turn_started', 'a', false)
  expect(sent).toHaveLength(0)
})

it('rebuilds a persisted report from its allowlist, removing content injected into local storage', async () => {
  usage.stop()
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
  usage.stop(true)
  expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull()
  expect(JSON.parse(readFileSync(file, 'utf8')).days).toEqual({})
})

it('ignores an oversized local file and starts a bounded queue', async () => {
  usage.stop(); writeFileSync(file, ' '.repeat(100_000))
  usage = createProductUsage({ file, now: () => now, request })
  await usage.sync(); usage.observe('turn_started', 'a', false); await usage.sync()
  expect(totals().turns_started).toBe(1)
  expect(readFileSync(file).length).toBeLessThan(64 * 1024)
})
