import { HEALTH_MEASURES, type HealthSource, type ResumeReason } from './productHealthContract.js'
import { PRODUCT_USAGE_FLOWS, PRODUCT_USAGE_USER_OPENED_ACTIONS, type ProductUsageMetric } from './productUsageContract.js'

const actions = { agent_create: 'create', agent_resume: 'resume', agent_restart: 'restart',
  agent_retarget: 'model_change', agent_recent: 'history',
  agent_fork: 'fork', agent_close: 'close', agent_delete: 'delete',
  session_search: 'search', session_tail: 'history_page',
  dsh_list: 'store_list', dsh_install: 'store_install', dsh_update: 'store_update', dsh_remove: 'store_remove',
  models_list: 'model_list', grid_models_list: 'model_list',
  grid_fleet_model_download: 'model_download', grid_fleet_model_start: 'model_start', grid_fleet_model_stop: 'model_stop',
  browser_open: 'browser_open',
} as const
const unmeasured = (..._args: unknown[]): void => {}
const setup = new Set(['TMUX_UNAVAILABLE', 'TMUX_TOO_OLD_FOR_DSH', 'TMUX_TOO_OLD_FOR_GRID', 'ENGINE_UNAVAILABLE',
  'NATIVE_LAUNCH_HELD', 'DSH_MATERIALIZE_FAILED', 'SPAWN_FAILED', 'REGISTRATION_FAILED', 'GRID_CONFIG_FAILED'])
const auth = new Set(['UNAUTHORIZED', 'AUTH_REQUIRED', 'LOGIN_REQUIRED', 'OWNER_REQUIRED', 'E2EE_REQUIRED'])
const unavailable = new Set(['SERVICE_UNAVAILABLE', 'SERVICE_FAILED', 'GRID_UNAVAILABLE', 'API_UNAVAILABLE',
  'UNSUPPORTED', 'UNSUPPORTED_ON_REMOTE', 'TIMEOUT', 'NATIVE_UNAVAILABLE'])
const invalid = new Set(['INVALID_ENGINE', 'INVALID_CWD', 'CWD_NOT_FOUND', 'INVALID_GRID', 'INVALID_DSH',
  'INVALID_MODEL', 'INVALID_PERMISSION_MODE', 'INVALID_CREATION_ID', 'INVALID_PROJECT_SOURCE', 'WORKTREE_BUSY'])
const resumeReasons = new Map<string, ResumeReason>([
  ['TMUX_UNAVAILABLE', 'runtime_unavailable'], ['NATIVE_LAUNCH_HELD', 'runtime_unavailable'],
  ['ENGINE_UNAVAILABLE', 'runtime_unavailable'],
  ['AGENT_NOT_FOUND', 'saved_state_missing'], ['RESUME_UNAVAILABLE', 'saved_state_missing'],
  ['CWD_NOT_FOUND', 'project_missing'], ['INVALID_DSH', 'harness_missing'],
  ['GRID_CREDENTIAL_REQUIRED', 'credentials_missing'], ['AUTH_REQUIRED', 'credentials_missing'],
  ['AGENT_BUSY', 'busy'], ['WORKTREE_BUSY', 'busy'], ['PERMISSION_CHANGE_REQUIRES_STOP', 'busy'],
  ['AGENT_CHANGED', 'changed'], ['RESUME_UNCONFIRMED', 'unconfirmed'],
  ['RESUME_PREPARATION_FAILED', 'preparation_failed'], ['RESUME_FAILED', 'launch_failed'],
  ['INVALID_PERMISSION_MODE', 'invalid'], ['INVALID_CREATION_ID', 'invalid'],
])

