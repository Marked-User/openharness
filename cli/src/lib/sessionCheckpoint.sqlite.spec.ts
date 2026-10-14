import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'

let root: string
const databases: Array<{ close(): void }> = []
beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'harness-checkpoint-wal-'))
  for (const key of ['OPENCODE_DATA_DIR', 'KILO_DATA_DIR', 'HERMES_HOME', 'DEVIN_HOME']) vi.stubEnv(key, root)
})
afterEach(async () => {
  const { closeSqliteHandles } = await import('./sqliteBuiltin.js')
  closeSqliteHandles()
  for (const database of databases.splice(0)) database.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each(['opencode', 'kilo', 'hermes', 'devin'] as const)('backs up only the selected %s conversation while its real database has a live WAL', async engine => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as any
  const path = join(root, engine === 'opencode' ? 'opencode.db' : engine === 'kilo' ? 'kilo.db' : engine === 'hermes' ? 'state.db' : 'sessions.db')
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  if (engine === 'opencode' || engine === 'kilo') {
    database.exec(`CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, body TEXT);
      INSERT INTO session VALUES ('wanted'), ('other'); INSERT INTO message VALUES ('m1', 'wanted', 'history in WAL'), ('m2', 'other', 'unrelated private text');
      INSERT INTO part VALUES ('p1', 'm1', 'wanted attachment'), ('p2', 'm2', 'unrelated private text');`)
  } else {
    const table = engine === 'hermes' ? 'messages' : 'message_nodes'
    database.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE ${table} (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
      INSERT INTO sessions VALUES ('wanted'), ('other'); INSERT INTO ${table} VALUES ('m1', 'wanted', 'history in WAL'), ('m2', 'other', 'unrelated private text');`)
  }
  expect(readdirSync(root)).toContain(`${path.split('/').at(-1)}-wal`)
  const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  await new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'wanted', engine, hermesHome: root } as RegisteredSession)
  const manifest = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(f => f.endsWith('.json'))!), 'utf8'))
  const backup = readFileSync(join(directory, manifest.file), 'utf8')
  expect(backup).toContain('history in WAL')
  expect(backup).not.toContain('unrelated private text')
  expect(database.prepare(`SELECT count(*) AS n FROM ${engine === 'opencode' || engine === 'kilo' ? 'session' : 'sessions'}`).get().n).toBe(2)
})

it('backs up an OpenCode 2 conversation from its v2 tables, and a v1 one from the same file as before', async () => {
  // OpenCode 2.0.24 writes `session_v2` / `session_message` and leaves the v1 tables holding only older chats. Read
  // there, a v2 chat was "not found" and its harness could never be closed (2026-10-14).
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as any
  const database = new DatabaseSync(join(root, 'opencode.db'))
  databases.push(database)
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, body TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    INSERT INTO session VALUES ('older'); INSERT INTO message VALUES ('m0', 'older', 'a v1 chat'); INSERT INTO part VALUES ('p0', 'm0', 'v1 part');
    INSERT INTO session_v2 VALUES ('wanted'), ('other');
    INSERT INTO session_message VALUES ('s1', 'wanted', 'history in v2'), ('s2', 'other', 'unrelated private text');`)
  const { SessionCheckpointStore, SessionCheckpointError } = await import('./sessionCheckpoint.js')
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  const store = new SessionCheckpointStore(directory)
  const backup = async (sessionId: string) => {
    await store.save({ agentId: sessionId, sessionId, engine: 'opencode' } as RegisteredSession)
    const manifest = readdirSync(directory).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(directory, f), 'utf8'))).find(m => m.sessionId === sessionId)
    return JSON.parse(readFileSync(join(directory, manifest.file), 'utf8'))
  }
  const v2 = await backup('wanted')
  expect(Object.keys(v2.tables)).toEqual(['session_v2', 'session_message'])
  expect(JSON.stringify(v2)).toContain('history in v2')
  expect(JSON.stringify(v2)).not.toContain('unrelated private text')
  const v1 = await backup('older')
  expect(Object.keys(v1.tables)).toEqual(['session', 'message', 'part'])
  expect(JSON.stringify(v1)).toContain('v1 part')
  // In neither: nothing to keep, so the session stays open.
  await expect(store.save({ agentId: 'gone', sessionId: 'gone', engine: 'opencode' } as RegisteredSession)).rejects.toBeInstanceOf(SessionCheckpointError)
})
