import { controlPlaneAuth, requestJson } from './controlPlane.js'
import type { ProductUsageChoice } from './productUsageContract.js'

/** Account-wide preference: the CLI works even when the local daemon is stopped. */
export async function privacyCommand(action = 'status', json = false): Promise<void> {
  if (!['status', 'on', 'off'].includes(action)) throw new Error('Usage: harness privacy status|on|off [--json]')
  const { headers } = await controlPlaneAuth()
  const state = await requestJson<ProductUsageChoice>(action === 'status' ? 'GET' : 'POST', '/api/product-usage/settings',
    action === 'status' ? undefined : { enabled: action === 'on' }, headers)
  if (typeof state?.enabled !== 'boolean') throw new Error('Update the Harness server to manage product usage sharing.')
  console.log(json ? JSON.stringify(state) : `Share product usage data: ${state.enabled ? 'on' : 'off'} (all computers on this account).`)
}
