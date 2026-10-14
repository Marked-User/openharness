import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyHostClient } from './client.js'
import { ensurePtyHost, ptyHostBinary, reachable, readDiscovery } from './launch.js'
import { PTY_PROTOCOL } from './protocol.js'

const exe = process.platform === 'win32' ? 'harness-pty.exe' : 'harness-pty'
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function executable(file: string, body = ''): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

const discoveryFile = (home: string) => path.join(home, 'run', `pty-host-${PTY_PROTOCOL}.json`)
function writeDiscovery(home: string, value: unknown): void {
  mkdirSync(path.join(home, 'run'), { recursive: true })
  writeFileSync(discoveryFile(home), JSON.stringify(value))
}

describe('ptyHostBinary', () => {
  it('takes HARNESS_PTY_BIN first, as it is', () => {
    expect(ptyHostBinary({ env: { HARNESS_PTY_BIN: ' /opt/x/harness-pty ' }, runtimeDir: '/nowhere', besideDir: '/nowhere' }))
      .toBe('/opt/x/harness-pty')
  })

  it('takes the newest version under <runtime>/pty that has the binary', () => {
    const runtime = tempDir('rt-')
    executable(path.join(runtime, 'pty', '0.9.0', exe))
    executable(path.join(runtime, 'pty', '0.10.0', exe))
    executable(path.join(runtime, 'pty', '0.10', exe))
    // Newer, but without the binary (an install that did not finish), and not a version at all.
    mkdirSync(path.join(runtime, 'pty', '0.11.0'), { recursive: true })
    executable(path.join(runtime, 'pty', 'latest', exe))
    const besideDir = tempDir('dist-')
    executable(path.join(besideDir, exe))
    expect(ptyHostBinary({ env: {}, runtimeDir: runtime, besideDir })).toBe(path.join(runtime, 'pty', '0.10.0', exe))
  })

  it.skipIf(process.platform === 'win32')('skips a managed binary that is not executable', () => {
    const runtime = tempDir('rt-')
    const file = executable(path.join(runtime, 'pty', '1.0.0', exe))
    chmodSync(file, 0o644)
    expect(ptyHostBinary({ env: {}, runtimeDir: runtime, besideDir: '/nowhere' })).toBeNull()
  })

  it('falls back to the binary beside the bundle, then to null', () => {
    const besideDir = tempDir('dist-')
    expect(ptyHostBinary({ env: {}, runtimeDir: '/nowhere', besideDir })).toBeNull()
    executable(path.join(besideDir, exe))
    expect(ptyHostBinary({ env: { HARNESS_PTY_BIN: '  ' }, runtimeDir: '/nowhere', besideDir })).toBe(path.join(besideDir, exe))
  })
})

describe('readDiscovery', () => {
  const valid = { protocol: PTY_PROTOCOL, instance: 'p1', endpoint: '/x.sock', pid: 7, version: '0.1.0', token: 't' }

  it('reads <home>/run/pty-host-<protocol>.json', () => {
    const home = tempDir('h-')
    writeDiscovery(home, valid)
    expect(readDiscovery(home, PTY_PROTOCOL)).toEqual(valid)
  })

  it('gives null for a missing, unreadable or malformed file, or another protocol', () => {
    const home = tempDir('h-')
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
    mkdirSync(path.join(home, 'run'))
    writeFileSync(discoveryFile(home), '{"protocol":')
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
    writeDiscovery(home, { ...valid, pid: '7' })
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
    writeDiscovery(home, null)
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
    writeDiscovery(home, { ...valid, protocol: PTY_PROTOCOL + 1 })
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
  })
})

/**
 * A stand-in for `harness-pty serve --home <dir>`: a Node script that records each start in
 * `<home>/spawns`, then serves (writing its discovery file once it listens), fails, or exits
 * at once as a host that found another one serving does.
 */
