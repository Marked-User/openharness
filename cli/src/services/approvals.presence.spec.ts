/**
 * (i), (g): device presence for devices without touch (clip, rugged camera), the device inputs and form recorded at
 * enroll, the phone's abort, and a reset device enrolling as new. Volt's pattern and signing rules.
 */
import { createHash, randomBytes, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { ledgerConfirmMessage, presenceAbortMessage, presenceMessage, presencePattern, unpairMessage } from '../core/ildraDeviceProof.js'
import { createIldraAsk } from './ildraAsk.js'
import { deviceKeyPair, phoneKeyPair, proveBridge, signedConfirm } from './ildraAsk.testkit.js'
import { stampManifest, type ApprovalTemplate, type AskRequest } from './approvals.js'

const DEV = 'D'.repeat(43) + '='
const aid = (): string => randomBytes(16).toString('hex')
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); for (let i = 0; i < 20; i++) await Promise.resolve() }
const sig = (key: KeyObject, m: string): string => sign(null, Buffer.from(m, 'utf8'), key).toString('base64')
type Ch = { requestId: string; method: string; groups?: [number, number]; pattern?: { on_ms: number; off_ms: number }[]; nonce: string; expiresAt: number }

function rig(o: { inputs?: unknown; form?: string; phones?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'build-presence-')); const clock = { t: 7_000_000 }
  const K = { P1: phoneKeyPair(), P2: phoneKeyPair(), D1: phoneKeyPair(), DEVK: deviceKeyPair() }
  const clients: Record<string, IldraAskClient> = { ph1: { identity: K.P1.pub, role: 'web' }, ph2: { identity: K.P2.pub, role: 'web' }, dev: { identity: DEV, role: 'device' } }
  const now = () => clock.t
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:'), now })
  const svc = createIldraAsk({ inputs: core, journalPath: join(dir, 'j', 'a.json'), markerPath: join(dir, 'm', 'x.installed'), now })
  const events: { type: string; body: unknown }[] = []
  const sent: AskRequest[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  svc.events = (type, body) => { events.push({ type, body }) }
  const remote = (connection: string) => ({ local: false, owner: false, connection })
  const pair = (id: string, pub: string) => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer(id, pub, code); p.confirm(id, 'touch', true) }
  pair('p1', K.P1.pub); if ((o.phones ?? 1) > 1) pair('p2', K.P2.pub)
  const enroll = async (dev = K.DEVK, caps: Record<string, unknown> = { inputs: o.inputs ?? ['button'], form: o.form ?? 'clip' }) => {
    const e = await core.requests.ildra_device_enroll({ devicePub: dev.pub, ...caps }, remote('dev'))
    if (!e.ok) return e
    return core.requests.ildra_device_enroll_confirm({ ...signedConfirm(svc, K.P1.key, dev.pub, true, 'biometric', K.D1.pub), from: { phoneId: 'p1' } }, remote('ph1'))
  }
  const challenge = () => events.filter((e) => e.type === 'ildra.presence.challenge').at(-1)?.body as Ch | undefined
  const press = (c: Ch, x: { heldMs?: number; kind?: string; nonce?: string; requestId?: string; key?: KeyObject; conn?: string } = {}) => {
    const heldMs = x.heldMs ?? 3000; const nonce = x.nonce ?? c.nonce; const requestId = x.requestId ?? c.requestId
    return core.requests.ildra_device_presence({ requestId, kind: x.kind ?? (c.method === 'blink_button' ? 'button_hold' : 'screen_hold'), heldMs, nonce, signature: sig(x.key ?? K.DEVK.key, presenceMessage(requestId, nonce, heldMs)) }, remote(x.conn ?? 'dev'))
  }
  const abort = (c: Ch, key: KeyObject = K.P1.key, at = clock.t) => core.requests.ildra_presence_abort({ requestId: c.requestId, at, phoneSignature: sig(key, presenceAbortMessage(c.requestId, at)), from: { phoneId: 'p1' } }, remote('ph1'))
  const head = async () => ((await core.requests.ildra_pairing_ledger({ from: { phoneId: 'p1' } }, remote('ph1'))) as { head: { seq: number; hash: string } }).head
  const confirm = async () => { const h = await head(); const at = clock.t; return core.requests.ildra_ledger_confirm({ head: h.hash, seq: h.seq, at, phoneSignature: sig(K.P1.key, ledgerConfirmMessage(h.hash, h.seq, at)), from: { phoneId: 'p1' } }, remote('ph1')) }
  const kinds = () => svc.journal().pairingLedger.all().map((e) => e.kind)
  return { dir, clock, K, core, svc, events, sent, remote, enroll, challenge, press, abort, confirm, head, kinds }
}

