/** Fixed vocabulary only. Keep the CLI copy identical; conformance is tested. */
export const PRODUCT_USAGE_VERSION = 1
export const PRODUCT_USAGE_DAYS = 35
export const PRODUCT_USAGE_MAX_COUNT = 100_000
export const PRODUCT_USAGE_METRICS = [
  'active_installation_days', 'working_installation_days', 'first_work_installations',
  'repeat_work_installation_days', 'weekly_working_installations', 'weekly_returning_installations',
  'turns_started', 'turns_ended', 'turns_interrupted',
  'duration_under_10s', 'duration_10s_to_1m', 'duration_1m_to_5m', 'duration_over_5m',
  'desktop_opens', 'tui_opens',
] as const
export type ProductUsageMetric = typeof PRODUCT_USAGE_METRICS[number]
export interface ProductUsageReport {
  schemaVersion: 1
  revision: number
  id: string
  day: string
  counters: Partial<Record<ProductUsageMetric, number>>
}
export interface ProductUsageChoice { enabled: boolean; revision: number }
