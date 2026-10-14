/** Ending an agent's process: one seam, so a platform without POSIX signals can plug in its own terminator. */

import type { ProcessIdentity } from './terminalTypes.js'
import { processRows } from './processTable.js'
import { sameProcessIdentity } from './terminalRuntime.js'

export type TerminateResult = 'signalled' | 'gone' | 'failed'
export interface ProcessTerminator { terminate(identity: ProcessIdentity, options: { graceful: boolean }): Promise<TerminateResult> }

const unixTerminator: ProcessTerminator = {
  async terminate(identity, { graceful }) {
    const rows = await processRows()
    if (!rows) return 'failed'
    if (!rows.some((row) => sameProcessIdentity(row, identity))) return 'gone'
    try { process.kill(identity.pid, graceful ? 'SIGTERM' : 'SIGKILL'); return 'signalled' }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed' }
  },
}

let terminator: ProcessTerminator | null = null
export function setProcessTerminator(next: ProcessTerminator | null): void { terminator = next }

/** Unix: SIGTERM (graceful) or SIGKILL after re-checking identity. Windows: replaced in Task 19. */
export function terminateProcess(identity: ProcessIdentity, options: { graceful: boolean }): Promise<TerminateResult> {
  return (terminator ?? unixTerminator).terminate(identity, options)
}
