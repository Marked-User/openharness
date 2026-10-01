/**
 * `ensureHarnessGrid` against a fake `grid` first on PATH — the same seam `gridCommand.spec.ts`
 * uses, for the same reason: the real binary talks to a control plane, and the questions worth
 * asking here are all about which argv this module sends and what it believes about the answer.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeGrid, type FakeGrid, type FakeGridPlan, type FakeGridTurn as Turn } from './__fixtures__/fakeGrid.js'

let fake: FakeGrid | null = null
afterEach(() => {
  fake?.dispose()
  fake = null
  // One test below points HARNESS_GRID_BIN at nothing by hand, with no fake to dispose of.
  delete process.env.HARNESS_GRID_BIN
})

/** The fake `grid` from `__fixtures__/fakeGrid.ts`, remembered so `afterEach` can dispose of it. */
function fakeGrid(plan: FakeGridPlan): FakeGrid {
  fake = installFakeGrid(plan)
  return fake
}

const VERSION_OK: Turn = { stdout: 'grid 0.3.46\n' }
const rows = (...names: string[]): string =>
  JSON.stringify(names.map((n) => ({ grid: n, type: 'permissioned-public', id: `grid-${n}` })))

/** Every wait a retry asked for, in order — the retries never really sleep in a test. */
let slept: number[] = []

async function ensure(name = 'someone-7f3a91c4') {
  const { ensureHarnessGrid } = await import('./gridEnsure.js')
  slept = []
  return ensureHarnessGrid(name, { sleep: async (ms) => { slept.push(ms) } })
}

/** What the public CLI prints for a control-plane refusal — `remote/control_plane._raise`, whose format
 *  is a contract there (`cli/auth._SESSION_EXPIRED_RE` anchors on it) — around grid-apis' 402 body. */
const QUOTA_MESSAGE = 'Free plan allows one network, and a network deleted in the last 30 days still counts. ' +
  'You can create a new one from 2026-10-31 14:13 UTC, or upgrade to create one now'
const QUOTA_REFUSAL = 'POST https://api-grid.autonomous.ai/v1/grid/managed-networks failed (402): ' +
  JSON.stringify({ detail: { error_code: 'free_network_limit', message: QUOTA_MESSAGE } }) + '\n'

