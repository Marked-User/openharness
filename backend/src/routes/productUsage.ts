import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ingestProductUsage, ingestSetupUsage, productUsageChoice, setProductUsageChoice } from '../lib/productUsage.js'
import { PRODUCT_FEEDBACK, PRODUCT_USAGE_MAX_COUNT, PRODUCT_USAGE_METRICS, PRODUCT_USAGE_SETUP_METRICS } from '../types/productUsage.js'
import { releaseBucket } from '../types/productHealthContract.js'
import { sendError, sendSuccess } from '../utils/response.js'

const contextSchema = z.strictObject({
  surface: z.enum(['cli', 'desktop']),
  release: z.string().max(11).refine(v => v === 'unknown' || releaseBucket(v) === v),
  platform: z.enum(['macos', 'linux', 'windows', 'other']),
  channel: z.enum(['production', 'development']),
})

export const productUsageReportSchema = z.strictObject({
  context: contextSchema.optional(),
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), id: z.uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counters: z.partialRecord(z.enum(PRODUCT_USAGE_METRICS), z.number().int().min(0).max(PRODUCT_USAGE_MAX_COUNT)),
})
const feedbackSchema = z.strictObject({ id: z.uuid(), answer: z.enum(PRODUCT_FEEDBACK) })
const choiceSchema = z.strictObject({ enabled: z.boolean() })
export const setupUsageSchema = z.strictObject({
  schemaVersion: z.literal(1), consent: z.literal(true), id: z.uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counters: z.partialRecord(z.enum(PRODUCT_USAGE_SETUP_METRICS), z.number().int().min(1).max(1000))
    .refine(c => Object.keys(c).length > 0 && Object.keys(c).length <= 32),
})

export async function productUsageRoutes(app: FastifyInstance): Promise<void> {
  // A process-wide budget bounds untrusted pre-sign-in counts without collecting IPs or cookies.
  // Exhaustion loses measurement only; it never shares a gate with sign-in or product traffic.
  let setupWindow = 0, setupRequests = 0, setupInFlight = 0
  // Parser errors can contain a piece of malformed JSON. Keep this plugin's errors out of the
  // generic logger/response handler, including failures before the route's schema check runs.
  app.setErrorHandler((error, _req, reply) => {
    const code = (error as { statusCode?: number } | null)?.statusCode
    const status = code && code >= 400 && code < 500 ? code : 503
    return sendError(reply, 'Product usage request unavailable', 'USAGE_UNAVAILABLE', status)
  })
  app.post('/api/product-usage/setup', { bodyLimit: 4096 }, async (req, reply) => {
    if (req.headers.authorization || req.headers.cookie) return sendError(reply, 'Setup reports must omit credentials', 'INVALID_SETUP_REPORT', 400)
    const parsed = setupUsageSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Invalid setup report', 'INVALID_SETUP_REPORT', 400)
    const minute = Math.floor(Date.now() / 60_000)
    if (minute !== setupWindow) { setupWindow = minute; setupRequests = 0 }
    if (setupRequests >= 120 || setupInFlight >= 4) return sendError(reply, 'Setup measurement busy', 'USAGE_UNAVAILABLE', 429)
    setupRequests++; setupInFlight++
    try { return sendSuccess(reply, await ingestSetupUsage(parsed.data)) }
    catch { return sendError(reply, 'Setup measurement unavailable', 'USAGE_UNAVAILABLE', 503) }
    finally { setupInFlight-- }
  })
  app.get('/api/product-usage/settings', async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    return sendSuccess(reply, await productUsageChoice(req.user.sub))
  })
  app.post('/api/product-usage/settings', { bodyLimit: 128 }, async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const parsed = choiceSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Invalid usage preference', 'INVALID_USAGE_PREFERENCE', 400)
    return sendSuccess(reply, await setProductUsageChoice(req.user.sub, parsed.data.enabled))
  })
  app.post('/api/product-usage/feedback', { bodyLimit: 256 }, async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const parsed = feedbackSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Invalid feedback', 'INVALID_FEEDBACK', 400)
    const choice = await productUsageChoice(req.user.sub)
    if (!choice.enabled) return sendError(reply, 'Product usage sharing is off', 'SHARING_DISABLED', 409)
    const result = await ingestProductUsage(req.user.sub, { schemaVersion: 1, revision: choice.revision,
      id: parsed.data.id, day: new Date().toISOString().slice(0, 10), counters: { [`feedback_${parsed.data.answer}`]: 1 } })
    return sendSuccess(reply, result)
  })
  app.post('/api/product-usage/report', { bodyLimit: 8192 }, async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const parsed = productUsageReportSchema.safeParse(req.body)
    // Never reflect rejected fields, values or raw validation errors into logs or responses.
    if (!parsed.success) return sendError(reply, 'Invalid usage report', 'INVALID_USAGE_REPORT', 400)
    try { return sendSuccess(reply, await ingestProductUsage(req.user.sub, parsed.data)) }
    catch (error) {
      // A fixed category can diagnose delivery without exposing database errors or report contents.
      const storageCode = (error as { code?: unknown } | null)?.code
      const code = storageCode === 'P2034' || storageCode === 'P2002' ? 'USAGE_WRITE_CONFLICT'
        : storageCode === 'P2028' ? 'USAGE_TRANSACTION_FAILED' : 'USAGE_UNAVAILABLE'
      return sendError(reply, 'Usage report unavailable', code, 503)
    }
  })
}
