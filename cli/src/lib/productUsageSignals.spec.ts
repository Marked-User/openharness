import { expect, it, vi } from 'vitest'
import { productUsageIntent, productUsageLaunch, productUsageRequest } from './productUsageSignals.js'

it('separates automated polling, tool and app RPCs without inspecting error objects or content', () => {
  const emit = vi.fn()
  productUsageRequest('models_list', emit, Date.now, 'app')(undefined, undefined, false)
  productUsageRequest('agent_resume', emit, Date.now, 'tool')('AGENT_NOT_FOUND', 'failed', false)
  productUsageRequest('agent_close', emit, Date.now, 'app')(undefined, 'cancelled', false)
  const secret = { toString() { throw Error('PRIVATE') } }
  expect(() => productUsageRequest('agent_restart', emit, Date.now, 'unknown')(secret, 'failed', false)).not.toThrow()
  expect(emit.mock.calls.flat()).toEqual(expect.arrayContaining(['request_automatic_model_list_ok', 'request_tool_resume_error_not_found', 'request_app_close_cancelled', 'request_unknown_restart_error_other']))
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE')
})
it('requires an explicit composer marker for interactive work; raw terminal input is unclassified', () => {
  const emit = vi.fn()
  productUsageIntent('terminal_input', 'interactive', 'agent', 'app', emit)
  productUsageIntent('message', undefined, 'agent', 'app', emit)
  expect(emit).not.toHaveBeenCalled()
  productUsageIntent('message', 'interactive', 'agent', 'app', emit)
  expect(emit).toHaveBeenCalledWith({ id: 'agent', phase: 'work_requested', origin: 'interactive' })
  expect(() => productUsageIntent('message', undefined, 'agent', 'tool', () => { throw Error() })).not.toThrow()
})

it('distinguishes a pending launch from a launched harness, and counts replies once', () => {
  let now = 0
  const emit = vi.fn(), done = productUsageRequest('agent_create', emit, () => now)
  now = 12_000; done(undefined, 'pending', false); done(undefined, 'created', true)
  expect(emit.mock.calls.flat()).toEqual(['create_requests', 'create_pending', 'create_10s_to_1m'])
})
it('maps known failures and never emits raw or unknown error strings', () => {
  const emit = vi.fn()
  productUsageRequest('agent_create', emit)('ENGINE_UNAVAILABLE', undefined, false)
  productUsageRequest('agent_restart', emit)('PRIVATE_ERROR_WITH_PATH', 'failed', false)
  expect(emit.mock.calls.flat()).toContain('create_error_setup')
  expect(emit.mock.calls.flat()).toContain('restart_error_other')
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_')
})
it('ignores arbitrary RPC names and status polling and survives unavailable reporting', () => {
  const emit = vi.fn()
  for (const type of ['PRIVATE_METHOD', 'agent_create_status', 'text_delta']) productUsageRequest(type, emit)(undefined, undefined, true)
  expect(emit).not.toHaveBeenCalled()
  expect(() => productUsageRequest('agent_create', () => { throw Error('offline') })(undefined, 'created', true)).not.toThrow()
})

it('reduces durable launch statuses to fixed categories without forwarding error or hold text', () => {
  const emit = vi.fn(), id = 'fixture-creation-one'
  productUsageLaunch('agent_create', id, emit)(undefined, 'pending', false, 'install')
  productUsageLaunch('agent_create_status', id, emit)('PRIVATE_CANARY', 'failed', false, 'PRIVATE_CANARY')
  expect(emit.mock.calls.flat()).toEqual([{ id, phase: 'start' }, { id, phase: 'pending', wait: 'install' }, { id, phase: 'failed', failure: 'other' }])
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_CANARY')
})


it('observes Store, search and model operations without their arguments and rejects explicit false outcomes', () => {
  const emit = vi.fn()
  productUsageRequest('dsh_install', emit)(undefined, undefined, false, false)
  productUsageRequest('session_search', emit)(undefined, undefined, false)
  productUsageRequest('grid_fleet_model_download', emit)('TIMEOUT', undefined, false)
  expect(emit.mock.calls.flat()).toEqual(expect.arrayContaining([
    'store_install_requests', 'store_install_failed', 'search_ok', 'model_download_error_unavailable',
  ]))
  const clock = vi.fn()
  productUsageRequest('terminal_input', emit, clock)
  expect(clock).not.toHaveBeenCalled()
})
