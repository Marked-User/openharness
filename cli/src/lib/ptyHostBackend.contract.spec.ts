// The terminal contract and the host-connection lifecycle against the real Harness PTY host. Build it first, then:
//   cd pty && cargo +stable build
//   cd cli && HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npm run test:terminal-contract
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PtyHostBackend } from './ptyHostBackend.js'
import { readDiscovery } from './ptyHost/launch.js'
import { PTY_PROTOCOL } from './ptyHost/protocol.js'
import { runTerminalBackendContract } from './terminalBackend.contract.js'
import type { TerminalInventoryResult } from './terminalTypes.js'

const enabled = process.env.RUN_TERMINAL_CONTRACT === '1' && !!process.env.HARNESS_PTY_BIN
const CASE_TIMEOUT_MS = 15_000

/** A fresh `--home`: a host of its own, never the user's. */
const freshHome = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

/** Stop the host serving [home] (its panes go with it) and remove the home. */
function stopHost(home: string): void {
  const pid = readDiscovery(home, PTY_PROTOCOL)?.pid
  if (pid) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  rmSync(home, { recursive: true, force: true })
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** A backend on a host of its own in [home], ready; one that is not fails saying why, and leaves no host. */
async function readyBackend(home: string): Promise<PtyHostBackend> {
  const backend = new PtyHostBackend({ home })
  const prepared = await backend.prepare({ ownedPanes: new Map() }).catch((error: unknown) => {
    backend.dispose()
    stopHost(home)
    throw new Error(`ptyhost contract: prepare threw: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (prepared.state !== 'ready') {
    backend.dispose()
    stopHost(home)
    throw new Error(`ptyhost contract: the host is unavailable (${prepared.code}): ${prepared.reason}`)
  }
  return backend
}

;(enabled ? runTerminalBackendContract : () => describe.skip('ptyhost contract', () => {}))('ptyhost', async () => {
  const home = freshHome('pty-contract-')
  const backend = await readyBackend(home)
  return { backend, cleanup: async () => { backend.dispose(); stopHost(home) } }
})

;(enabled ? describe : describe.skip)('ptyhost lifecycle', () => {
  it('host death makes the backend unavailable, then a reconnect reaches a new host without the old panes', async () => {
    const home = freshHome('pty-death-')
    const backend = await readyBackend(home)
    try {
      const replaced: number[] = []
      backend.onHostReplaced = () => replaced.push(Date.now())
      const created = await backend.create({ command: ['/bin/sh'] })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      const before = readDiscovery(home, PTY_PROTOCOL)!
      process.kill(before.pid, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Disconnected: unavailable, never an empty listing (which would read as every pane gone).
      expect((await backend.inventory()).state).toBe('unavailable')
      // The reconnect, 1 s after the loss, starts a new host: it has no panes.
      const inventory = await until<TerminalInventoryResult>(() => backend.inventory(), (inv) => inv.state === 'available')
      expect(inventory).toEqual({ state: 'available', roots: [] })
      expect(readDiscovery(home, PTY_PROTOCOL)!.pid).not.toBe(before.pid)
      expect(replaced).toHaveLength(1)
      expect(await backend.paneState(created.runtime)).toBe('gone')
    } finally {
      backend.dispose()
      stopHost(home)
    }
  }, CASE_TIMEOUT_MS)

  it('a restarted daemon reattaches to the host and finds its pane', async () => {
    const home = freshHome('pty-reattach-')
    const first = await readyBackend(home)
    let second: PtyHostBackend | null = null
    try {
      const created = await first.create({ command: ['/bin/sh'] })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      first.dispose() // the daemon exiting: the host and its pane stay
      second = await readyBackend(home) // the restarted daemon
      const inventory = await second.inventory()
      expect(inventory.state === 'available' && inventory.roots.some((root) => root.runtime.paneId === created.runtime.paneId)).toBe(true)
      expect(await second.paneState(created.runtime)).toMatchObject({ dead: false })
      expect((await second.kill(created.runtime)).state).toBe('succeeded')
    } finally {
      first.dispose()
      second?.dispose()
      stopHost(home)
    }
  }, CASE_TIMEOUT_MS)
})
