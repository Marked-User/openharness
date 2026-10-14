/**
 * The grid reader against REAL answers, in the shapes `grid-protocol` defines (grid-platform ticket 12).
 *
 * `gridProtocol.ts` is generated in the public autonomous-grid repository from the wire contract's JSON
 * Schemas and copied here whole; the reader takes its paths, codes and field names from it. The fixtures are
 * that repository's recordings — answers taken from the DEV VM without a credential (or from a server's own
 * code where DEV cannot produce one), sanitized — so what is read here is what a grid actually sends, not
 * what a test author remembered it sending.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DISCOVER_PATH, GRID_ASLEEP_CODE, LAST_KNOWN_MAX_AGE_SECONDS, MODEL_RETENTION_SECONDS, OVERVIEW_PATH, REFUSAL_STATUS,
} from './gridProtocol.js'
import { readDiscoveryIds, readOverview } from './gridReader.js'
import { GRID_LAST_KNOWN_MAX_AGE_MS, GRID_MODEL_RETENTION_MS } from './gridPicture.js'

interface Recording { schema: string; definition: string | null; status: number; body: Record<string, unknown> }

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__', 'protocol')
const recording = (name: string): Recording =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Recording

/** A grid that answers each path with one recording, as the proxy in front of the master would. */
let server: Server, base: string
const routes = new Map<string, Recording>()

beforeAll(async () => {
  server = createServer((request, response) => {
    const found = routes.get(request.url ?? '')
    response.writeHead(found?.status ?? 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(found?.body ?? { detail: 'unknown network' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/g`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const serve = (path: string, name: string): void => { routes.set(`/g${path}`, recording(name)) }

describe('the reader speaks the protocol', () => {
  it('keeps a model and a last-known record exactly as long as the contract says', () => {
    expect(GRID_MODEL_RETENTION_MS).toBe(MODEL_RETENTION_SECONDS * 1000)
    expect(GRID_LAST_KNOWN_MAX_AGE_MS).toBe(LAST_KNOWN_MAX_AGE_SECONDS * 1000)
  })
})

describe('real answers', () => {
  it('reads an awake grid off a real overview', async () => {
    serve(OVERVIEW_PATH, 'overview--root--awake-starter-engine')

    const read = await readOverview(base)

    expect(read.kind).toBe('awake')
    if (read.kind !== 'awake') return
    expect(read.nodes).toEqual([{
      name: 'node-a', engine: 'starter', models: ['deepseek/deepseek-v4-flash-0731', 'qwen/qwen3.8-27b'],
      providerEmail: 'provider@example.com',
    }])
    expect(read.curatedIds).toEqual(['deepseek/deepseek-v4-flash-0731', 'qwen/qwen3.8-27b'])
    expect(read.windows['qwen/qwen3.8-27b']).toBe(1_000_000)
  })

  it('reads a sleeping grid and what it last served off a real asleep answer', async () => {
    const answer = recording('refusal--GridAsleep--overview-with-last-known')
    expect(answer.status).toBe(REFUSAL_STATUS[GRID_ASLEEP_CODE])
    serve(OVERVIEW_PATH, 'refusal--GridAsleep--overview-with-last-known')

    const read = await readOverview(base)

    expect(read.kind).toBe('asleep')
    if (read.kind !== 'asleep') return
    expect(read.lastKnown?.nodes.map((node) => node.name)).toEqual(['node-a'])
    expect(read.lastKnown?.ids).toContain('qwen/qwen3.8-27b')
    expect(read.lastKnown?.ageSeconds).toBeGreaterThanOrEqual(0)
  })

  it.each([
    ['a grid its owner stopped', 'refusal--GridStopped--in-process'],
    ['a deleted grid', 'refusal--GridDeleted--overview'],
  ])('reads %s as not answering — never asleep, never awake', async (_label, name) => {
    serve(OVERVIEW_PATH, name)

    expect(await readOverview(base)).toEqual({ kind: 'unanswered' })
  })

  it('spells each model exactly as its engine does, off a real discovery', async () => {
    serve(DISCOVER_PATH, 'discover--root--awake-starter-engine')

    expect(await readDiscoveryIds(base)).toEqual(['deepseek/deepseek-v4-flash-0731', 'qwen/qwen3.8-27b'])
  })
})
