/**
 * Shield round 7 checks of the Ask gate on 1ab93b44c (R7-1 device proof and phone-confirmed enrollment, R7-10
 * unpaired phone answers, ledger channel stamp). Written by Shield, independent of Build's specs. Each test is an
 * attack that must fail (security/FINDINGS.md, "Final M1 Ask-gate check, round 7").
 */
import { randomBytes, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deviceProofMessage } from '../core/api.js'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { createIldraAsk } from './ildraAsk.js'
import { deviceKeyPair, proveBridge } from './ildraAsk.testkit.js'
import { AskLedger, openJournal, stampManifest, type ApprovalTemplate, type AskAnswer, type AskRequest } from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file'], locked_ask: ['Brakes step'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const DEV2 = 'E'.repeat(43) + '='
const PHONE = 'P'.repeat(43) + '='
const OTHER = 'X'.repeat(43) + '='
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const CLIENTS: Record<string, IldraAskClient> = {
  dev: { identity: DEV, role: 'device' }, dev2: { identity: DEV2, role: 'device' },
  ph: { identity: PHONE, role: 'web' }, web: { identity: OTHER, role: 'web' }, obs: { identity: OTHER, role: 'observer' },
}

function rig(dir = mkdtempSync(join(tmpdir(), 'shield-r7-')), now?: () => number) {
  const core = createIldraAskCore({ clientOf: (c) => CLIENTS[c] ?? null, isLoopback: (c) => c.startsWith('local:'), ...(now ? { now } : {}) })
  const svc = createIldraAsk({ inputs: core, journalPath: join(dir, 'j', 'a.json'), markerPath: join(dir, 'm', 'x.installed'), ...(now ? { now } : {}) })
  const sent: AskRequest[] = []
  const events: { type: string; body: unknown }[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  svc.events = (type, body) => { events.push({ type, body }) }
  const asker = (connection: string, local = false) => ({ local, owner: local, connection })
  const answer = (req: AskRequest, connection: string, extra: Record<string, unknown> = {}) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 2000, ...extra }, asker(connection))
  const pairPhone = () => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer('p1', PHONE, code); p.confirm('p1', 'touch', true) }
  const confirm = (connection: string, devicePub: string, approved = true, phoneId = 'p1') =>
    core.requests.ildra_device_enroll_confirm({ devicePub, approved, from: { phoneId } }, asker(connection))
  return { core, svc, sent, events, answer, pairPhone, confirm, asker, dir }
}

/** The real setup path: the device asks to enroll its key, the paired phone confirms it over its own connection. */
async function enrollViaPhone(r: ReturnType<typeof rig>) {
  const kp = deviceKeyPair()
  expect(await r.core.requests.ildra_device_enroll({ devicePub: kp.pub }, r.asker('dev'))).toMatchObject({ ok: true })
  expect(await r.confirm('ph', kp.pub)).toEqual({ ok: true, state: 'enrolled' })
  return kp
}

describe('Shield R7-1: device proof', () => {
  it('a nonce is single use, bound to its connection, expires at 60 s, and does not survive a restart', async () => {
    let t = 1_000_000
    const r = rig(undefined, () => t)
    r.pairPhone()
    const kp = await enrollViaPhone(r)
    const nonce = r.core.challengeDevice('dev')!
    const sig = sign(null, Buffer.from(deviceProofMessage(nonce), 'utf8'), kp.key).toString('base64')
    expect(r.core.proveDevice('dev2', sig)).toBe(false) // another connection cannot use it
    expect(r.core.proveDevice('dev', sig)).toBe(true)
    expect(r.core.proveDevice('dev', sig)).toBe(false) // single use
    const n2 = r.core.challengeDevice('dev')!
    t += 60_000
    expect(r.core.proveDevice('dev', sign(null, Buffer.from(deviceProofMessage(n2), 'utf8'), kp.key).toString('base64'))).toBe(false)
    // A restarted core (same journal) has no nonce: the old signature proves nothing, and the bridge is not trusted.
    const r2 = rig(r.dir, () => t)
    expect(r2.core.proveDevice('dev', sig)).toBe(false)
    const p = r2.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r2.answer(r2.sent[0]!, 'dev')).toEqual({ ok: false, reason: 'no_authority' })
    expect(proveBridge(r2.core, 'dev', kp.key)).toBe(true)
    await r2.answer(r2.sent[0]!, 'dev')
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
  })
  it('a key that asked to enroll but is not phone-confirmed gets no nonce and answers nothing', async () => {
    const r = rig()
    r.pairPhone()
    const kp = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: kp.pub }, r.asker('dev'))
    expect(r.core.challengeDevice('dev')).toBeNull()
    expect(proveBridge(r.core, 'dev', kp.key)).toBe(false)
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'dev')).toEqual({ ok: false, reason: 'no_authority' })
    r.core.cancel(r.sent[0]!.id); await p
  })
  it('enrollment cannot be confirmed by an unpaired key, an observer, the device, or the local socket', async () => {
    const r = rig()
    r.pairPhone()
    const kp = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: kp.pub }, r.asker('dev'))
    expect(await r.confirm('web', kp.pub)).toEqual({ ok: false, reason: 'unpaired_phone' })
    expect(await r.confirm('obs', kp.pub)).toEqual({ ok: false, reason: 'no_authority' })
    expect(await r.confirm('dev', kp.pub)).toEqual({ ok: false, reason: 'no_authority' })
    expect(await r.core.requests.ildra_device_enroll_confirm({ devicePub: kp.pub, approved: true, from: { phoneId: 'p1' } }, r.asker('local:agent', true))).toEqual({ ok: false, reason: 'no_authority' })
    expect(r.svc.journal().device.device()).toBeNull()
    expect(r.svc.journal().device.pending()).not.toBeNull()
  })
  it('a phone-revoked device loses touch authority at once, cannot prove again, and the next device needs the phone again', async () => {
    const r = rig()
    r.pairPhone()
    const kp = await enrollViaPhone(r)
    expect(proveBridge(r.core, 'dev', kp.key)).toBe(true)
    expect(await r.confirm('ph', kp.pub, false)).toEqual({ ok: true, state: 'revoked' })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'dev')).toEqual({ ok: false, reason: 'no_authority' }) // the proved bridge was cleared
    expect(proveBridge(r.core, 'dev', kp.key)).toBe(false)
    expect(await r.answer(r.sent[0]!, 'dev')).toEqual({ ok: false, reason: 'no_authority' })
    r.core.cancel(r.sent[0]!.id)
    expect(await p).toMatchObject({ approved: false })
  })
  it('NOTE R8-1: a pending enrollment is replaced by any later request, so the phone confirm is the only check (the fingerprint must be compared on both screens)', async () => {
    const r = rig()
    r.pairPhone()
    const real = deviceKeyPair(); const evil = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: real.pub }, r.asker('dev'))
    await r.core.requests.ildra_device_enroll({ devicePub: evil.pub }, r.asker('local:agent', true)) // the local owner socket may ask too
    expect(r.svc.journal().device.pending()!.devicePub).toBe(evil.pub)
    expect(await r.confirm('ph', real.pub)).toEqual({ ok: false, reason: 'unknown_id' }) // the real one was pushed out
  })
})

