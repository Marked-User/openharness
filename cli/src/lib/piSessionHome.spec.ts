import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { bringPiSessionHome } from './piSessionHome.js'

let root: string, configs: string, sessions: string
const FOLDER = '--Users-me-harnesses-qwen-image--'
const FILE = '2026-10-14T03-37-38-090Z_01a1387c-b029-75b7-b0f0-925d65eb8121.jsonl'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-home-'))
  configs = join(root, 'grid-launch-config')
  sessions = join(root, 'pi', 'agent', 'sessions')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A conversation where a grid launch that moved Pi's home left it (2026-10-14, `grid-launch-config/<digest>/sessions`). */
function leftBehind(content = '{"type":"session"}\n'): string {
  const dir = join(configs, 'c88e545a', 'sessions', FOLDER)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, FILE), content)
  return join(dir, FILE)
}

it("copies a conversation an older grid launch left in the daemon's folder into Pi's own sessions", () => {
  const old = leftBehind()
  expect(bringPiSessionHome(old, [configs], sessions)).toBe(join(sessions, FOLDER, FILE))
  expect(readFileSync(join(sessions, FOLDER, FILE), 'utf8')).toBe('{"type":"session"}\n')
  // A copy: the original stays, in case anything still reads it.
  expect(readFileSync(old, 'utf8')).toBe('{"type":"session"}\n')
})

it('never replaces a conversation already in Pi\'s own sessions', () => {
  const old = leftBehind('{"old":true}\n')
  mkdirSync(join(sessions, FOLDER), { recursive: true })
  writeFileSync(join(sessions, FOLDER, FILE), '{"home":true}\n')
  expect(bringPiSessionHome(old, [configs], sessions)).toBe(join(sessions, FOLDER, FILE))
  expect(readFileSync(join(sessions, FOLDER, FILE), 'utf8')).toBe('{"home":true}\n')
})

it('leaves a conversation that is already home, or anywhere else, alone', () => {
  expect(bringPiSessionHome(join(sessions, FOLDER, FILE), [configs], sessions)).toBeNull()
  expect(bringPiSessionHome(join(root, 'elsewhere', 'sessions', FOLDER, FILE), [configs], sessions)).toBeNull()
  expect(bringPiSessionHome(join(configs, 'c88e545a', 'auth.json'), [configs], sessions)).toBeNull()
  expect(bringPiSessionHome(null, [configs], sessions)).toBeNull()
  // Pruned with its folder (30 days, gridConfigDir.ts) or removed: nothing to bring, and nothing thrown.
  expect(bringPiSessionHome(join(configs, 'gone', 'sessions', FOLDER, FILE), [configs], sessions)).toBeNull()
})
