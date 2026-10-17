/**
 * Shield final M1 check (security/FINDINGS.md, round 5): the daemon's real Ask runtime, core/ildraAsk.ts plus
 * services/ildraAsk.ts composed the way core/main.ts composes them, driven through `ildra_ask_answer`.
 * Tests named REOPEN assert today's unsafe behavior so a fix flips them.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { createIldraAsk } from './ildraAsk.js'
import { type ApprovalTemplate, type AskRequest } from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file', 'Pay a bill'], locked_ask: ['Brakes step'] } }
const kind = { manifest: [{ name: 'fs.rename', send: false, owner: 'bridge' }], tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const PHONE = 'P'.repeat(43) + '='
const OTHER = 'X'.repeat(43) + '='
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function rig(clients: Record<string, IldraAskClient>) {
  const d = mkdtempSync(join(tmpdir(), 'shield-rt-'))
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:') })
  const journalPath = join(d, 'j', 'a.json')
  const svc = createIldraAsk({ inputs: core, journalPath, markerPath: join(d, 'm', 'x.installed') })
  const sent: AskRequest[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  const answer = (req: AskRequest, connection: string, extra: Record<string, unknown> = {}, local = false) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 2000, ...extra }, { local, owner: local, connection })
  const pairPhone = () => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer('p1', PHONE, code); p.confirm('p1', 'touch', true) }
  return { core, svc, sent, answer, pairPhone, journalPath, d }
}

describe('Shield R5 runtime: who may answer an Ask', () => {
  it('REOPEN R5-1: any local process (the agent itself) answers a touch Ask over the local socket', async () => {
    const r = rig({})
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'agent-1', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'local:agent-shell', {}, true)).toEqual({ ok: true })
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
  })
  it('REOPEN R5-1: a local process names the paired phone id and approves a phone-only money Ask', async () => {
    const r = rig({})
    r.pairPhone()
    const p = r.svc.ask(T, 'Pay a bill', null, { kind, agentId: 'agent-1', available: ['phone'], amountMinor: 20000 })
    await tick()
    expect(r.sent[0]!.channel).toBe('phone')
    await r.answer(r.sent[0]!, 'local:agent-shell', { from: { phoneId: 'p1' } }, true)
    expect(await p).toMatchObject({ approved: true, channel: 'phone' })
  })
  it('REOPEN R5-1: a remote connection that is not the paired phone (key X, phone paired as P) approves a locked_ask', async () => {
    const r = rig({ obs: { identity: OTHER, role: 'observer' } })
    r.pairPhone()
    const p = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await tick()
    await r.answer(r.sent[0]!, 'obs', { from: { phoneId: 'p1' } })
    expect(await p).toMatchObject({ approved: true, channel: 'phone' })
  })
  it('REOPEN R5-1: a non-device remote client answers a touch Ask as the device', async () => {
    const r = rig({ web: { identity: OTHER, role: 'web' } })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    await r.answer(r.sent[0]!, 'web')
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
  })
  it('a gateway-shared connection, an unknown connection, or none never approves', async () => {
    const r = rig({ sh: { identity: OTHER, role: 'web', shared: true } })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.core.requests.ildra_ask_answer({ id: r.sent[0]!.id, digest8: r.sent[0]!.digest8, answerId: aid(), approved: true, holdMs: 2000 }, { local: false, owner: true, connection: 'ghost' })).toEqual({ ok: false, reason: 'no_connection' })
    await r.answer(r.sent[0]!, 'sh', { from: { machinePub: DEV, shared: false } })
    expect(await p).toMatchObject({ approved: false, reason: 'shared_machine' })
  })
  it('F13 runtime: the core guard the terminal path consults blocks remote input while the Ask waits, and frees it after', async () => {
    const r = rig({ dev: { identity: DEV, role: 'device' } })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'agent-7', available: ['touch'] })
    await tick()
    expect(r.core.guard.filterInput('agent-7', 'remote')).toBe('block')
    expect(r.core.guard.filterInput('agent-7', 'local')).toBe('pass')
    await r.answer(r.sent[0]!, 'dev', { approved: false })
    await p
    expect(r.core.guard.filterInput('agent-7', 'remote')).toBe('pass')
  })
})

describe('Shield R5 runtime: answerId and hold_too_short', () => {
  it('an answerId spent before a restart is still spent after it, on a new Ask', async () => {
    const r = rig({ dev: { identity: DEV, role: 'device' } })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    const used = aid()
    await r.answer(r.sent[0]!, 'dev', { answerId: used })
    expect((await p).approved).toBe(true)
    const r2core = createIldraAskCore({ clientOf: () => ({ identity: DEV, role: 'device' }), isLoopback: () => false })
    const svc2 = createIldraAsk({ inputs: r2core, journalPath: r.journalPath, markerPath: join(r.d, 'm', 'x.installed') })
    const sent2: AskRequest[] = []
    svc2.bridge = (_c, _p, req) => { sent2.push(req) }
    const p2 = svc2.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    await r2core.requests.ildra_ask_answer({ id: sent2[0]!.id, digest8: sent2[0]!.digest8, answerId: used, approved: true, holdMs: 2000 }, { local: false, owner: false, connection: 'dev' })
    expect(await p2).toMatchObject({ approved: false, reason: 'replayed' })
  })
  it('short holds never approve and leak nothing: a wrong digest8 spends the Ask before any hold check', async () => {
    const r = rig({ dev: { identity: DEV, role: 'device' } })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    await r.answer(r.sent[0]!, 'dev', { holdMs: 10, digest8: '00000000' })
    expect(await p).toMatchObject({ approved: false, reason: 'digest_mismatch' })
  })
  it('GAP R5-4: short holds are not capped per Ask; each one is journaled and its answerId kept until expiry', async () => {
    const r = rig({ dev: { identity: DEV, role: 'device' } })
    void r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    const req = r.sent[0]!
    for (let i = 0; i < 60; i++) { await r.answer(req, 'dev', { holdMs: 100 }); await tick() }
    const onDisk = JSON.parse(readFileSync(r.journalPath, 'utf8')) as { ledger: { open: { id: string }[]; spentAnswers: unknown[] } }
    expect(onDisk.ledger.open.map((o) => o.id)).toContain(req.id) // still open after 60 short holds
    expect(onDisk.ledger.spentAnswers.length).toBeGreaterThanOrEqual(60)
    r.core.cancel(req.id)
  })
})
