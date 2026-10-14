import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

// `npm run usage:daily` runs with only DATABASE_URL (docs/product-measurement.md). Its analytics modules
// must not pull in the server's env validation, which exits without the billing key.
it('the report analytics load without the server environment', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HARNESS_') && k !== 'NODE_ENV'))
  const cwd = fileURLToPath(new URL('../..', import.meta.url))
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e',
    "await import('./src/analytics/peopleCounters.ts'); await import('./src/analytics/dailyProductPeople.ts'); console.log('loaded')"],
  { cwd, env, encoding: 'utf8' })
  expect(out.trim()).toBe('loaded')
}, 30_000)
