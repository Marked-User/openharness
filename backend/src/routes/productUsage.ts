import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ingestProductUsage, productUsageChoice, setProductUsageChoice } from '../lib/productUsage.js'
import { PRODUCT_USAGE_MAX_COUNT, PRODUCT_USAGE_METRICS } from '../types/productUsage.js'
import { sendError, sendSuccess } from '../utils/response.js'

export const productUsageReportSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), id: z.uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counters: z.partialRecord(z.enum(PRODUCT_USAGE_METRICS), z.number().int().min(0).max(PRODUCT_USAGE_MAX_COUNT)),
})
const choiceSchema = z.strictObject({ enabled: z.boolean() })

export async function productUsageRoutes(app: FastifyInstance): Promise<void> {
  // Parser errors can contain a piece of malformed JSON. Keep this plugin's errors out of the
  // generic logger/response handler, including failures before the route's schema check runs.
  app.setErrorHandler((error, _req, reply) => {
    const code = (error as { statusCode?: number } | null)?.statusCode
    const status = code && code >= 400 && code < 500 ? code : 503
    return sendError(reply, 'Product usage request unavailable', 'USAGE_UNAVAILABLE', status)
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
  app.post('/api/product-usage/report', { bodyLimit: 4096 }, async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const parsed = productUsageReportSchema.safeParse(req.body)
    // Never reflect rejected fields, values or raw validation errors into logs or responses.
    if (!parsed.success) return sendError(reply, 'Invalid usage report', 'INVALID_USAGE_REPORT', 400)
    try { return sendSuccess(reply, await ingestProductUsage(req.user.sub, parsed.data)) }
    catch { return sendError(reply, 'Usage report unavailable', 'USAGE_UNAVAILABLE', 503) }
  })
}
