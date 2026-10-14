import { expect, it, vi } from 'vitest'
import { productUsageLaunch, productUsageRequest } from './productUsageSignals.js'

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
