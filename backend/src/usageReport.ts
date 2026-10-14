import { PrismaClient } from '@prisma/client'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { productUsageReport, validateOptions } from './analytics/productUsage.js'
import { readProductUsage } from './analytics/readProductUsage.js'

async function main() {
  const { values } = parseArgs({ options: {
    days: { type: 'string', default: '30' }, 'as-of': { type: 'string' },
    'exclude-email-domain': { type: 'string', multiple: true }, out: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('READ_ONLY_DATABASE_URL=<secret> npm run usage:report -- [--days 30] [--as-of YYYY-MM-DD] [--exclude-email-domain example.com] [--out report.json]\nThe cutoff is exclusive (UTC). Output contains aggregates only. Existing output files are not overwritten.')
    return
  }
  const today = new Date().toISOString().slice(0, 10)
  const opts = { days: Number(values.days), asOf: values['as-of'] ?? today, excludeEmailDomains: values['exclude-email-domain'] }
  validateOptions(opts)
  if (opts.asOf > today) throw new Error('as-of cannot be later than today; only complete UTC days are reported')
  const rawUrl = process.env.READ_ONLY_DATABASE_URL
  if (!rawUrl) throw new Error('Set READ_ONLY_DATABASE_URL to a read-only MongoDB connection; credentials are never accepted as command arguments')
  // Do not load .env or the server's default DATABASE_URL, which may carry write credentials.
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('READ_ONLY_DATABASE_URL is not a valid MongoDB URL') }
  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol)) throw new Error('A MongoDB URL is required')
  url.searchParams.set('connectTimeoutMS', '10000')
  url.searchParams.set('serverSelectionTimeoutMS', '10000')
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  try {
    const data = await readProductUsage(db, opts)
    const report = { generatedAt: new Date().toISOString(), ...productUsageReport(data, opts) }
    const json = JSON.stringify(report, null, 2) + '\n'
    if (values.out) await writeFile(values.out, json, { mode: 0o600, flag: 'wx' })
    else process.stdout.write(json)
  } finally { await db.$disconnect() }
}

main().catch(error => {
  // Driver diagnostics can contain the URI. Only our validation messages and a driver code are safe.
  const known = error instanceof Error && (error.message.startsWith('asOf ') || error.message.startsWith('as-of ') ||
    error.message.startsWith('days ') || error.message.startsWith('Set READ_ONLY_') ||
    error.message.startsWith('READ_ONLY_DATABASE_URL ') || error.message === 'A MongoDB URL is required' ||
    error.message.startsWith('Usage query exceeded ') || error.message === 'Unexpected database aggregation response')
  console.error(known ? error.message : `Usage report failed (${String(error?.code ?? error?.name ?? 'unknown error').replace(/[^A-Za-z0-9_]/g, '')}); no report was produced.`)
  process.exitCode = 1
})
