import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const methods = vi.hoisted(() => ({ ingestProductUsage: vi.fn(), ingestSetupUsage: vi.fn(), productUsageChoice: vi.fn(), setProductUsageChoice: vi.fn() }))
vi.mock('../lib/productUsage.js', () => methods)
import { productUsageRoutes } from './productUsage.js'
import { PRODUCT_USAGE_METRICS, PRODUCT_USAGE_MAX_COUNT } from '../types/productUsage.js'
let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  vi.resetAllMocks()
  app = Fastify({ logger: false })
  app.addHook('onRequest', async (req: FastifyRequest) => { if (req.headers.authorization === 'fixture') req.user = { sub: 'account' } as typeof req.user })
  await app.register(productUsageRoutes)
  methods.productUsageChoice.mockResolvedValue({ enabled: true, revision: 0 })
  methods.ingestProductUsage.mockResolvedValue({ accepted: true })
  methods.ingestSetupUsage.mockResolvedValue({ accepted: true })
})
afterEach(() => app.close())
const good = { schemaVersion: 1, revision: 0, id: 'cf1c5a03-388c-4265-b5fb-a4c3d47e407f', day: '2026-10-13', counters: { turns_started: 1 } }
const submit = (payload: unknown) => app.inject({ method: 'POST', url: '/api/product-usage/report', headers: { authorization: 'fixture' }, payload: payload as Record<string, unknown> })
it('requires a signed-in account and does not let the report choose its identity', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/product-usage/report', payload: good })).statusCode).toBe(401)
  expect((await submit(good)).statusCode).toBe(200)
  expect(methods.ingestProductUsage).toHaveBeenCalledWith('account', good)
})
it.each([
  { ...good, prompt: 'PRIVATE_CANARY' }, { ...good, userId: 'PRIVATE_CANARY' },
  { ...good, counters: { 'PRIVATE_CANARY': 1 } }, { ...good, counters: { turns_started: 'PRIVATE_CANARY' } },
  { ...good, counters: { turns_started: -1 } }, { ...good, counters: { turns_started: 100001 } },
  { ...good, counters: { turns_started: 1.5 } }, { ...good, id: 'PRIVATE_CANARY' },
])('refuses unknown fields and malformed values without echoing them', async payload => {
  const response = await submit(payload)
  expect(response.statusCode).toBe(400)
  expect(response.body).not.toContain('PRIVATE_CANARY')
  expect(methods.ingestProductUsage).not.toHaveBeenCalled()
})
it('does not reflect a database error or report contents', async () => {
  methods.ingestProductUsage.mockRejectedValue(new Error('PRIVATE_CANARY'))
  const response = await submit(good)
  expect(response.statusCode).toBe(503)
  expect(response.body).not.toContain('PRIVATE_CANARY')
})
it('also sanitizes malformed JSON and oversized bodies before schema validation', async () => {
  for (const payload of ['{"prompt":"PRIVATE_CANARY', JSON.stringify({ prompt: 'PRIVATE_CANARY'.repeat(1000) })]) {
    const response = await app.inject({ method: 'POST', url: '/api/product-usage/report', headers: {
      authorization: 'fixture', 'content-type': 'application/json',
    }, payload })
    expect([400, 413]).toContain(response.statusCode)
    expect(response.body).not.toContain('PRIVATE_CANARY')
    expect(methods.ingestProductUsage).not.toHaveBeenCalled()
  }
})
it('does not expose preference lookup failures', async () => {
  methods.productUsageChoice.mockRejectedValue(new Error('PRIVATE_CANARY'))
  const response = await app.inject({ method: 'GET', url: '/api/product-usage/settings', headers: { authorization: 'fixture' } })
  expect(response.statusCode).toBe(503)
  expect(response.body).not.toContain('PRIVATE_CANARY')
})
it('the visible control changes only the authenticated account', async () => {
  const request = { method: 'POST' as const, url: '/api/product-usage/settings', headers: { authorization: 'fixture' }, payload: { enabled: false } }
  expect((await app.inject(request)).statusCode).toBe(200)
  expect(methods.setProductUsageChoice).toHaveBeenCalledWith('account', false)
  expect((await app.inject({ ...request, payload: { enabled: true, userId: 'another' } })).statusCode).toBe(400)
})

