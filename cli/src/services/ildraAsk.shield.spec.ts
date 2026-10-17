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
import { enrollBridge, proveBridge, fixturePhonePub } from './ildraAsk.testkit.js'
import { createIldraAsk } from './ildraAsk.js'
import { stampManifest, type ApprovalTemplate, type AskRequest } from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file', 'Pay a bill'], locked_ask: ['Brakes step'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const PHONE = fixturePhonePub('P')
const OTHER = 'X'.repeat(43) + '='
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function rig(clients: Record<string, IldraAskClient>) {
  const d = mkdtempSync(join(tmpdir(), 'shield-rt-'))
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:') })
  const journalPath = join(d, 'j', 'a.json')
  const svc = createIldraAsk({ inputs: core, journalPath, markerPath: join(d, 'm', 'x.installed') })
  const sent: AskRequest[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  // Shield R7-1 (Build): only a connection that proved the enrolled device key answers touch; fixture only, assertions unchanged.
  const cred = enrollBridge(core, svc, clients)
  const answer = (req: AskRequest, connection: string, extra: Record<string, unknown> = {}, local = false) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 2000, ...extra }, { local, owner: local, connection })
  const pairPhone = () => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer('p1', PHONE, code); p.confirm('p1', 'touch', true) }
  return { core, svc, sent, answer, pairPhone, journalPath, d, cred }
}

describe('Shield R5 runtime: who may answer an Ask', () => {
  // Flipped by Build (R5-1 fix): each REOPEN below now asserts the refusal; setup and inputs are Shield's.
  it('FIXED R5-1: any local process (the agent itself) answers a touch Ask over the local socket', async () => {
    const r = rig({})
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'agent-1', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'local:agent-shell', {}, true)).toEqual({ ok: false, reason: 'no_authority' })
    r.core.cancel(r.sent[0]!.id)
    expect(await p).toMatchObject({ approved: false })
  })
  it('FIXED R5-1: a local process names the paired phone id and approves a phone-only money Ask', async () => {
    const r = rig({})
    r.pairPhone()
    const p = r.svc.ask(T, 'Pay a bill', null, { kind, agentId: 'agent-1', available: ['phone'], amountMinor: 20000 })
    await tick()
    expect(r.sent[0]!.channel).toBe('phone')
    expect(await r.answer(r.sent[0]!, 'local:agent-shell', { from: { phoneId: 'p1' } }, true)).toEqual({ ok: false, reason: 'no_authority' })
    r.core.cancel(r.sent[0]!.id)
    expect(await p).toMatchObject({ approved: false })
  })
  it('FIXED R5-1: a remote connection that is not the paired phone (key X, phone paired as P) approves a locked_ask', async () => {
    const r = rig({ obs: { identity: OTHER, role: 'observer' }, web: { identity: OTHER, role: 'web' }, ph: { identity: PHONE, role: 'web' } })
    r.pairPhone()
    const p = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'obs', { from: { phoneId: 'p1' } })).toEqual({ ok: false, reason: 'no_authority' })
    // Not an observer, but still not the paired phone's key: refused (R7-10: first, nothing recorded or spent).
    const before = JSON.stringify(r.svc.journal().ledger.toJSON().spent)
    await r.answer(r.sent[0]!, 'web', { from: { phoneId: 'p1' } })
    await tick()
    expect(r.svc.journal().ledger.pending()).toBe(1)
    expect(JSON.stringify(r.svc.journal().ledger.toJSON().spent)).toBe(before)
    // The real phone (its paired key) still approves the same Ask.
    const open = r.sent[r.sent.length - 1]!
    await r.answer(open, 'ph', { from: { phoneId: 'p1' } })
    expect(await p).toMatchObject({ approved: true, channel: 'phone' })
  })
  it('FIXED R5-1: a non-device remote client answers a touch Ask as the device', async () => {
    const r = rig({ web: { identity: OTHER, role: 'web' } })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    await r.answer(r.sent[0]!, 'web')
    await tick()
    expect(r.svc.journal().ledger.pending()).toBe(1) // wrong_channel: refused, Ask not spent
    r.core.cancel(r.sent[r.sent.length - 1]!.id)
    expect(await p).toMatchObject({ approved: false })
  })
  it('a gateway-shared connection, an unknown connection, or none never approves', async () => {
    const r = rig({ sh: { identity: OTHER, role: 'web', shared: true } })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.core.requests.ildra_ask_answer({ id: r.sent[0]!.id, digest8: r.sent[0]!.digest8, answerId: aid(), approved: true, holdMs: 2000 }, { local: false, owner: true, connection: 'ghost' })).toEqual({ ok: false, reason: 'no_authority' }) // v3.3: was no_connection; one wire name (AskRejectionReason no_authority), noted by Build
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
    proveBridge(r2core, 'dev', r.cred!) // Shield R7-1 (Build): the bridge proves the device key again after a restart
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
  it('FIXED R5-4: short holds are capped per Ask (5): the fifth spends it; each one is journaled and its answerId kept until expiry', async () => {
    const r = rig({ dev: { identity: DEV, role: 'device' } })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    const req = r.sent[0]!
    for (let i = 0; i < 60; i++) { await r.answer(req, 'dev', { holdMs: 100 }); await tick() }
    const onDisk = JSON.parse(readFileSync(r.journalPath, 'utf8')) as { ledger: { open: { id: string }[]; spentAnswers: unknown[]; attempts: unknown[] } }
    expect(onDisk.ledger.open.map((o) => o.id)).not.toContain(req.id) // spent by the fifth short hold
    expect(onDisk.ledger.spentAnswers.length).toBeGreaterThanOrEqual(5)
    expect(onDisk.ledger.attempts).toHaveLength(5)
    expect(await p).toMatchObject({ approved: false, reason: 'hold_limit' })
  })
})
