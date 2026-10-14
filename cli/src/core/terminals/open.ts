/** The core's narrow launch call. Shell setup and request policy belong to the shell service. */
import { randomUUID } from 'node:crypto'
import type { TerminalsPort } from '../api.js'
import { createAndRegisterPane, type CreateAgentPaneDeps } from '../../lib/createAgentPane.js'
import type { RegisteredSession, registry } from '../../lib/registry.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import type { TmuxRuntimeRef } from '../../lib/terminalTypes.js'

export interface TerminalOpenerDeps {
  tmuxBackend: (CreateAgentPaneDeps['tmuxBackend'] & Pick<TerminalBackend<TmuxRuntimeRef>, 'releaseHold'>) | null
  registry: CreateAgentPaneDeps['registry'] & Pick<typeof registry, 'setLaunch'>
  announceSession(session: RegisteredSession): void
  blocksFolder(cwd: string): boolean
}

export function createTerminalOpener({ tmuxBackend, registry, announceSession, blocksFolder }: TerminalOpenerDeps): Pick<TerminalsPort, 'open'> {
  return { open: async ({ argv, cwd }) => {
    if (!tmuxBackend) return { ok: false, error: 'TMUX_UNAVAILABLE' }
    if (blocksFolder(cwd)) return { ok: false, error: 'WORKTREE_BUSY' }
    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'terminal', cwd, spawnCwd: cwd,
      argv: [...argv], sessionLabel: `harness-shell-${randomUUID()}`, bypassPermission: false,
    })
    if (!result.ok) return result
    await tmuxBackend.releaseHold(result.spawned.runtime)
    const ready = registry.setLaunch(result.pending.agentId, { state: 'ready' })
    if (!ready) return { ok: false, error: 'TERMINAL_CLOSED' }
    announceSession(ready)
    return { ok: true, agentId: ready.agentId }
  } }
}