type Failure = 'setup' | 'auth' | 'unavailable' | 'invalid' | 'other'
function failureKind(error: unknown): Failure {
  return typeof error !== 'string' ? 'other' : setup.has(error) ? 'setup' : auth.has(error) ? 'auth'
    : unavailable.has(error) ? 'unavailable' : invalid.has(error) ? 'invalid' : 'other'
}
export interface ProductUsageLaunchSignal {
  /** Local RAM only, discarded on stop/choice change; never part of a report or persisted queue. */
  id: string
  phase: 'start' | 'pending' | 'created' | 'failed' | 'cancelled' | 'unconfirmed' | 'work_requested'
  origin?: 'interactive' | 'tool'
  failure?: Failure
  wait?: 'install' | 'model' | 'native' | 'other'
}

/** Observe an actual new-harness receipt through subsequent status polls. Polling adds no attempts. */
export function productUsageLaunch(type: string, id: unknown, emit: (signal: ProductUsageLaunchSignal) => void) {
  const known = ['agent_create', 'agent_create_status', 'agent_create_cancel'].includes(type)
    && typeof id === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(id)
  if (!known) return unmeasured
  const send = (signal: Omit<ProductUsageLaunchSignal, 'id'>) => {
    if (known) { try { emit({ id: id as string, ...signal }) } catch { /* Optional measurement. */ } }
  }
  if (type === 'agent_create') send({ phase: 'start' })
  return (error: unknown, state: unknown, hasAgent: boolean, held: unknown) => {
    if (error != null || state === 'failed') send({ phase: 'failed', failure: failureKind(error) })
    else if (state === 'created' || hasAgent) send({ phase: 'created' })
    else if (state === 'pending') send({ phase: 'pending', wait: held === 'install' ? 'install' : held === 'models' ? 'model' : held === 'native' ? 'native' : 'other' })
    else if (state === 'cancelled') send({ phase: 'cancelled' })
    else if (state === 'unconfirmed' || state === 'unavailable' || state === 'missing') send({ phase: 'unconfirmed' })
  }
}

/** Reduce an RPC at its existing boundary. Only fixed counter names leave this helper.
 * No request, reply, error message, path, agent name or identifier is handed to the collector.
 * A pending durable launch is an acknowledgement, never a successful launch. Status polling is
 * excluded: counting each poll as a launch would turn a slow install into hundreds of attempts.
 * [userAction] is the app saying a person opened the list (the Store, a model list); the same request
 * from a refresh, a probe or a picker carries none, and only the flagged one counts toward reach.
 */
export function productUsageRequest(type: string, emit: (metric: ProductUsageMetric) => void, now = Date.now, source?: HealthSource, userAction = false) {
  const action = type === 'message' ? 'message' : Object.hasOwn(actions, type) ? actions[type as keyof typeof actions] : null
  // In particular, streaming frames and polling do not allocate clocks or observers.
  if (!action) return unmeasured
  const started = now()
  let answered = false
  const origin = source === 'app' && ['history', 'history_page', 'store_list', 'model_list'].includes(action) ? 'automatic' : source
  const count = (measure: string) => { if (action && action !== 'message') { try { emit(`${action}_${measure}` as ProductUsageMetric) } catch { /* Optional measurement. */ } } }
  const detail = (measure: string) => { if (!source) return; try { emit(`request_${origin}_${action}_${measure}` as ProductUsageMetric) } catch { /* Optional measurement. */ } }
  count('requests'); detail('started')
  if (userAction && (PRODUCT_USAGE_USER_OPENED_ACTIONS as readonly string[]).includes(action)) count('user_requests')
  return (error: unknown, state: unknown, hasAgent: boolean, ok?: unknown) => {
    if (!action || answered) return
    answered = true
    if (action === 'resume' && (error != null || ok === false || ['failed', 'cancelled', 'unconfirmed', 'unavailable'].some(value => state === value))) {
      const reason = typeof error === 'string' ? resumeReasons.get(error) : undefined
      detail(`reason_${reason ?? (state === 'unconfirmed' ? 'unconfirmed' : 'other')}`)
    }
    // A runtime we cannot verify is unknown; a harness changed during the request is cancelled.
    // Neither proves a launch failure. Older clients classified these two codes as failures.
    if (action === 'resume' && (state === 'unconfirmed' || error === 'RESUME_UNCONFIRMED' || error === 'AGENT_CHANGED')) {
      count('unknown'); detail(error === 'AGENT_CHANGED' ? 'cancelled' : 'unknown')
    } else if (error != null || state === 'failed' || ok === false) {
      count('failed'); detail('failed')
      count(`error_${failureKind(error)}`)
      detail(`error_${error === 'TIMEOUT' ? 'timeout' : typeof error === 'string' && ['AGENT_NOT_FOUND', 'SESSION_NOT_FOUND', 'NOT_FOUND'].includes(error) ? 'not_found' : typeof error === 'string' && ['DELETE_IN_PROGRESS', 'WORKTREE_BUSY', 'BUSY'].includes(error) ? 'conflict' : failureKind(error)}`)
    } else if (state === 'pending' || state === 'preparing' || state === 'starting') { count('pending'); detail('pending') }
    else if (state === 'unconfirmed' || state === 'unavailable' || state === 'cancelled') { count('unknown'); detail(state === 'cancelled' ? 'cancelled' : 'unknown') }
    else if (!['create', 'resume', 'restart', 'fork'].includes(action) || hasAgent || state === 'created') { count('ok'); detail('ok') }
    else { count('unknown'); detail('unknown') }
    const elapsed = Math.max(0, now() - started)
    count(elapsed < 1000 ? 'under_1s' : elapsed < 10_000 ? '1s_to_10s' : elapsed < 60_000 ? '10s_to_1m' : 'over_1m')
  }
}

