/** USAGE_PERF=1 E2E_BUNDLE=1. Run alone: real isolated daemon, fake engine/backend, same workload off/on/stalled. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon } from './harness/fleet.js'
import { harnessdProcesses } from './harness/endurance.js'

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? null

it.runIf(process.env.USAGE_PERF === '1')('measures the core and gateway while reporting is off, on, or unable to answer', async () => {
  const bundle = process.env.E2E_BUNDLE_PATH
  if (!bundle) throw Error('Use E2E_BUNDLE=1 or E2E_BUNDLE_PATH')
  const seconds = Number(process.env.USAGE_PERF_SECONDS ?? 65)
  if (!Number.isInteger(seconds) || seconds < 65 || seconds > 180) throw Error('Use 65–180 seconds so a report flush occurs')
  const output = resolve(process.env.USAGE_PERF_REPORT ?? '../.harness/measurement-coverage/daemon-after.json')
  const results: unknown[] = []
  const report = () => {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify({ source: process.env.USAGE_PERF_SOURCE ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CLI_ROOT, encoding: 'utf8' }).trim(),
      bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'), node: process.version,
      workload: { seconds, agents: 1, turnEveryMs: 1500, requestEveryMs: 125, requests: ['agents_list', 'agent_recent', 'session_search'] },
      machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length },
      limits: 'One run per state, loopback backend and fake engine; descriptive, not a production SLO or a real model latency benchmark.', results }, null, 2) + '\n')
  }
  for (const mode of ['off', 'on', 'stalled'] as const) {
    const backend = await FakeBackend.start()
    backend.productUsage = { enabled: mode !== 'off', revision: 0, reports: [], stallReports: mode === 'stalled' }
    const spec = { machineId: 'b7'.repeat(16), computerId: 'synthetic-usage-performance', name: 'fixture', token: 'synthetic-token' }
    backend.addMachine(spec)
    const artifact = mkdtempSync(join(tmpdir(), 'harness-usage-perf-')), token = randomUUID()
    const preload = fileURLToPath(new URL('./harness/corePerf.cjs', import.meta.url))
    const daemon = await signedInDaemon(backend, spec, { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      HARNESS_E2E_PERF_GATEWAY: '1', HARNESS_E2E_PERF_DIR: artifact, HARNESS_E2E_PERF_TOKEN: token })
    let client: LocalClient | undefined
    try {
      await daemon.start()
      await until('collector checked the synthetic choice', () => backend.seen.includes('GET /api/product-usage/settings') || null, 45000)
      client = await LocalClient.connect(daemon, { machineId: spec.machineId })
      const launched = await client.request('agent_create', { engine: 'claude', cwd: daemon.projectsDir, bypassPermission: true }, 90000)
      const id = launched.agent.id
      await until('synthetic agent ready', async () => {
        const list = await client!.request('agents_list', {})
        return list.agents.some((a: { id: string; sessionId?: string }) => a.id === id && a.sessionId) || null
      }, 45000)
      const pids = harnessdProcesses(daemon)
      const probes = await Promise.all(['core', 'gateway'].map(async name => {
        const pid = pids.get(name)!
        const file = join(artifact, `core-${pid}.json`)
        await until(`${name} probe`, () => existsSync(file) || null, 10000)
        const { port } = JSON.parse(readFileSync(file, 'utf8')) as { port: number }
        return { name, call: async (action: string) => {
          const response = await fetch(`http://127.0.0.1:${port}/${action}`, { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-harness-perf-token': token }, body: JSON.stringify({ label: mode }), signal: AbortSignal.timeout(5000) })
          expect(response.ok).toBe(true)
          return response.json()
        } }
      }))
      await sleep(3000)
      await Promise.all(probes.map(p => p.call('start')))
      const start = performance.now(), latency: number[] = [], turns: number[] = [], load = loadavg()
      const requests = (async () => {
        let i = 0
        while (performance.now() - start < seconds * 1000) {
          const type = ['agents_list', 'agent_recent', 'session_search'][i++ % 3]
          const before = performance.now()
          await client!.request(type, { agentId: id, query: 'SYNTHETIC_PRIVATE_QUERY' }, 10000)
          latency.push(performance.now() - before)
          await sleep(125)
        }
      })()
      const working = (async () => {
        while (performance.now() - start < seconds * 1000) {
          const ended = client!.next(f => f.type === 'turn_ended' && f.agentId === id, 30000)
          const before = performance.now()
          client!.send('message', { agentId: id, content: 'SYNTHETIC_PRIVATE_PROMPT' })
          await ended; turns.push(performance.now() - before)
          await sleep(1500)
        }
      })()
      await Promise.all([requests, working])
      const processes = await Promise.all(probes.map(async p => ({ name: p.name, ...await p.call('end') })))
      expect(daemon.coresStarted()).toBe(1)
      expect(turns.length).toBeGreaterThan(0)
      const wire = JSON.stringify(backend.productUsage.reports)
      for (const forbidden of ['SYNTHETIC_PRIVATE', spec.machineId, spec.token, id]) expect(wire).not.toContain(forbidden)
      if (mode === 'on') expect(backend.productUsage.reports.length).toBeGreaterThan(0)
      else expect(backend.productUsage.reports).toHaveLength(0)
      results.push({ mode, processes, requests: latency.length, rpcMs: { p50: percentile(latency, .5), p95: percentile(latency, .95), p99: percentile(latency, .99) },
        turns: turns.length, fakeTurnMs: { p50: percentile(turns, .5), p95: percentile(turns, .95) }, reports: backend.productUsage.reports.length,
        reportBytes: backend.productUsage.reports.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0), loadAverage: { start: load, end: loadavg() } })
      report()
    } finally { client?.close(); await daemon.close(); await backend.close() }
  }
}, 900000)