describe('(i)/(g) enroll records the device inputs and form; no_physical_input', () => {
  it('inputs and form go on ildra.device.enroll, the enrolled record and ildra.device.enroll.status; absent inputs mean touch', async () => {
    const r = rig()
    expect(await r.enroll()).toEqual({ ok: true, state: 'enrolled' })
    expect(r.events.find((e) => e.type === 'ildra.device.enroll')!.body).toMatchObject({ inputs: ['button'], form: 'clip' })
    expect(r.events.find((e) => e.type === 'ildra.device.enroll.status')!.body).toMatchObject({ state: 'enrolled', inputs: ['button'], form: 'clip' })
    expect(r.svc.journal().device.enrolled()).toMatchObject({ inputs: ['button'], form: 'clip' })
    const r2 = rig(); expect(await r2.enroll(r2.K.DEVK, {})).toEqual({ ok: true, state: 'enrolled' })
    expect(r2.svc.journal().device.inputs()).toEqual(['touch'])
  })
  it('empty inputs: no_physical_input (the only device would have none), journaled; bad inputs or form: malformed', async () => {
    const r = rig()
    expect(await r.core.requests.ildra_device_enroll({ devicePub: r.K.DEVK.pub, inputs: [] }, r.remote('dev'))).toEqual({ ok: false, reason: 'no_physical_input' })
    expect(r.svc.journal().pairingLedger.all().at(-1)).toMatchObject({ kind: 'device_refused', reason: 'no_physical_input' })
    expect(r.svc.journal().device.pending()).toBeNull()
    for (const caps of [{ inputs: ['knob'] }, { inputs: ['touch', 'touch'] }, { inputs: 'touch' }, { inputs: ['touch'], form: 'toaster' }]) {
      expect(await r.core.requests.ildra_device_enroll({ devicePub: r.K.DEVK.pub, ...caps }, r.remote('dev')), JSON.stringify(caps)).toEqual({ ok: false, reason: 'malformed' })
    }
    for (const form of ['core', 'sphere', 'clip', 'rugged_camera', 'lamp', 'pocket', 'tablet', 'other']) {
      expect(await r.core.requests.ildra_device_enroll({ devicePub: r.K.DEVK.pub, inputs: ['button'], form }, r.remote('dev'))).toMatchObject({ ok: true })
    }
  })
})

describe('(i) presencePattern: Volt firmware rule', () => {
  it('b = first byte of SHA-256(utf8 "ildra-presence-v1" || requestId || nonce); groups ((b>>2)&3)+1, (b&3)+1; g1 blinks, gap, g2 blinks', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'; const nonce = 'A'.repeat(43)
    const b = createHash('sha256').update(`ildra-presence-v1${id}${nonce}`, 'utf8').digest()[0]!
    const p = presencePattern(id, nonce)
    expect(p.b).toBe(b)
    expect(p.groups).toEqual([((b >> 2) & 3) + 1, (b & 3) + 1])
    expect(p.pattern).toHaveLength(p.groups[0] + p.groups[1])
    expect(p.pattern[p.groups[0] - 1]).toEqual({ on_ms: 300, off_ms: 1200 })
    expect(p.pattern.at(-1)).toEqual({ on_ms: 300, off_ms: 1200 })
    expect(p.pattern.filter((s) => s.off_ms === 300)).toHaveLength(p.groups[0] + p.groups[1] - 2)
  })
  const PROTOCOL = process.env.ILDRA_PROTOCOL_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'protocol')
  const vec = join(PROTOCOL, 'examples', 'vectors', 'presence-pattern.json')
  it.skipIf(!existsSync(vec))('matches every vector in protocol/examples/vectors/presence-pattern.json, which cover all 16 low-nibble values', () => {
    const v = JSON.parse(readFileSync(vec, 'utf8')) as { vectors: { requestId: string; nonce: string; b: number; groups: [number, number]; pattern: unknown[] }[] }
    expect(v.vectors.length).toBeGreaterThanOrEqual(8)
    for (const x of v.vectors) expect(presencePattern(x.requestId, x.nonce)).toEqual({ b: x.b, groups: x.groups, pattern: x.pattern })
    expect(new Set(v.vectors.map((x) => x.b & 15)).size).toBe(16)
  })
})

