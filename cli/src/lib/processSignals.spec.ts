import { describe, expect, it, vi } from 'vitest'
import { terminateProcess } from './processSignals.js'
import { setProcessTableSource } from './processTable.js'

describe('terminateProcess (unix)', () => {
  it('does not signal a pid whose identity changed', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    setProcessTableSource(async () => [{ pid: 50, parentPid: 1, executable: 'x', startMarker: 'NEW', args: 'x' }])
    try {
      expect(await terminateProcess({ pid: 50, executable: 'x', startMarker: 'OLD' }, { graceful: true })).toBe('gone')
      expect(kill).not.toHaveBeenCalled()
    } finally { setProcessTableSource(null); kill.mockRestore() }
  })

  it('sends SIGTERM when graceful and identity matches', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    setProcessTableSource(async () => [{ pid: 51, parentPid: 1, executable: 'x', startMarker: 'S', args: 'x' }])
    try {
      expect(await terminateProcess({ pid: 51, executable: 'x', startMarker: 'S' }, { graceful: true })).toBe('signalled')
      expect(kill).toHaveBeenCalledWith(51, 'SIGTERM')
    } finally { setProcessTableSource(null); kill.mockRestore() }
  })
})