describe('Shield R7-10: unpaired phone answers', () => {
  it('a flood of unpaired answers spends nothing, the real phone still approves, and the phone gets one aggregate count with no ids or keys', async () => {
    const r = rig()
    r.pairPhone()
    const p = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await tick()
    for (let i = 0; i < 40; i++) { await r.answer(r.sent[r.sent.length - 1]!, 'web', { from: { phoneId: 'p1' } }); await tick() }
    expect(r.svc.journal().ledger.pending()).toBe(1)
    expect(r.svc.journal().ledger.toJSON().spent).toEqual([])
    await r.answer(r.sent[r.sent.length - 1]!, 'ph', { from: { phoneId: 'p1' } })
    expect(await p).toMatchObject({ approved: true, channel: 'phone' })
    const agg = r.events.filter((e) => e.type === 'ildra.ask.unpaired')
    expect(agg).toHaveLength(1)
    expect(Object.keys(agg[0]!.body as object).sort()).toEqual(['at', 'count', 'since'])
    expect(JSON.stringify(agg)).not.toContain(OTHER)
    // NOTE: each refused answer re-delivers the prompt (40 floods, 41 prompts): bounded by the Ask's expiry, not a cap.
    expect(r.sent.length).toBeGreaterThan(40)
  })
})

describe('Shield R7 ledger channel stamp', () => {
  it('the Ask service journal refuses an answer object nobody stamped, even one that says via phone with the paired key', () => {
    const d = mkdtempSync(join(tmpdir(), 'shield-r7s-'))
    const j = openJournal(join(d, 'j', 'a.json'), { requireChannelStamp: true, markerPath: join(d, 'm', 'x') })
    const { code } = j.pairing.begin('touch'); j.pairing.offer('p1', PHONE, code); j.pairing.confirm('p1', 'touch', true)
    const r = j.ledger.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone' })
    const forged: AskAnswer = { id: r.id, digest8: r.digest8, answerId: aid(), approved: true, via: 'phone', from: { phoneId: 'p1', machinePub: PHONE } }
    const out = j.ledger.settle(forged, { isPaired: (id, pub) => (pub === undefined ? j.pairing.isPaired(id) : j.pairing.isPairedKey(id, pub)) })
    expect(out.ok).toBe(false)
    expect(j.ledger.settle({ ...forged, answerId: aid() } as AskAnswer, {}).ok).toBe(false)
    expect(new AskLedger().pending()).toBe(0)
  })
})

describe('Shield R7 harness pair residual', () => {
  it('a gateway pairing as a device (any device-role identity) or as a browser (web) grants neither touch nor phone authority', async () => {
    const r = rig()
    r.pairPhone()
    await enrollViaPhone(r) // the real device is enrolled; dev2 is a self-paired device-role key
    const pt = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'dev2')).toEqual({ ok: false, reason: 'no_authority' })
    expect(r.core.challengeDevice('dev2')).not.toBeNull() // it may ask for a nonce, but cannot sign as the device
    expect(proveBridge(r.core, 'dev2', deviceKeyPair().key)).toBe(false)
    r.core.cancel(r.sent[0]!.id); await pt
    const pp = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await tick()
    const before = r.svc.journal().ledger.pending()
    await r.answer(r.sent[r.sent.length - 1]!, 'web', { from: { phoneId: 'p1' } })
    await tick()
    expect(r.svc.journal().ledger.pending()).toBe(before)
    r.core.cancel(r.sent[r.sent.length - 1]!.id)
    expect(await pp).toMatchObject({ approved: false })
  })
})