it('the complete vocabulary fits bounded chunks, including the longest metric keys', async () => {
  for (let i = 0; i < PRODUCT_USAGE_METRICS.length; i += 64) {
    const payload = { ...good, counters: Object.fromEntries(PRODUCT_USAGE_METRICS.slice(i, i + 64).map(k => [k, PRODUCT_USAGE_MAX_COUNT])) }
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(8192)
    expect((await submit(payload)).statusCode).toBe(200)
  }
})

const setup = { schemaVersion: 1, consent: true, id: good.id, day: good.day, counters: { setup_desktop_sign_in_started: 1 } }
const sendSetup = (payload: unknown = setup, headers = {}) => app.inject({ method: 'POST', url: '/api/product-usage/setup', payload: payload as Record<string, unknown>, headers })
it('accepts only explicitly enabled setup counts without credentials or account lookup', async () => {
  expect((await sendSetup()).statusCode).toBe(200)
  expect(methods.ingestSetupUsage).toHaveBeenCalledWith(setup)
  expect(methods.productUsageChoice).not.toHaveBeenCalled()
  expect(methods.ingestProductUsage).not.toHaveBeenCalled()
  for (const payload of [{ ...setup, consent: false }, { ...setup, account: 'PRIVATE_CANARY' },
    { ...setup, counters: { turns_started: 1 } }, { ...setup, counters: { setup_desktop_sign_in_started: 1001 } }]) {
    const response = await sendSetup(payload)
    expect(response.statusCode).toBe(400)
    expect(response.body).not.toContain('PRIVATE_CANARY')
  }
  for (const headers of [{ authorization: 'fixture' }, { cookie: 'PRIVATE_CANARY' }]) expect((await sendSetup(setup, headers)).statusCode).toBe(400)
})
it('bounds untrusted setup writes independently of signed-in reports', async () => {
  let finish!: (value: unknown) => void
  methods.ingestSetupUsage.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  // A shared deferred completion releases all four admitted requests.
  const done = new Promise(resolve => { finish = resolve })
  methods.ingestSetupUsage.mockReturnValue(done)
  const pending = Array.from({ length: 4 }, () => sendSetup().then((r: { statusCode: number }) => r.statusCode))
  await vi.waitFor(() => expect(methods.ingestSetupUsage).toHaveBeenCalledTimes(4))
  expect((await sendSetup()).statusCode).toBe(429)
  expect((await submit(good)).statusCode).toBe(200)
  finish({ accepted: true })
  expect(await Promise.all(pending)).toEqual([200, 200, 200, 200])
})

it('feedback reduces a voluntary fixed choice to one unlinked, retry-safe count', async () => {
  const request = { method: 'POST' as const, url: '/api/product-usage/feedback', headers: { authorization: 'fixture' }, payload: { id: good.id, answer: 'useful' } }
  expect((await app.inject(request)).statusCode).toBe(200)
  expect(methods.ingestProductUsage).toHaveBeenCalledWith('account', expect.objectContaining({ id: good.id, revision: 0, counters: { feedback_useful: 1 } }))
  methods.ingestProductUsage.mockClear()
  const bad = await app.inject({ ...request, payload: { ...request.payload, task: 'PRIVATE_CANARY' } })
  expect(bad.statusCode).toBe(400); expect(bad.body).not.toContain('PRIVATE_CANARY')
  methods.productUsageChoice.mockResolvedValue({ enabled: false, revision: 1 })
  expect((await app.inject(request)).statusCode).toBe(409)
  expect(methods.ingestProductUsage).not.toHaveBeenCalled()
})