/** Explicit composer intent only. Never infer a human from keystrokes, text or an open window. */
export function productUsageIntent(type: string, intent: unknown, agent: unknown, source: HealthSource, emit: (signal: ProductUsageLaunchSignal) => void): void {
  if (type !== 'message' || typeof agent !== 'string' || !agent || agent.length > 256) return
  try {
    if (source === 'app' && intent === 'interactive') emit({ id: agent, phase: 'work_requested', origin: 'interactive' })
    else if (source === 'tool') emit({ id: agent, phase: 'work_requested', origin: 'tool' })
  } catch { /* Optional observation cannot block a message. */ }
}

const OBSERVED_OUTCOMES = ['ok', 'failed', 'cancelled', 'unknown']
/**
 * hn's own observation (`product_observe`), reduced to the counters the Desktop's `begin()` and
 * `milestone()` count, each when it happens: `{flow}` is a flow's start, `{flow, outcome, durationMs}`
 * its outcome and duration bucket, `{measure}` one health measure. Anything else — an unknown name,
 * a bad duration, a field more or less than its shape has — is nothing, so no label, text or number
 * of hn's own becomes a counter.
 */
export function productObservation(payload: unknown): ProductUsageMetric[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const p = payload as Record<string, unknown>
  const fields = Object.keys(p).sort().join()
  if (fields === 'measure') {
    return typeof p.measure === 'string' && (HEALTH_MEASURES as readonly string[]).includes(p.measure)
      ? [`health_tui_${p.measure}` as ProductUsageMetric] : []
  }
  if (typeof p.flow !== 'string' || !(PRODUCT_USAGE_FLOWS as readonly string[]).includes(p.flow)) return []
  const prefix = `ui_tui_${p.flow}_`
  if (fields === 'flow') return [`${prefix}started` as ProductUsageMetric]
  if (fields !== 'durationMs,flow,outcome' || typeof p.outcome !== 'string' || !OBSERVED_OUTCOMES.includes(p.outcome)
      || typeof p.durationMs !== 'number' || !Number.isFinite(p.durationMs) || p.durationMs < 0) return []
  const ms = p.durationMs
  return [`${prefix}${p.outcome}`,
    `${prefix}${ms < 1000 ? 'under_1s' : ms < 10_000 ? '1s_to_10s' : ms < 60_000 ? '10s_to_1m' : 'over_1m'}`] as ProductUsageMetric[]
}