describe('(i) presence for ledger.confirm on a device without touch', () => {
  it('a blink_button challenge goes to phone and device (groups, pattern, nonce, 60 s); a signed 3 s hold confirms; no Ask opens; the same press again is presence_replayed', async () => {
    const r = rig(); await r.enroll()
    const h = await r.head()
    const p = r.confirm(); await tick()
    const c = r.challenge()!
    expect(c).toMatchObject({ method: 'blink_button', expiresAt: r.clock.t + 60_000 })
    expect(c.groups).toEqual(presencePattern(c.requestId, c.nonce).groups)
    expect(c.pattern).toEqual(presencePattern(c.requestId, c.nonce).pattern)
    expect(r.sent).toHaveLength(0) // no Ask prompt
    expect(await r.press(c)).toEqual({ ok: true })
    expect(await p).toMatchObject({ ok: true, head: h.hash, seq: h.seq })
    const all = r.svc.journal().pairingLedger.all()
    expect(all.at(-2)).toMatchObject({ kind: 'device_presence', askId: c.requestId, reason: 'ledger_confirm', verb: 'button_hold' })
    expect(all.at(-1)).toMatchObject({ kind: 'ledger_confirmed', askId: c.requestId })
    expect(await r.press(c)).toEqual({ ok: false, reason: 'presence_replayed' })
  })
  it('refusals leave the challenge open: wrong nonce or request or kind, under 3000 ms, another key; then an expired press ends it (presence_missing)', async () => {
    const r = rig(); await r.enroll()
    const p = r.confirm(); await tick()
    const c = r.challenge()!
    expect(await r.press(c, { nonce: 'B'.repeat(43) })).toEqual({ ok: false, reason: 'presence_wrong_request' })
    expect(await r.press(c, { requestId: '11111111-2222-4333-8444-555555555555' })).toEqual({ ok: false, reason: 'presence_wrong_request' })
    expect(await r.press(c, { kind: 'screen_hold' })).toEqual({ ok: false, reason: 'presence_wrong_request' })
    expect(await r.press(c, { heldMs: 2999 })).toEqual({ ok: false, reason: 'presence_too_short' })
    expect(await r.press(c, { key: deviceKeyPair().key })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.press(c, { conn: 'ph1' })).toEqual({ ok: false, reason: 'no_authority' })
    expect(r.svc.journal().pairingLedger.all().filter((e) => e.kind === 'presence_refused').map((e) => e.reason)).toEqual(['presence_wrong_request', 'presence_wrong_request', 'presence_wrong_request', 'presence_too_short', 'bad_signature'])
    r.clock.t += 60_000
    expect(await r.press(c)).toEqual({ ok: false, reason: 'presence_expired' })
    expect(await p).toEqual({ ok: false, reason: 'presence_missing' })
    expect(await r.press(c)).toEqual({ ok: false, reason: 'presence_expired' })
  })
  it('the phone aborts ("It doesn\'t match"), main or deny key: refused aborted, ledger presence_aborted, any later press is aborted; stranger key and unknown id refused', async () => {
    const r = rig(); await r.enroll()
    const p = r.confirm(); await tick()
    const c = r.challenge()!
    expect(await r.abort(c, phoneKeyPair().key)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.abort(c, r.K.D1.key)).toEqual({ ok: true })
    expect(await p).toEqual({ ok: false, reason: 'aborted' })
    expect(r.events.filter((e) => e.type === 'ildra.ledger.confirm_refused').at(-1)!.body).toEqual({ reason: 'aborted' })
    expect(r.kinds()).toContain('presence_aborted')
    expect(await r.press(c)).toEqual({ ok: false, reason: 'aborted' })
    expect(await r.abort(c)).toEqual({ ok: false, reason: 'unknown_id' })
  })
  it('presence is never an Ask answer: an answer carrying a hold is no_authority, and a press against an open Ask id is no_authority', async () => {
    const r = rig(); await r.enroll()
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const T: ApprovalTemplate = { permissions: { ask: ['Rename a file'] } }
    const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
    const a = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] }); await tick()
    const q = r.sent.at(-1)!
    expect(await r.core.requests.ildra_ask_answer({ id: q.id, digest8: q.digest8, answerId: aid(), approved: true, holdMs: 3000, kind: 'button_hold' }, r.remote('dev'))).toEqual({ ok: false, reason: 'no_authority' })
    const fake: Ch = { requestId: q.id, method: 'blink_button', nonce: 'C'.repeat(43), expiresAt: 0 }
    expect(await r.press(fake)).toEqual({ ok: false, reason: 'no_authority' })
    expect(r.svc.journal().ledger.get(q.id)).not.toBeNull()
    r.core.cancel(q.id); await a
  })
  it('a touch device keeps the hold prompt for ledger.confirm (no presence challenge)', async () => {
    const r = rig({ inputs: ['touch', 'button'], form: 'core' }); await r.enroll()
    const p = r.confirm(); await tick()
    expect(r.challenge()).toBeUndefined()
    expect(r.sent.at(-1)).toMatchObject({ action: 'Confirm your phone and device list?', channel: 'touch' })
    r.clock.t += 61_000
    void p
  })
})

