/** Shared by the write path (lib/productUsage.ts) and the report (analytics/): no imports, so
 * `npm run usage:daily` loads without the server's environment. */
export const ACTIVITY_SURFACES = ['desktop', 'tui', 'harness-os', 'harness-os-pi', 'mobile', 'web'] as const
export type ActivitySurface = typeof ACTIVITY_SURFACES[number]
/** Marks live past D7: cohort C's D7 is computed during C+8, with the hourly rollup's slack. */
export const ACTIVITY_DAYS = 10