function fakeBinary(mode: 'serve' | 'fail' | 'quiet' | 'deaf'): string {
  const dir = tempDir('bin-')
  return executable(path.join(dir, exe), `#!${process.execPath}
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
const home = process.argv[process.argv.indexOf('--home') + 1]
const run = path.join(home, 'run')
fs.mkdirSync(run, { recursive: true })
fs.appendFileSync(path.join(home, 'spawns'), process.pid + '\\n')
if (${JSON.stringify(mode)} === 'fail') process.exit(4)
if (${JSON.stringify(mode)} === 'quiet') process.exit(0)
const endpoint = path.join(run, 'h.sock')
fs.rmSync(endpoint, { force: true })
if (${JSON.stringify(mode)} === 'deaf') {
  // A discovery file naming an endpoint nothing listens at, from a host that then stays up.
  const file = path.join(run, 'pty-host-${PTY_PROTOCOL}.json')
  fs.writeFileSync(file, JSON.stringify({ protocol: ${PTY_PROTOCOL}, instance: 'p1', endpoint, pid: process.pid, version: 'fake', token: 'fake-token' }))
  setInterval(() => {}, 1000)
} else {
const server = net.createServer(socket => {
  socket.on('error', () => {})
  let pending = ''
  let said = false
  socket.on('data', chunk => {
    pending += chunk
    let at
    while ((at = pending.indexOf('\\n')) >= 0) {
      const value = JSON.parse(pending.slice(0, at))
      pending = pending.slice(at + 1)
      if (!said) { said = true; socket.write(JSON.stringify({ hello: { ok: true, instance: 'p1', version: 'fake', pid: process.pid } }) + '\\n'); continue }
      socket.write(JSON.stringify(value.op === 'inventory' ? { id: value.id, ok: true, panes: [] } : { id: value.id, ok: true }) + '\\n')
    }
  })
})
server.listen(endpoint, () => {
  const file = path.join(run, 'pty-host-${PTY_PROTOCOL}.json')
  fs.writeFileSync(file + '.tmp', JSON.stringify({ protocol: ${PTY_PROTOCOL}, instance: 'p1', endpoint, pid: process.pid, version: 'fake', token: 'fake-token' }))
  fs.renameSync(file + '.tmp', file)
})
}
`)
}

/** A home whose spawned fake hosts are killed after the test. */
function home(): string {
  const dir = tempDir('h-')
  cleanup.push(() => {
    const spawns = path.join(dir, 'spawns')
    if (!existsSync(spawns)) return
    for (const pid of readFileSync(spawns, 'utf8').split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ }
    }
  })
  return dir
}
const spawnCount = (dir: string) => existsSync(path.join(dir, 'spawns'))
  ? readFileSync(path.join(dir, 'spawns'), 'utf8').split('\n').filter(Boolean).length
  : 0

async function clientOf(result: Awaited<ReturnType<typeof ensurePtyHost>>): Promise<PtyHostClient> {
  if (!('client' in result)) throw new Error(`no client: ${JSON.stringify(result)}`)
  cleanup.push(() => result.client.close())
  return result.client
}

