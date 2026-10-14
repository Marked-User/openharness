// Restart's primitives against the real Harness PTY host: a pane keeps its id and its scrollback while the
// process in it is replaced, as tmux's `remain-on-exit` + `respawn-pane -k` keep a tmux pane. Build it first:
//   cd pty && cargo +stable build
//   cd cli && HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npx vitest run src/lib/ptyHostBackend.restart.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PtyHostBackend } from './ptyHostBackend.js'
import { readDiscovery } from './ptyHost/launch.js'
import { PTY_PROTOCOL } from './ptyHost/protocol.js'
import { canRestart } from './terminalBackend.js'
import type { PtyRuntimeRef } from './terminalTypes.js'

const enabled = !!process.env.HARNESS_PTY_BIN
const CASE_TIMEOUT_MS = 20_000

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** A backend on a host of its own in a fresh home, never the user's; [run] gets it, then the host is stopped. */
async function withHost(run: (backend: PtyHostBackend) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'pty-restart-'))
  const backend = new PtyHostBackend({ home })
  try {
    const prepared = await backend.prepare({ ownedPanes: new Map() })
    if (prepared.state !== 'ready') throw new Error(`the pty host is unavailable (${prepared.code}): ${prepared.reason}`)
    await run(backend)
  } finally {
    backend.dispose()
    const pid = readDiscovery(home, PTY_PROTOCOL)?.pid
    if (pid) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    rmSync(home, { recursive: true, force: true })
  }
}

async function created(backend: PtyHostBackend, command: string[]): Promise<PtyRuntimeRef> {
  const result = await backend.create({ command })
  if (result.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(result)}`)
  return result.runtime
}

const screen = async (backend: PtyHostBackend, runtime: PtyRuntimeRef): Promise<string> => {
  const read = await backend.capture(runtime, { historyLines: 100, ansi: false })
  return read.state === 'succeeded' ? read.value : ''
}

;(enabled ? describe : describe.skip)('ptyhost restart primitives', () => {
  it('can restart: the gate is its primitives', () => {
    expect(canRestart(new PtyHostBackend({ home: '/nonexistent' }))).toBe(true)
  })

  it('a held pane outlives its killed shell, and a respawn runs in the same pane over the same scrollback', async () => {
    await withHost(async (backend) => {
      const pane = await created(backend, ['/bin/sh'])
      expect((await backend.typeLiteral(pane, 'echo before-restart\n')).state).toBe('succeeded')
      expect(await until(() => screen(backend, pane), (text) => /^before-restart$/m.test(text))).toMatch(/^before-restart$/m)
      expect(await backend.holdOpen(pane)).toEqual({ state: 'succeeded', dispatch: 'executed' })
      const pid = await backend.rootProcess(pane)
      if (typeof pid !== 'number') throw new Error(`no root process: ${String(pid)}`)
      process.kill(pid, 'SIGKILL')
      // Held: the pane is still there, its process dead.
      expect(await until(() => backend.paneState(pane), (state) => state !== 'unknown' && state !== 'gone' && state.dead)).toMatchObject({ dead: true })
      expect(await backend.respawn(pane, { command: ['/bin/sh', '-c', 'echo again; exec /bin/sh'] })).toEqual({ state: 'succeeded', dispatch: 'executed' })
      // Printed where the killed shell left the cursor, after its last prompt, as tmux's respawned pane would.
      const text = await until(() => screen(backend, pane), (value) => /again$/m.test(value))
      expect(text).toMatch(/again$/m)
      expect(text).toMatch(/^before-restart$/m)
      expect(text.indexOf('before-restart')).toBeLessThan(text.lastIndexOf('again'))
      expect(await backend.paneState(pane)).toMatchObject({ dead: false })
      const inventory = await backend.inventory()
      expect(inventory.state === 'available' && inventory.roots.filter((root) => root.runtime.paneId === pane.paneId)).toHaveLength(1)
      expect((await backend.kill(pane)).state).toBe('succeeded')
    })
  }, CASE_TIMEOUT_MS)

  it('a held shell under a token is replaced only by a respawn naming it, and closed only by its own token', async () => {
    await withHost(async (backend) => {
      const token = '0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c'
      const other = '11111111-2222-4333-8444-555555555555'
      const pane = await created(backend, ['/bin/sh', '-c', `echo harness-held ${token}; exec /bin/sh`])
      expect(await backend.isHeld(pane, token)).toBe(true)
      expect(await backend.isHeld(pane, other)).toBe(false)
      expect(await backend.respawn(pane, { command: ['/bin/sh'], expectedHeldToken: other }))
        .toEqual({ state: 'failed', dispatch: 'not_started', reason: 'The waiting pane changed' })
      expect(await backend.killHeld(pane, other, () => true)).toMatchObject({ state: 'failed', dispatch: 'not_started' })
      expect(await backend.paneState(pane)).toMatchObject({ dead: false })
      expect(await backend.killHeld(pane, token, () => true)).toEqual({ state: 'succeeded', dispatch: 'executed' })
      expect(await until(() => backend.paneState(pane), (state) => state === 'gone')).toBe('gone')
      expect(await backend.killHeld(pane, token, () => true)).toEqual({ state: 'succeeded', dispatch: 'executed' })

      const replaced = await created(backend, ['/bin/sh', '-c', `echo harness-held ${token}; exec /bin/sh`])
      expect(await backend.respawn(replaced, { command: ['/bin/sh', '-c', 'echo engine-up; exec /bin/sh'], expectedHeldToken: token }))
        .toEqual({ state: 'succeeded', dispatch: 'executed' })
      expect(await until(() => screen(backend, replaced), (text) => /^engine-up$/m.test(text))).toMatch(/^engine-up$/m)
      expect(await backend.isHeld(replaced, token)).toBe(false)
      expect((await backend.kill(replaced)).state).toBe('succeeded')
    })
  }, CASE_TIMEOUT_MS)
})
