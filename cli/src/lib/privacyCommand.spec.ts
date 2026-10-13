import { beforeEach, expect, it, vi } from 'vitest'
const deps = vi.hoisted(() => ({ controlPlaneAuth: vi.fn(), requestJson: vi.fn() }))
vi.mock('./controlPlane.js', () => deps)
import { privacyCommand } from './privacyCommand.js'
beforeEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); deps.controlPlaneAuth.mockResolvedValue({ headers: { authorization: 'fixture' } }); deps.requestJson.mockResolvedValue({ enabled: false, revision: 1 }) })
it('reads or writes the account preference, without putting credentials in output', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await privacyCommand('off', true)
  expect(deps.requestJson).toHaveBeenCalledWith('POST', '/api/product-usage/settings', { enabled: false }, { authorization: 'fixture' })
  expect(log).toHaveBeenCalledWith('{"enabled":false,"revision":1}')
  await privacyCommand()
  expect(deps.requestJson).toHaveBeenLastCalledWith('GET', '/api/product-usage/settings', undefined, { authorization: 'fixture' })
})
it('rejects unknown commands before reading credentials', async () => {
  await expect(privacyCommand('force')).rejects.toThrow('Usage:')
  expect(deps.controlPlaneAuth).not.toHaveBeenCalled()
})