describe('ensureHarnessGrid', () => {
  it('creates the grid when the account has none, as a private permissioned-public one', async () => {
    const fake = fakeGrid({
      version: VERSION_OK,
      sync: {},
      ls: { stdout: rows('something-else') },
      start: {},
    })
    expect(await ensure()).toEqual({ status: 'created', message: '' })
    const start = fake.calls().find((c) => c.includes('start'))
    // The type is the whole safety property: `permissioned-providers` would open the grid to
    // strangers and switch billing on.
    expect(start).toEqual(['--remote', 'start', 'someone-7f3a91c4', '--type', 'permissioned-public'])
  })

  it('syncs AGAIN after creating, so the new grid has its access token', async () => {
    // A just-created grid has no per-grid token locally; `grid info --env` and `grid join` both
    // refuse until a refresh. Measured against the real control plane.
    const fake = fakeGrid({ version: VERSION_OK, sync: {}, ls: { stdout: rows() }, start: {} })
    expect((await ensure()).status).toBe('created')
    const verbs = fake.calls().map((c) => c.find((a) => a !== '--remote'))
    expect(verbs.filter((v) => v === 'sync').length).toBe(2)
    expect(verbs.lastIndexOf('sync')).toBeGreaterThan(verbs.indexOf('start'))
  })

  it('does nothing when the grid is already there', async () => {
    const fake = fakeGrid({ version: VERSION_OK, sync: {}, ls: { stdout: rows('someone-7f3a91c4') } })
    expect(await ensure()).toEqual({ status: 'existed', message: '' })
    expect(fake.calls().some((c) => c.includes('start'))).toBe(false)
  })

  it('syncs BEFORE looking, so a grid another machine made is seen', async () => {
    const fake = fakeGrid({ version: VERSION_OK, sync: {}, ls: { stdout: rows('someone-7f3a91c4') } })
    await ensure()
    const order = fake.calls().map((c) => c.find((a) => a !== '--remote'))
    expect(order.indexOf('sync')).toBeLessThan(order.indexOf('ls'))
  })

  it('adopts rather than duplicating when another machine won the create race', async () => {
    // The control plane rejects a duplicate name, and the refusal is prose — so this is resolved by
    // looking again, not by reading the error.
    const fake = fakeGrid({
      version: VERSION_OK,
      sync: {},
      ls: [{ stdout: rows() }, { stdout: rows('someone-7f3a91c4') }],
      start: { exit: 1, stderr: 'POST …/managed-networks failed (409): name already taken\n' },
    })
    expect(await ensure()).toEqual({ status: 'adopted', message: '' })
    expect(fake.calls().filter((c) => c.includes('sync')).length).toBe(2)
  })

  it('reports grid’s own words when the create really failed', async () => {
    fakeGrid({
      version: VERSION_OK,
      sync: {},
      ls: { stdout: rows() },
      start: { exit: 1, stderr: 'the control plane is unreachable\n' },
    })
    const result = await ensure()
    expect(result.status).toBe('failed')
    expect(result.message).toContain('control plane is unreachable')
  })

  it('retries a failed create with backoff before saying it failed', async () => {
    // A create that fails for a reason that can pass (the server low on memory, a restart, a network
    // blip) is asked again, waiting longer each time — no longer reported failed at the first refusal.
    const fake = fakeGrid({
      version: VERSION_OK,
      sync: {},
      ls: { stdout: rows() },
      start: { exit: 1, stderr: 'POST …/managed-networks failed (503): {"detail":"The server is low on memory right now"}\n' },
    })
    const result = await ensure()
    expect(result.status).toBe('failed')
    expect(fake.calls().filter((c) => c.includes('start')).length).toBe(3)
    expect(slept).toEqual([2_000, 5_000])
  })

  it('creates the grid when a retry succeeds', async () => {
    const fake = fakeGrid({
      version: VERSION_OK,
      sync: {},
      ls: { stdout: rows() },
      start: [{ exit: 1, stderr: 'the control plane is unreachable\n' }, {}],
    })
    expect(await ensure()).toEqual({ status: 'created', message: '' })
    expect(fake.calls().filter((c) => c.includes('start')).length).toBe(2)
    expect(slept).toEqual([2_000])
  })

  it('shows the Free plan’s refusal instead of retrying it', async () => {
    // A 402 `free_network_limit` is the owner's plan, not a bad minute: asking again cannot succeed, so
    // it is never retried, and the person reads the control plane's own sentence — which says when a new
    // grid becomes possible — rather than the CLI's raw request line around it.
    const fake = fakeGrid({ version: VERSION_OK, sync: {}, ls: { stdout: rows() }, start: { exit: 1, stderr: QUOTA_REFUSAL } })
    expect(await ensure()).toEqual({ status: 'refused', message: QUOTA_MESSAGE })
    expect(fake.calls().filter((c) => c.includes('start')).length).toBe(1)
    expect(slept).toEqual([])
  })

  it('skips, without touching the grid, when the binary is older than the floor', async () => {
    const fake = fakeGrid({ version: { stdout: 'grid 0.3.34\n' } })
    const result = await ensure()
    expect(result.status).toBe('skipped')
    expect(result.message).toContain('0.3.36')
    expect(fake.calls().some((c) => c.includes('start'))).toBe(false)
  })

  it('skips when there is no grid at all, and never throws', async () => {
    process.env.HARNESS_GRID_BIN = join(tmpdir(), 'definitely-not-a-grid-binary')
    const result = await ensure()
    expect(result.status).toBe('skipped')
  })

  it('refuses an empty name rather than creating a grid called nothing', async () => {
    fakeGrid({ version: VERSION_OK })
    expect((await ensure('   ')).status).toBe('skipped')
  })
})

describe('quotaRefusal', () => {
  it('reads the control plane’s sentence out of the CLI’s refusal line', async () => {
    const { quotaRefusal } = await import('./gridEnsure.js')
    expect(quotaRefusal(QUOTA_REFUSAL)).toBe(QUOTA_MESSAGE)
    expect(quotaRefusal(`some warning first\n${QUOTA_REFUSAL}`)).toBe(QUOTA_MESSAGE)
  })

  it('is not fooled by another refusal', async () => {
    const { quotaRefusal } = await import('./gridEnsure.js')
    expect(quotaRefusal('POST …/managed-networks failed (402): {"detail":"Insufficient balance"}')).toBeNull()
    expect(quotaRefusal('POST …/managed-networks failed (409): {"detail":"You already have a network with this name"}')).toBeNull()
    expect(quotaRefusal('POST …/managed-networks failed (503): {"detail":{"error_code":"free_network_limit"}}')).toBeNull()
    expect(quotaRefusal('the control plane is unreachable')).toBeNull()
  })

  it('still knows the refusal when the CLI cut the body short', async () => {
    // The CLI keeps the first 400 characters of a body, so a long sentence can arrive as broken JSON.
    // The code is near the front and still decides; the person then gets a sentence of our own.
    const { quotaRefusal } = await import('./gridEnsure.js')
    const cut = QUOTA_REFUSAL.slice(0, QUOTA_REFUSAL.indexOf('You can'))
    expect(quotaRefusal(cut)).toMatch(/Free plan/)
  })
})
