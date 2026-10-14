/** Fixed vocabulary only. Keep the CLI copy identical; conformance is tested. */
export const PRODUCT_USAGE_VERSION = 1
export const PRODUCT_USAGE_DAYS = 35
export const PRODUCT_USAGE_MAX_COUNT = 100_000
export const PRODUCT_FEEDBACK_REASONS = ['useful', 'could_not_finish', 'slow', 'confusing', 'missing_feature'] as const
export const PRODUCT_FEEDBACK_OUTCOMES = ['completed', 'partly_completed', 'not_completed'] as const
export const PRODUCT_FEEDBACK = [...PRODUCT_FEEDBACK_REASONS, ...PRODUCT_FEEDBACK_OUTCOMES] as const
export const PRODUCT_USAGE_ACTIONS = ['create', 'resume', 'restart', 'model_change', 'history',
  'fork', 'close', 'delete', 'search', 'history_page', 'store_list', 'store_install', 'store_update', 'store_remove',
  'model_list', 'model_download', 'model_start', 'model_stop', 'browser_open'] as const
/** Reads the apps make on their own (an agent's recent turns after each update, the Store and model
 * lists on connect, picker previews): measured for reliability, never as a feature someone used. */
export const PRODUCT_USAGE_AUTOMATIC_ACTIONS: readonly typeof PRODUCT_USAGE_ACTIONS[number][] = ['history', 'history_page', 'store_list', 'model_list']
export const PRODUCT_USAGE_FEATURE_MEASURES = ['installation_days', 'first_installations', 'repeat_installation_days'] as const
export const PRODUCT_USAGE_SURFACES = ['desktop', 'phone', 'web'] as const
export const PRODUCT_USAGE_FLOWS = ['setup', 'setup_harness', 'setup_tmux', 'setup_clipboard', 'sign_in',
  'workspace_connect', 'computer_link', 'remote_connect', 'viewer_open', 'update_check', 'update_stage'] as const
export const PRODUCT_USAGE_FLOW_MEASURES = ['started', 'ok', 'failed', 'cancelled', 'unknown',
  'under_1s', '1s_to_10s', '10s_to_1m', 'over_1m'] as const
export const PRODUCT_USAGE_UI_METRICS = PRODUCT_USAGE_SURFACES.flatMap(surface =>
  PRODUCT_USAGE_FLOWS.flatMap(flow => PRODUCT_USAGE_FLOW_MEASURES.map(measure => `ui_${surface}_${flow}_${measure}` as const)))
// A signed-out report is explicitly enabled on this app. It cannot carry account/work metrics.
export const PRODUCT_USAGE_SETUP_METRICS = PRODUCT_USAGE_SURFACES.flatMap(surface =>
  (['setup', 'setup_harness', 'setup_tmux', 'setup_clipboard', 'sign_in'] as const).flatMap(flow =>
    PRODUCT_USAGE_FLOW_MEASURES.map(measure => `setup_${surface}_${flow}_${measure}` as const)))
export const PRODUCT_USAGE_ACTION_MEASURES = ['requests', 'ok', 'failed', 'pending', 'unknown',
  'error_setup', 'error_auth', 'error_unavailable', 'error_invalid', 'error_other',
  'under_1s', '1s_to_10s', '10s_to_1m', 'over_1m'] as const
export const PRODUCT_USAGE_METRICS = [
  'active_installation_days', 'working_installation_days', 'first_work_installations',
  'repeat_work_installation_days', 'weekly_working_installations', 'weekly_returning_installations',
  'monthly_working_installations', 'monthly_returning_installations', 'reactivated_after_7d_installations',
  'measurement_v2_installation_days', 'measurement_queue_pruned', 'turn_observation_overflow',
  'turns_started', 'turns_ended', 'turns_interrupted',
  'duration_under_10s', 'duration_10s_to_1m', 'duration_1m_to_5m', 'duration_over_5m',
  'desktop_opens', 'tui_opens',
  'launch_started', 'launch_created', 'launch_failed', 'launch_cancelled', 'launch_unconfirmed', 'launch_unobserved',
  'launch_wait_install', 'launch_wait_model', 'launch_wait_native', 'launch_wait_other',
  'launch_failed_setup', 'launch_failed_auth', 'launch_failed_unavailable', 'launch_failed_invalid', 'launch_failed_other',
  'launch_under_10s', 'launch_10s_to_1m', 'launch_1m_to_5m', 'launch_over_5m',
  'turns_with_response', 'turns_with_error', 'turns_ended_without_response', 'turns_waiting_over_1m',
  'response_under_10s', 'response_10s_to_1m', 'response_1m_to_5m', 'response_over_5m',
  'first_launch_installations', 'first_launch_work_24h_installations', 'first_launch_response_24h_installations',
  'first_response_installations', 'd1_returning_work_installations', 'd7_returning_work_installations', 'd28_returning_work_installations',
  ...PRODUCT_FEEDBACK.map(answer => `feedback_${answer}` as const),
  ...PRODUCT_USAGE_ACTIONS.flatMap(action => PRODUCT_USAGE_ACTION_MEASURES.map(measure => `${action}_${measure}` as const)),
  ...PRODUCT_USAGE_ACTIONS.flatMap(action => PRODUCT_USAGE_FEATURE_MEASURES.map(measure => `${action}_${measure}` as const)),
  ...PRODUCT_USAGE_UI_METRICS,
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
