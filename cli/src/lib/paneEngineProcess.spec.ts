import { describe, expect, it } from 'vitest'
import { lookupPaneEngineProcess } from './paneEngineProcess.js'
import { setProcessTableSource } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'

const runtime = { backend: 'tmux' as const, paneId: '%1' }
function backendWithRoot(root: number | 'missing' | null): TerminalBackend {
  return { rootProcess: async () => root } as unknown as TerminalBackend
}

describe('lookupPaneEngineProcess', () => {
  it('says gone when the backend has no such pane', async () => {
    const found = await lookupPaneEngineProcess(backendWithRoot('missing'), runtime, 'claude')
    expect(found).toEqual({ ok: false, unknown: false, reason: 'tmux:%1 has no pane' })
  })

  it('says unknown when the backend could not be asked', async () => {
    const found = await lookupPaneEngineProcess(backendWithRoot(null), runtime, 'claude')
    expect(found).toMatchObject({ ok: false, unknown: true })
  })

  it('finds the engine below the pane root', async () => {
    setProcessTableSource(async () => [
      { pid: 10, parentPid: 1, executable: 'zsh', startMarker: 'm10', args: '-zsh' },
      { pid: 11, parentPid: 10, executable: 'claude', startMarker: 'm11', args: 'claude' },
    ])
    try {
      const found = await lookupPaneEngineProcess(backendWithRoot(10), runtime, 'claude')
      expect(found).toMatchObject({ ok: true, identity: { pid: 11, startMarker: 'm11' } })
    } finally { setProcessTableSource(null) }
  })
})
