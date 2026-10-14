import { describe, vi } from 'vitest'
import { isolatedTmux } from '../testing/isolatedTmux.js'
import { runTerminalBackendContract } from './terminalBackend.contract.js'
import { TmuxBackend } from './tmuxBackend.js'
import { DEFAULT_HOST_THEME } from './hostTheme.js'

const enabled = process.env.RUN_TERMINAL_CONTRACT === '1' && process.platform !== 'win32'
;(enabled ? runTerminalBackendContract : () => describe.skip('tmux contract', () => {}))('tmux', async () => {
  // A private tmux server: the backend runs bare `tmux`, so the environment points it at the fixture's
  // socket directory and clears the variables that would reach the developer's own server.
  const server = await isolatedTmux({ PATH: process.env.PATH, TERM: 'xterm-256color' })
  vi.stubEnv('TMUX', undefined)
  vi.stubEnv('TMUX_PANE', undefined)
  vi.stubEnv('TMUX_TMPDIR', server.root)
  const backend = new TmuxBackend(() => DEFAULT_HOST_THEME)
  await backend.prepare({ ownedPanes: new Map() })
  return { backend, cleanup: async () => { await server.close(); vi.unstubAllEnvs() } }
})