// The fake binary is a script with a shebang, which Windows cannot run.
describe.skipIf(process.platform === 'win32')('ensurePtyHost', () => {
  it('connects to the host the discovery file names, without starting one', async () => {
    const dir = home()
    const binary = fakeBinary('serve')
    const first = await clientOf(await ensurePtyHost(dir, { binary }))
    expect(spawnCount(dir)).toBe(1)
    const second = await clientOf(await ensurePtyHost(dir, { binary: null }))
    expect(second).not.toBe(first)
    expect(await second.call({ op: 'inventory' })).toEqual({ state: 'ok', value: { panes: [] } })
    expect(spawnCount(dir)).toBe(1)
  })

  it('starts a host when there is no discovery file, and waits for it', async () => {
    const dir = home()
    const client = await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve') }))
    expect(client.instance).toBe('p1')
    expect(readDiscovery(dir, PTY_PROTOCOL)?.pid).toBe(Number(readFileSync(path.join(dir, 'spawns'), 'utf8').trim()))
  })

  it('starts a host when the endpoint in the discovery file refuses', async () => {
    const dir = home()
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: 'p1', endpoint: path.join(dir, 'gone.sock'), pid: 999_999, version: 'old', token: 't' })
    const client = await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve') }))
    expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'ok' })
    expect(readDiscovery(dir, PTY_PROTOCOL)?.version).toBe('fake')
  })

  it('starts one host for concurrent calls', async () => {
    const dir = home()
    const binary = fakeBinary('serve')
    const results = await Promise.all([ensurePtyHost(dir, { binary }), ensurePtyHost(dir, { binary }), ensurePtyHost(dir, { binary })])
    for (const result of results) await clientOf(result)
    expect(spawnCount(dir)).toBe(1)
  })

  it('is unavailable when there is no binary', async () => {
    expect(await ensurePtyHost(home(), { binary: null })).toEqual({
      unavailable: expect.stringContaining('harness-pty'), code: 'PTY_HOST_UNAVAILABLE',
    })
  })

  it('is unavailable when the binary cannot be started', async () => {
    const result = await ensurePtyHost(home(), { binary: path.join(tempDir('bin-'), 'missing') })
    expect(result).toEqual({ unavailable: expect.stringContaining('could not start'), code: 'PTY_HOST_UNAVAILABLE' })
  })

  it('is unavailable at once when the host exits with an error', async () => {
    const started = Date.now()
    const result = await ensurePtyHost(home(), { binary: fakeBinary('fail'), waitMs: 5_000 })
    expect(result).toEqual({ unavailable: expect.stringContaining('exited with code 4'), code: 'PTY_HOST_UNAVAILABLE' })
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('is unavailable when no discovery file appears in time', async () => {
    const result = await ensurePtyHost(home(), { binary: fakeBinary('quiet'), waitMs: 300 })
    expect(result).toEqual({ unavailable: expect.stringContaining('300 ms'), code: 'PTY_HOST_UNAVAILABLE' })
  })

  it('is unavailable, saying so, when the endpoint a new discovery file names refuses connections', async () => {
    const result = await ensurePtyHost(home(), { binary: fakeBinary('deaf') })
    expect(result).toEqual({
      unavailable: 'no harness-pty answers at the endpoint its discovery file names', code: 'PTY_HOST_UNAVAILABLE',
    })
  })

  it('reports a host that refuses this daemon as incompatible, without starting another', async () => {
    const dir = home()
    const endpoint = path.join(dir, 'r.sock')
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ hello: { ok: false, code: 'incompatible', reason: 'wrong token' } })}\n`)
      })
    })
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: 'p1', endpoint, pid: 1, version: 'v', token: 'stale' })
    expect(await ensurePtyHost(dir, { binary: fakeBinary('serve') })).toEqual({ incompatible: 'incompatible: wrong token' })
    expect(spawnCount(dir)).toBe(0)
  })

  it('tries again once when the discovery file changed during a refused hello', async () => {
    const dir = home()
    const binary = fakeBinary('serve')
    await clientOf(await ensurePtyHost(dir, { binary }))
    const live = readDiscovery(dir, PTY_PROTOCOL)!
    // A host that just restarted: the file still names the old token while the new host answers.
    const endpoint = path.join(dir, 'r.sock')
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', () => {
        writeDiscovery(dir, live)
        socket.end(`${JSON.stringify({ hello: { ok: false, code: 'incompatible', reason: 'wrong token' } })}\n`)
      })
    })
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    writeDiscovery(dir, { ...live, endpoint, token: 'old', pid: 1 })
    const client = await clientOf(await ensurePtyHost(dir, { binary: null }))
    expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'ok' })
  })
})

describe('reachable', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('gives up on a connection that is never accepted, after its timeout', async () => {
    const socket = new net.Socket()
    const destroy = vi.spyOn(socket, 'destroy')
    vi.spyOn(net, 'connect').mockReturnValue(socket)
    const started = Date.now()
    expect(await reachable('/nowhere', 50)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(destroy).toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('is true for an endpoint that accepts, and false for one that refuses', async () => {
    const dir = tempDir('r-')
    const endpoint = path.join(dir, 'a.sock')
    const server = net.createServer(socket => socket.on('error', () => {}))
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    expect(await reachable(endpoint)).toBe(true)
    expect(await reachable(path.join(dir, 'none.sock'))).toBe(false)
  })
})

// Runs the real host: `cd pty && cargo +stable build`, then
// HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npx vitest run src/lib/ptyHost/launch.spec.ts
describe.skipIf(!process.env.HARNESS_PTY_BIN)('ensurePtyHost with the real harness-pty', () => {
  it('starts the host in a temporary home, lists no panes, and reports a pane\'s exit after its create', async () => {
    const dir = tempDir('h-')
    cleanup.push(() => {
      const pid = readDiscovery(dir, PTY_PROTOCOL)?.pid
      if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    })
    const client = await clientOf(await ensurePtyHost(dir))
    expect(client.instance).toBe(`p${PTY_PROTOCOL}`)
    expect(await client.call({ op: 'inventory' })).toEqual({ state: 'ok', value: { panes: [] } })

    // A command that exits at once: its exit notice may overtake the create reply.
    const exits: Array<string> = []
    const known = new Set<string>()
    client.onEvent(e => { if (e.event === 'exit') exits.push(`${known.has(e.pane) ? 'known' : 'unknown'} ${e.pane} ${e.status}`) })
    const created = await client.call({ op: 'create', command: ['/bin/sh', '-c', 'exit 3'], cols: 80, rows: 24, owner: 'test', hold: false })
    if (created.state !== 'ok') throw new Error(JSON.stringify(created))
    known.add(created.value.pane)
    await expect.poll(() => exits, { timeout: 5_000 }).toEqual([`known ${created.value.pane} 3`])

    const stream = await client.openStream()
    expect(stream).not.toBeNull()
    stream!.destroy()
  })
})
