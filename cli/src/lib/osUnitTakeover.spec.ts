import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { askRuntimePort, inUnit, readCgroup, takeRuntimeBack, type RuntimeServer, type TakeoverDeps } from './osUnitTakeover.js'

const UNIT = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/harness-daemon.service\n'
const SCREEN = '0::/user.slice/user-1000.slice/session-2.scope\n'

/** A computer: who serves, each process's cgroup, which are alive, and what was done to them. */
function computer(server: RuntimeServer, cgroups: Record<string, string | null>, options: { stubborn?: boolean } = {}) {
  const alive = new Set(typeof server === 'object' ? [server.pid, server.corePid] : [])
  const signals: [number, NodeJS.Signals][] = []
  const lines: string[] = []
  let now = 0
  const deps: TakeoverDeps = {
    who: async () => server,
    cgroupOf: (pid) => cgroups[String(pid)] ?? null,
    alive: (pid) => alive.has(pid),
    signal: (pid, signal) => {
      signals.push([pid, signal])
      if (!options.stubborn || signal === 'SIGKILL') alive.delete(pid)
    },
    sleep: async (ms) => { now += ms },
    now: () => now,
    log: (line) => lines.push(line),
  }
  return { deps, signals, lines, alive }
}

describe('taking the agent runtime back for harness-daemon.service', () => {
  it('stops a daemon an older CLI started outside the unit, master and core, and goes on', async () => {
    const pc = computer({ pid: 300, corePid: 301 }, { self: UNIT, 300: SCREEN })
    expect(await takeRuntimeBack(pc.deps)).toBe('stopped')
    expect(pc.signals).toEqual([[300, 'SIGTERM'], [301, 'SIGTERM']])
    expect(pc.lines[0]).toContain('outside harness-daemon.service (pid 300)')
  })

  it('ends one that does not stop in time', async () => {
    const pc = computer({ pid: 300, corePid: 300 }, { self: UNIT, 300: SCREEN }, { stubborn: true })
    expect(await takeRuntimeBack(pc.deps, 1_000)).toBe('stopped')
    expect(pc.signals).toEqual([[300, 'SIGTERM'], [300, 'SIGKILL']])
    expect(pc.lines[1]).toContain('did not stop within 1s')
  })

  it('leaves alone the unit\'s own daemon, one it cannot see, and every start that is not the unit\'s', async () => {
    for (const [server, cgroups] of [
      [{ pid: 300, corePid: 301 }, { self: UNIT, 300: UNIT }],
      [{ pid: 300, corePid: 301 }, { self: UNIT, 300: null }],
      [{ pid: 300, corePid: 301 }, { self: SCREEN, 300: SCREEN }],
      [{ pid: 300, corePid: 301 }, { self: null, 300: SCREEN }],
      ['none', { self: UNIT }],
      ['unknown', { self: UNIT }],
    ] as [RuntimeServer, Record<string, string | null>][]) {
      const pc = computer(server, cgroups)
      expect(await takeRuntimeBack(pc.deps)).toBe('none')
      expect(pc.signals).toEqual([])
    }
  })

  it('reads a cgroup line as the unit\'s only for harness-daemon.service itself', () => {
    expect(inUnit(UNIT)).toBe(true)
    expect(inUnit('0::/user.slice/user@1000.service/app.slice/harness-daemon.service/core\n')).toBe(true)
    expect(inUnit(SCREEN)).toBe(false)
    expect(inUnit('0::/user.slice/user@1000.service/app.slice/harness-daemon.service-old\n')).toBe(false)
    expect(readCgroup(2 ** 30)).toBeNull()
  })
})

describe('asking the runtime port who it is', () => {
  let server: Server | null = null
  afterEach(() => { server?.close(); server = null })

  async function answering(body: string): Promise<number> {
    server = createServer((_request, response) => response.end(body))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return (server.address() as { port: number }).port
  }

  it('reads the pid, and the core when the daemon has a master', async () => {
    expect(await askRuntimePort(await answering('{"pid":12,"corePid":13}'))).toEqual({ pid: 12, corePid: 13 })
  })

  it('takes a daemon from before harnessd as its own core', async () => {
    expect(await askRuntimePort(await answering('{"pid":12}'))).toEqual({ pid: 12, corePid: 12 })
  })

  it('is unknown when the answer names nobody, and none when nothing answers', async () => {
    expect(await askRuntimePort(await answering('{"pid":"x"}'))).toBe('unknown')
    expect(await askRuntimePort(await answering('not json'))).toBe('none')
    expect(await askRuntimePort(1, 200)).toBe('none')
  })
})