describe('(i) presence in the touch proof slot: only for removing the last owner phone', () => {
  const unpair = (r: ReturnType<typeof rig>, extra: Record<string, unknown> = {}) => r.core.requests.ildra_pairing_unpair({ phoneId: 'p1', at: r.clock.t, signature: sig(r.K.P1.key, unpairMessage('p1', r.clock.t)), from: { phoneId: 'p1' }, ...extra }, r.remote('ph1'))
  it('presence: true on the last phone opens a challenge (method from the inputs); the press then opens the locked_ask; approved unpairs', async () => {
    const r = rig(); await r.enroll()
    const u = unpair(r, { presence: true }); await tick()
    const c = r.challenge()!
    expect(c.method).toBe('blink_button')
    expect(await r.press(c)).toEqual({ ok: true })
    await tick()
    const q = r.sent.at(-1)!
    expect(q).toMatchObject({ tier: 'locked_ask', channel: 'phone' })
    await r.core.requests.ildra_ask_answer({ id: q.id, digest8: q.digest8, answerId: aid(), approved: true, holdMs: 2000, from: { phoneId: 'p1' } }, r.remote('ph1'))
    expect(await u).toMatchObject({ ok: true, state: 'unpaired' })
    expect(r.svc.journal().pairingLedger.all().find((e) => e.kind === 'unpair_requested')).toMatchObject({ verb: 'presence', askId: c.requestId })
  })
  it('a touch device gets hold_screen (kind screen_hold); abort refuses aborted; no press refuses presence_missing; with two phones presence_not_allowed', async () => {
    const r = rig({ inputs: ['touch'] }); await r.enroll()
    const u = unpair(r, { presence: true }); await tick()
    const c = r.challenge()!
    expect(c.method).toBe('hold_screen')
    expect(c.groups).toBeUndefined()
    expect(await r.abort(c)).toEqual({ ok: true })
    expect(await u).toEqual({ ok: false, reason: 'aborted' })
    expect(r.svc.journal().pairing.isPaired('p1')).toBe(true)
    const u2 = unpair(r, { presence: true }); await tick()
    const c2 = r.challenge()!
    expect(c2.requestId).not.toBe(c.requestId)
    r.clock.t += 60_000
    expect(await r.press(c2)).toEqual({ ok: false, reason: 'presence_expired' })
    expect(await u2).toEqual({ ok: false, reason: 'presence_missing' })
    const r3 = rig({ phones: 2 }); await r3.enroll()
    expect(await unpair(r3, { presence: true })).toEqual({ ok: false, reason: 'presence_not_allowed' })
    expect(r3.challenge()).toBeUndefined()
  })
})

describe('(i) a reset device enrolls as new: old trust never carries over; device_reset on the phone confirm', () => {
  it('a new key (after a physical reset) needs a fresh enroll; on confirm the old entry is device_reset and the old key answers nothing', async () => {
    const r = rig({ inputs: ['touch'], form: 'core' }); await r.enroll()
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const NEW = deviceKeyPair()
    expect(await r.core.requests.ildra_device_enroll({ devicePub: NEW.pub, inputs: ['button'], form: 'clip' }, r.remote('dev'))).toMatchObject({ ok: true })
    expect(r.kinds()).not.toContain('device_reset') // not before the phone confirms
    expect(await r.core.requests.ildra_device_enroll_confirm({ ...signedConfirm(r.svc, r.K.P1.key, NEW.pub, true, 'biometric'), from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: true, state: 'enrolled' })
    const reset = r.svc.journal().pairingLedger.all().find((e) => e.kind === 'device_reset')!
    expect(reset).toMatchObject({ oldFingerprint: expect.any(String), fingerprint: expect.any(String), via: 'phone' })
    expect(reset.oldFingerprint).not.toBe(reset.fingerprint)
    expect(r.svc.journal().device.enrolled()).toMatchObject({ pub: NEW.pub, inputs: ['button'], form: 'clip' })
    // The old key's bridge proof no longer answers; its presence signature is bad_signature.
    const T: ApprovalTemplate = { permissions: { ask: ['Rename a file'] } }
    const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
    const a = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] }); await tick()
    const q = r.sent.at(-1)
    if (q) expect(await r.core.requests.ildra_ask_answer({ id: q.id, digest8: q.digest8, answerId: aid(), approved: true, holdMs: 2000 }, r.remote('dev'))).toEqual({ ok: false, reason: 'no_authority' })
    const p = r.confirm(); await tick()
    const c = r.challenge()!
    expect(await r.press(c)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.press(c, { key: NEW.key })).toEqual({ ok: true })
    expect(await p).toMatchObject({ ok: true })
    if (q) r.core.cancel(q.id)
    await a
  })
})
