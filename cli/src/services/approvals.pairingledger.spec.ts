/**
 * Batch B, test-first: (1) the authoritative pairing ledger with its read API, (2) the unpair API through a
 * locked_ask (signed, rate limited, others notified, ledger entries, last owner channel needs a device touch), and
 * (3) the real ildra.ask.answered_by event and read.
 */
import { randomBytes, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020Module from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { askAnswerMessage, deviceFingerprint, ledgerAckMessage, ledgerConfirmMessage, unpairMessage, unpairTouchMessage, verifyPhoneSignature } from '../core/ildraDeviceProof.js'
import { createIldraAsk, UNPAIR_RATE } from './ildraAsk.js'
import { deviceKeyPair, phoneKeyPair, proveBridge, signedConfirm } from './ildraAsk.testkit.js'
import { LEDGER_STATE_RESERVE, MAX_PAIRING_LEDGER, PairingLedger, PhonePairing, stampManifest, type ApprovalTemplate, type AskRequest, type PairingLedgerEntry } from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); for (let i = 0; i < 20; i++) await Promise.resolve() }
const sig = (key: KeyObject, m: string): string => sign(null, Buffer.from(m, 'utf8'), key).toString('base64')
type Key = { pub: string; key: KeyObject }

function rig(dir = mkdtempSync(join(tmpdir(), 'build-plg-')), clock = { t: 5_000_000 }, keys?: { P1: Key; P2: Key; D1: Key; DEVK: Key }) {
  const K = keys ?? { P1: phoneKeyPair(), P2: phoneKeyPair(), D1: phoneKeyPair(), DEVK: deviceKeyPair() }
  const clients: Record<string, IldraAskClient> = { ph1: { identity: K.P1.pub, role: 'web' }, ph2: { identity: K.P2.pub, role: 'web' }, dev: { identity: DEV, role: 'device' }, obs: { identity: K.P1.pub, role: 'observer' } }
  const now = () => clock.t
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:'), now })
  const svc = createIldraAsk({ inputs: core, journalPath: join(dir, 'j', 'a.json'), markerPath: join(dir, 'm', 'x.installed'), now })
  const sent: AskRequest[] = []
  const events: { type: string; body: unknown }[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  svc.events = (type, body) => { events.push({ type, body }) }
  const remote = (connection: string) => ({ local: false, owner: false, connection })
  const pair = (phoneId: string, key: string) => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer(phoneId, key, code); p.confirm(phoneId, 'touch', true) }
  const enrollDevice = async (denyPub?: string) => {
    await core.requests.ildra_device_enroll({ devicePub: K.DEVK.pub }, remote('dev'))
    return core.requests.ildra_device_enroll_confirm({ ...signedConfirm(svc, K.P1.key, K.DEVK.pub, true, 'biometric', denyPub), from: { phoneId: 'p1' } }, remote('ph1'))
  }
  const ledger = async (since?: number, conn = 'ph1', phoneId = 'p1') => core.requests.ildra_pairing_ledger({ ...(since !== undefined ? { since } : {}), from: { phoneId } }, remote(conn))
  /** Phone `conn` (phoneId) asks to unpair `target`, signed by `key`. */
  const unpair = (target: string, key: KeyObject, o: { conn?: string; phoneId?: string; at?: number; touchProof?: string } = {}) => {
    const at = o.at ?? clock.t
    return core.requests.ildra_pairing_unpair({ phoneId: target, at, signature: sig(key, unpairMessage(target, at)), ...(o.touchProof ? { touchProof: o.touchProof } : {}), from: { phoneId: o.phoneId ?? 'p1' } }, remote(o.conn ?? 'ph1'))
  }
  const answer = (req: AskRequest, conn: string, phoneId: string, approved: boolean, extra: Record<string, unknown> = {}) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved, holdMs: 2000, from: { phoneId }, ...extra }, remote(conn))
  const kinds = () => svc.journal().pairingLedger.all().map((e) => e.kind)
  return { dir, clock, K, core, svc, sent, events, remote, pair, enrollDevice, ledger, unpair, answer, kinds }
}

describe('Batch B (1): the pairing ledger', () => {
  it('records phones and devices append-only with a SHA-256 chain, journaled; the paired phone reads it from any seq', async () => {
    const r = rig()
    r.pair('p1', r.K.P1.pub)
    await r.enrollDevice(r.K.D1.pub)
    r.pair('p2', r.K.P2.pub)
    expect(r.kinds()).toEqual(['phone_paired', 'device_enroll_requested', 'device_enrolled', 'deny_key_set', 'phone_paired'])
    const all = await r.ledger() as { ok: true; entries: PairingLedgerEntry[]; head: { seq: number; hash: string } }
    expect(all.ok).toBe(true)
    expect(all.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(all.head).toEqual({ seq: 5, hash: all.entries[4]!.hash })
    expect(all.entries[0]).toMatchObject({ kind: 'phone_paired', phoneId: 'p1', fingerprint: deviceFingerprint(r.K.P1.pub), via: 'touch' })
    expect(all.entries[2]).toMatchObject({ kind: 'device_enrolled', fingerprint: deviceFingerprint(r.K.DEVK.pub), by: 'p1', uv: 'biometric' })
    for (let i = 1; i < all.entries.length; i++) expect(all.entries[i]!.prev).toBe(all.entries[i - 1]!.hash)
    expect((await r.ledger(3) as { entries: PairingLedgerEntry[] }).entries.map((e) => e.seq)).toEqual([4, 5])
    // Copies: changing what was read changes nothing.
    all.entries[0]!.kind = 'phone_unpaired'
    expect(r.kinds()[0]).toBe('phone_paired')
    // It survives a restart, chain intact.
    const r2 = rig(r.dir, r.clock, r.K)
    expect(r2.kinds()).toEqual(r.kinds())
    expect(r2.svc.journal().recovered).toBe(false)
  })
  it('only the paired phone reads it: another key, an observer, the device and malformed since are refused', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    expect(await r.ledger(undefined, 'ph2', 'p1')).toEqual({ ok: false, reason: 'unpaired_phone' })
    expect(await r.ledger(undefined, 'obs')).toEqual({ ok: false, reason: 'no_authority' })
    expect(await r.ledger(undefined, 'dev')).toEqual({ ok: false, reason: 'no_authority' })
    expect(await r.ledger(-1)).toEqual({ ok: false, reason: 'malformed' })
    expect(await r.ledger(1.5)).toEqual({ ok: false, reason: 'malformed' })
  })
  it('an edited, dropped or reordered entry breaks the chain: the journal fails closed (recovered)', () => {
    for (const tamper of ['edit', 'drop', 'swap'] as const) {
      const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub); r.svc.journal().pairing.unpair('p2')
      const path = join(r.dir, 'j', 'a.json')
      const d = JSON.parse(readFileSync(path, 'utf8'))
      if (tamper === 'edit') d.pairingLedger[1].phoneId = 'p9'
      if (tamper === 'drop') d.pairingLedger.splice(1, 1)
      if (tamper === 'swap') [d.pairingLedger[0], d.pairingLedger[1]] = [d.pairingLedger[1], d.pairingLedger[0]]
      writeFileSync(path, JSON.stringify(d))
      expect(rig(r.dir, r.clock, r.K).svc.journal().recovered, tamper).toBe(true)
    }
  })
  it('unit: append-only chain and since/limit', () => {
    const l = new PairingLedger(() => 7)
    for (let i = 0; i < 5; i++) l.append({ kind: 'phone_open', phoneId: `p${i}` })
    expect(l.since(0, 2).map((e) => e.seq)).toEqual([1, 2])
    const copy = new PairingLedger(); copy.restore(l.toJSON())
    expect(copy.head()).toEqual(l.head())
    expect(() => copy.restore([{ ...l.toJSON()[0], seq: 2 }])).toThrow()
  })
})

describe('Batch B (2): unpair through locked_ask', () => {
  it('two phones: p1 asks to unpair p2; the others are told; a locked_ask goes to the phone; the deny key cannot approve; approved, p2 and its deny key are gone, with ledger entries', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    const pending = r.unpair('p2', r.K.P1.key)
    await tick()
    expect(r.events.find((e) => e.type === 'ildra.pairing.unpair_requested')!.body).toEqual({ phoneId: 'p2', by: 'p1', at: r.clock.t })
    const req = r.sent.at(-1)!
    expect(req).toMatchObject({ tier: 'locked_ask', channel: 'phone' })
    // Even p2 answering on the device channel is not possible; a touch answer is refused (no proven device).
    expect(await r.answer(req, 'dev', 'p1', true)).toMatchObject({ ok: false })
    await r.answer(req, 'ph1', 'p1', true)
    const res = await pending as { ok: true; state: string; askId: string }
    expect(res).toEqual({ ok: true, state: 'unpaired', askId: req.id })
    expect(r.svc.journal().pairing.isPaired('p2')).toBe(false)
    expect(r.events.find((e) => e.type === 'ildra.pairing.unpaired')!.body).toEqual({ phoneId: 'p2', by: 'p1', askId: req.id, at: expect.any(Number), remaining: 1 })
    const tail = r.svc.journal().pairingLedger.all().slice(-2)
    expect(tail.map((e) => e.kind)).toEqual(['unpair_requested', 'phone_unpaired'])
    expect(tail[1]).toMatchObject({ phoneId: 'p2', by: 'p1', via: 'locked_ask', askId: req.id, fingerprint: deviceFingerprint(r.K.P2.pub) })
  })
  it('a denied or expired locked_ask unpairs nothing (unpair_refused not_approved); a deny-key Approve is verifier_rejected', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    await r.enrollDevice(r.K.D1.pub)
    const pending = r.unpair('p2', r.K.P1.key); await tick()
    const req = r.sent.at(-1)!
    const answerId = aid()
    expect(await r.answer(req, 'ph1', 'p1', true, { answerId, phoneSignature: sig(r.K.D1.key, askAnswerMessage(true, req.id, req.digest8, answerId)) })).toEqual({ ok: false, reason: 'verifier_rejected' })
    await r.answer(req, 'ph1', 'p1', false)
    expect(await pending).toEqual({ ok: false, reason: 'not_approved' })
    expect(r.svc.journal().pairing.isPaired('p2')).toBe(true)
    expect(r.svc.journal().pairingLedger.all().at(-1)).toMatchObject({ kind: 'unpair_refused', phoneId: 'p2', reason: 'not_approved', askId: req.id, via: 'locked_ask' })
  })
  it('signed by the main key only: unsigned or another key is bad_signature, the deny key is verifier_rejected (logged), a stale at is expired, an unknown phone is unknown_phone', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    await r.enrollDevice(r.K.D1.pub)
    expect(await r.core.requests.ildra_pairing_unpair({ phoneId: 'p2', at: r.clock.t, from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.unpair('p2', r.K.P2.key)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await r.unpair('p2', r.K.D1.key)).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().pairing.verifierLog.at(-1)).toMatchObject({ phoneId: 'p1', verb: 'pairing.unpair' })
    expect(await r.unpair('p2', r.K.P1.key, { at: r.clock.t - 61_000 })).toEqual({ ok: false, reason: 'expired' })
    expect(await r.unpair('p7', r.K.P1.key)).toEqual({ ok: false, reason: 'unknown_phone' })
    expect(await r.core.requests.ildra_pairing_unpair({ phoneId: 'p2', at: r.clock.t, signature: sig(r.K.P1.key, unpairMessage('p2', r.clock.t)), from: { phoneId: 'p1' } }, r.remote('dev'))).toEqual({ ok: false, reason: 'no_authority' })
    expect(r.sent).toHaveLength(0) // no Ask opened for any of them
    expect(r.svc.journal().pairing.isPaired('p2')).toBe(true)
  })
  it(`is rate limited: ${UNPAIR_RATE} requests per 10 minutes daemon-wide, kept in the ledger (also across a restart)`, async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    for (let i = 0; i < UNPAIR_RATE; i++) {
      const p = r.unpair('p2', r.K.P1.key); await tick()
      await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false)
      expect(await p).toEqual({ ok: false, reason: 'not_approved' })
      r.clock.t += 1000
    }
    const n = r.sent.length
    expect(await r.unpair('p2', r.K.P1.key)).toEqual({ ok: false, reason: 'rate_limited' })
    const r2 = rig(r.dir, r.clock, r.K)
    expect(await r2.unpair('p2', r2.K.P1.key)).toEqual({ ok: false, reason: 'rate_limited' })
    expect(r.sent.length + r2.sent.length).toBe(n)
    r2.clock.t += 600_000
    const p = r2.unpair('p2', r2.K.P1.key); await tick()
    expect(r2.sent.at(-1)).toMatchObject({ tier: 'locked_ask' })
    await r2.answer(r2.sent.at(-1)!, 'ph1', 'p1', true)
    expect(await p).toMatchObject({ ok: true, state: 'unpaired' })
  })
  it('the last owner channel: the only paired phone is removed only with the enrolled device\'s signed touch', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    expect(await r.unpair('p1', r.K.P1.key)).toEqual({ ok: false, reason: 'last_owner_channel' }) // no device at all
    await r.enrollDevice(r.K.D1.pub)
    expect(await r.unpair('p1', r.K.P1.key)).toEqual({ ok: false, reason: 'last_owner_channel' })
    const at = r.clock.t
    expect(await r.unpair('p1', r.K.P1.key, { at, touchProof: sig(r.K.P1.key, unpairTouchMessage('p1', at)) })).toEqual({ ok: false, reason: 'last_owner_channel' }) // the phone cannot forge it
    expect(await r.unpair('p1', r.K.P1.key, { at, touchProof: sig(r.K.DEVK.key, unpairTouchMessage('p2', at)) })).toEqual({ ok: false, reason: 'last_owner_channel' }) // bound to the target
    expect(r.sent).toHaveLength(0)
    const p = r.unpair('p1', r.K.P1.key, { at, touchProof: sig(r.K.DEVK.key, unpairTouchMessage('p1', at)) }); await tick()
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', true)
    expect(await p).toMatchObject({ ok: true, state: 'unpaired' })
    expect(r.svc.journal().pairing.isPaired()).toBe(false)
    expect(r.svc.journal().pairing.denyKey('p1')).toBeNull()
    expect(r.kinds().slice(-3)).toEqual(['unpair_requested', 'deny_key_revoked', 'phone_unpaired'])
    expect(r.svc.journal().pairingLedger.all().filter((e) => e.kind === 'unpair_refused').map((e) => e.reason)).toEqual(['last_owner_channel', 'last_owner_channel', 'last_owner_channel', 'last_owner_channel'])
  })
})

describe('Batch B (3): ildra.ask.answered_by', () => {
  it('says which channel and key settled each Ask (main key, deny key, device), is journaled and readable', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    await r.enrollDevice(r.K.D1.pub)
    // Main key approves on the phone.
    const a1 = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['phone'] }); await tick()
    const q1 = r.sent.at(-1)!
    await r.answer(q1, 'ph1', 'p1', true); await a1
    // Deny key denies on the phone.
    const a2 = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['phone'] }); await tick()
    const q2 = r.sent.at(-1)!; const answerId = aid()
    await r.answer(q2, 'ph1', 'p1', false, { answerId, phoneSignature: sig(r.K.D1.key, askAnswerMessage(false, q2.id, q2.digest8, answerId)) }); await a2
    // The proven device approves on touch.
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const a3 = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] }); await tick()
    const q3 = r.sent.at(-1)!
    await r.core.requests.ildra_ask_answer({ id: q3.id, digest8: q3.digest8, answerId: aid(), approved: true, holdMs: 2000 }, r.remote('dev')); await a3
    const ev = r.events.filter((e) => e.type === 'ildra.ask.answered_by').map((e) => e.body)
    expect(ev).toEqual([
      { id: q1.id, approved: true, channel: 'phone', by: { kind: 'phone', phoneId: 'p1', key: 'main', fingerprint: deviceFingerprint(r.K.P1.pub) }, at: expect.any(Number) },
      { id: q2.id, approved: false, channel: 'phone', by: { kind: 'phone', phoneId: 'p1', key: 'deny_only', fingerprint: deviceFingerprint(r.K.D1.pub) }, at: expect.any(Number) },
      { id: q3.id, approved: true, channel: 'touch', by: { kind: 'device', key: 'device', fingerprint: deviceFingerprint(r.K.DEVK.pub) }, at: expect.any(Number) },
    ])
    expect(await r.core.requests.ildra_ask_answered_by({ id: q2.id, from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: true, answeredBy: ev[1] })
    expect(await r.core.requests.ildra_ask_answered_by({ id: q2.id, from: { phoneId: 'p1' } }, r.remote('dev'))).toEqual({ ok: false, reason: 'no_authority' })
    const r2 = rig(r.dir, r.clock, r.K)
    expect(await r2.core.requests.ildra_ask_answered_by({ id: q3.id, from: { phoneId: 'p1' } }, r2.remote('ph1'))).toEqual({ ok: true, answeredBy: ev[2] })
  })
  it('no answered_by for an Ask nobody settled (expired, cancelled) or a refused answer', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    const a = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['phone'] }); await tick()
    const q = r.sent.at(-1)!
    await r.answer(q, 'ph1', 'p1', true, { digest8: '00000000' })
    r.core.cancel(q.id); await a
    expect(r.events.filter((e) => e.type === 'ildra.ask.answered_by')).toEqual([])
    expect(await r.core.requests.ildra_ask_answered_by({ id: q.id, from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: true, answeredBy: null })
  })
})

describe('Batch B: wire', () => {
  it('the messages match the schema; the ledger example chain and the unpair example signatures verify', async () => {
    const Ajv2020Module = (await import('ajv/dist/2020.js')).default as unknown as { default?: unknown }
    const Ajv2020 = (Ajv2020Module.default ?? Ajv2020Module) as new (o: object) => import('ajv').default
    const schema = JSON.parse(readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true }); ajv.addSchema(schema)
    const env = (type: string, body: unknown): boolean => ajv.getSchema(schema.$id)!({ type, proto: 1, body }) as boolean
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub); r.pair('p2', r.K.P2.pub)
    const page = await r.ledger() as { ok: true; entries: unknown[]; head: unknown }
    expect(env('ildra.pairing.ledger', { entries: page.entries, head: page.head })).toBe(true)
    expect(env('ildra.pairing.ledger.get', { since: 2 })).toBe(true)
    expect(env('ildra.pairing.unpair', { phoneId: 'p2', at: 1, signature: Buffer.alloc(64, 1).toString('base64') })).toBe(true)
    expect(env('ildra.pairing.unpair', { phoneId: 'p2', at: 1 })).toBe(false)
    expect(env('ildra.pairing.unpair_refused', { phoneId: 'p2', reason: 'last_owner_channel' })).toBe(true)
    expect(env('ildra.pairing.unpair_refused', { phoneId: 'p2', reason: 'nope' })).toBe(false)
    // Example vectors (P-256 move): phone-1 main key = RFC 6979 A.2.5 P-256 key, device = RFC 8032 test 1; ledger hashes recomputed.
    const l = new PairingLedger()
    const G = '0'.repeat(64); const H1 = '551014fa08104c7b170b7d4270020556b33d13caa41e796206c3bf5b87f95a26'; const H2 = '4c86462a29693f5e9192359160cdc89cd0cd020210ba4c3238341992cdb85fc9'; const H3 = '45aa7451d91871dd1dc339f0c0c4986f560a1a1d11b8ec1409972271525f7248'
    const ex = { entries: [
      { seq: 1, at: 1760596000000, kind: 'phone_paired', phoneId: 'phone-1', fingerprint: '3467386125214829', via: 'touch', keyAlg: 'p256', prev: G, hash: H1 },
      { seq: 2, at: 1760596060000, kind: 'device_enrolled', fingerprint: '9450083890274913', by: 'phone-1', via: 'phone', uv: 'biometric', keyAlg: 'ed25519', prev: H1, hash: H2 },
      { seq: 3, at: 1760596120000, kind: 'unpair_requested', phoneId: 'phone-2', by: 'phone-1', via: 'phone', prev: H2, hash: H3 },
    ] }
    expect(() => l.restore(ex.entries)).not.toThrow()
    const MAIN1 = 'BGD-1LolWp0xyWHrdMY1bWjASbiSO2H6bOZpYi5g8p-2eQP-EAi4vJmkGunpVii8ZPLxsgwtfp9Rd6PClNRGIpk'
    expect(deviceFingerprint(MAIN1)).toBe('3467386125214829')
    const { verifyEd25519, verifyPhoneSignature } = await import('../core/ildraDeviceProof.js')
    expect(verifyPhoneSignature(MAIN1, unpairMessage('phone-2', 1760596500000), 'p16kaonFdhJEp1H8DD49BZ2luNfiNoZgGqaaYBdHl+BXoTxTqibOAjlDakYQNfc9ncG7iQ8u1bAGlf94qz2ecw==')).toBe(true)
    expect(verifyEd25519('11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=', unpairTouchMessage('phone-2', 1760596500000), 'JwQG05SfVwfHv6Siw1gK2raZ1McvLCR2RpBhdnVizRdvcN266DIAau6zXMz6LIWRZ22z3my9/RSnn4dpYDncAw==')).toBe(true)
    // answered_by events from the runtime validate.
    const a = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['phone'] }); await tick()
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', true); await a
    for (const e of r.events) expect(env(e.type, e.body), e.type).toBe(true)
  })
})

describe('Shield B7: concurrent unpairs', () => {
  it('two concurrent unpair requests with two phones: the second is unpair_pending; once the first settles (denied) the next may open', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    const a = r.unpair('p2', r.K.P1.key); await tick()
    expect(await r.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' })).toEqual({ ok: false, reason: 'unpair_pending' })
    expect(r.svc.journal().pairingLedger.all().at(-1)).toMatchObject({ kind: 'unpair_refused', reason: 'unpair_pending' })
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); expect(await a).toMatchObject({ ok: false, reason: 'not_approved' })
    const b = r.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' }); await tick()
    expect(r.sent.at(-1)).toMatchObject({ tier: 'locked_ask' })
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', true); expect(await b).toMatchObject({ ok: true })
    expect(r.svc.journal().pairing.pairedCount()).toBe(1)
  })
  it('the recheck after approval: if the other phone went away while the Ask was open, removing the last one without a touch proof is refused', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    const a = r.unpair('p1', r.K.P2.key, { conn: 'ph2', phoneId: 'p2' }); await tick()
    const q = r.sent.at(-1)!
    r.svc.journal().pairing.unpair('p2') // the other channel goes (local owner) while the Ask is open
    await r.answer(q, 'ph1', 'p1', true)
    expect(await a).toMatchObject({ ok: false, reason: 'last_owner_channel' })
    expect(r.svc.journal().pairing.isPaired('p1')).toBe(true)
  })
})

describe('Shield B5: a ledger that cannot be trusted fails closed', () => {
  const broken = async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub)
    const path = join(r.dir, 'j', 'a.json')
    const d = JSON.parse(readFileSync(path, 'utf8')); const oldHead = d.pairingLedger.at(-1).hash
    d.pairingLedger[0].via = 'local_socket'; writeFileSync(path, JSON.stringify(d))
    const r2 = rig(r.dir, r.clock, r.K)
    return { r, r2, oldHead }
  }
  it('keeps the untrusted ledger aside, starts a new chain with ledger_reset {reason, oldHead, count 3}, voice off one window, phones stay paired', async () => {
    const { r, r2, oldHead } = await broken()
    const j = r2.svc.journal()
    expect(j.recovered).toBe(true)
    expect(j.pairing.pairedCount()).toBe(2)
    expect(j.pairingLedger.all().map((e) => [e.kind, e.via])).toEqual([['ledger_reset', undefined], ['phone_paired', 'ledger_reset'], ['phone_paired', 'ledger_reset']])
    expect(j.pairingLedger.all()[0]).toMatchObject({ seq: 1, kind: 'ledger_reset', reason: 'chain_broken', oldHead, count: 3, by: 'daemon' })
    expect(readdirSync(join(r.dir, 'j')).some((f) => f.startsWith('a.json.ledger-untrusted-'))).toBe(true)
    expect(r2.events.find((e) => e.type === 'ildra.pairing.ledger_reset')?.body).toMatchObject({ seq: 1, reason: 'chain_broken', oldHead })
  })
  it('pairing changes are locked (pair, re-pair, unpair, deny key) and the rate limit counts the reset; every phone open repeats the alert', async () => {
    const { r2 } = await broken()
    const p = r2.svc.journal().pairing
    const { code } = p.begin('touch')
    expect(p.offer('p3', phoneKeyPair().pub, code)).toEqual({ ok: false, reason: 'ledger_locked' })
    expect(p.unpair('p2')).toBe(false)
    expect(p.isPaired('p2')).toBe(true)
    expect(p.setDenyKey('p1', phoneKeyPair().pub)).toBe(false)
    expect(await r2.unpair('p2', r2.K.P1.key)).toEqual({ ok: false, reason: 'ledger_locked' })
    expect(r2.sent).toHaveLength(0)
    r2.events.length = 0
    await r2.core.requests.ildra_phone_open({ from: { phoneId: 'p1' } }, r2.remote('ph1'))
    expect(r2.events.map((e) => e.type)).toContain('ildra.pairing.ledger_reset')
  })
  it('only the paired main key acknowledges the exact reset; then changes unlock but the rate limit still counts the reset for 10 minutes', async () => {
    const { r2 } = await broken()
    const j = r2.svc.journal(); const reset = j.pairingLedger.all()[0]!
    const ack = (key: KeyObject, seq = reset.seq, hash = reset.hash) => r2.core.requests.ildra_pairing_ledger_ack({ seq, hash, signature: sig(key, ledgerAckMessage(seq, hash)), from: { phoneId: 'p1' } }, r2.remote('ph1'))
    expect(await ack(r2.K.P2.key)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await ack(r2.K.P1.key, reset.seq, 'f'.repeat(64))).toEqual({ ok: false, reason: 'unknown_id' })
    expect(await r2.core.requests.ildra_pairing_ledger_ack({ seq: reset.seq, hash: reset.hash, signature: sig(r2.K.P1.key, ledgerAckMessage(reset.seq, reset.hash)), from: { phoneId: 'p1' } }, r2.remote('dev'))).toMatchObject({ ok: false })
    expect(await ack(r2.K.P1.key)).toEqual({ ok: true })
    expect(j.pairingLedger.all().at(-1)).toMatchObject({ kind: 'ledger_ack', phoneId: 'p1', by: 'p1', via: 'phone', since: reset.seq })
    expect(j.pairing.changesLocked()).toBe(false)
    expect(await ack(r2.K.P1.key)).toEqual({ ok: false, reason: 'unknown_id' })
    expect(await r2.unpair('p2', r2.K.P1.key)).toEqual({ ok: false, reason: 'rate_limited' })
    r2.clock.t += 600_001
    const u = r2.unpair('p2', r2.K.P1.key); await tick()
    expect(r2.sent.at(-1)).toMatchObject({ tier: 'locked_ask' })
    await r2.answer(r2.sent.at(-1)!, 'ph1', 'p1', false); await u
  })
  it('the deny key cannot acknowledge (verifier_rejected); with no phone paired a touch pairing acknowledges the reset', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    const path = join(r.dir, 'j', 'a.json')
    const d = JSON.parse(readFileSync(path, 'utf8')); d.pairingLedger[0].via = 'x'; writeFileSync(path, JSON.stringify(d))
    const r2 = rig(r.dir, r.clock, r.K); const j = r2.svc.journal(); const reset = j.pairingLedger.all()[0]!
    expect(await r2.core.requests.ildra_pairing_ledger_ack({ seq: reset.seq, hash: reset.hash, signature: sig(r2.K.D1.key, ledgerAckMessage(reset.seq, reset.hash)), from: { phoneId: 'p1' } }, r2.remote('ph1'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    // A journal that cannot be read at all keeps no phone; the next touch pairing is the owner and acks the reset.
    writeFileSync(path, '{not json')
    const r3 = rig(r.dir, r.clock, r.K); const j3 = r3.svc.journal()
    expect(j3.pairingLedger.all()[0]).toMatchObject({ kind: 'ledger_reset', reason: 'journal_unreadable' })
    expect(j3.pairing.pairedCount()).toBe(0)
    r3.pair('p1', r3.K.P1.pub)
    expect(j3.pairing.isPaired('p1')).toBe(true)
    expect(j3.pairingLedger.all().map((e) => e.kind)).toEqual(['ledger_reset', 'phone_paired', 'ledger_ack'])
    expect(j3.pairing.changesLocked()).toBe(false)
  })
})

describe('Shield B8: a device touch proof is single use', () => {
  it('a proof spent on a denied unpair cannot open another, also after a restart; a fresh proof (new at) works', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice()
    const at = r.clock.t
    const proof = sig(r.K.DEVK.key, unpairTouchMessage('p1', at))
    const p = r.unpair('p1', r.K.P1.key, { at, touchProof: proof }); await tick()
    expect(r.svc.journal().pairingLedger.all().at(-1)).toMatchObject({ kind: 'unpair_requested', verb: 'touch_proof', since: at })
    await r.answer(r.sent.at(-1)!, 'ph1', 'p1', false); expect(await p).toMatchObject({ ok: false, reason: 'not_approved' })
    r.clock.t += 5_000
    expect(await r.unpair('p1', r.K.P1.key, { at, touchProof: proof })).toEqual({ ok: false, reason: 'last_owner_channel' })
    const r2 = rig(r.dir, r.clock, r.K)
    expect(await r2.unpair('p1', r.K.P1.key, { at, touchProof: proof })).toEqual({ ok: false, reason: 'last_owner_channel' })
    const at2 = r.clock.t
    const q = r2.unpair('p1', r.K.P1.key, { at: at2, touchProof: sig(r.K.DEVK.key, unpairTouchMessage('p1', at2)) }); await tick()
    expect(r2.sent.at(-1)).toMatchObject({ tier: 'locked_ask' })
    await r2.answer(r2.sent.at(-1)!, 'ph1', 'p1', true); expect(await q).toMatchObject({ ok: true })
    expect(r2.svc.journal().pairing.pairedCount()).toBe(0)
  })
})

describe('Shield B9: the pairing ledger is bounded', () => {
  it('noisy entries: at most 5 per key per minute; the next kept one carries the dropped count; other keys are not starved', () => {
    let t = 1_000_000
    const l = new PairingLedger(() => t)
    for (let i = 0; i < 50; i++) l.append({ kind: 'verifier_rejected', phoneId: 'p1', verb: 'answer.touch', reason: 'verifier_rejected' })
    expect(l.all()).toHaveLength(5)
    expect(l.append({ kind: 'verifier_rejected', phoneId: 'p2', verb: 'answer.touch', reason: 'verifier_rejected' })).not.toBeNull()
    t += 60_000
    const e = l.append({ kind: 'verifier_rejected', phoneId: 'p1', verb: 'answer.touch', reason: 'verifier_rejected' })
    expect(e).toMatchObject({ count: 46 })
    expect(l.append({ kind: 'phone_paired', phoneId: 'p3' })).not.toBeNull() // state kinds are never coalesced
  })
  it(`at ${MAX_PAIRING_LEDGER - LEDGER_STATE_RESERVE} entries noisy kinds stop; near ${MAX_PAIRING_LEDGER} pairing changes are refused (ledger_full); a longer journal ledger fails closed`, () => {
    let t = 0
    const l = new PairingLedger(() => t)
    for (let i = 0; i < MAX_PAIRING_LEDGER - LEDGER_STATE_RESERVE; i++) { t += 1; l.append({ kind: 'phone_open', phoneId: 'p1' }) }
    t += 120_000
    expect(l.append({ kind: 'pair_refused', phoneId: 'p9', reason: 'unknown_code' })).toBeNull()
    const p = new PhonePairing({ now: () => t, ledger: l })
    const k = phoneKeyPair(); const { code } = p.begin('touch')
    expect(p.offer('p1', k.pub, code).ok).toBe(true); expect(p.confirm('p1', 'touch', true)).toBe(true)
    while (l.all().length < MAX_PAIRING_LEDGER - 2) { t += 1; l.append({ kind: 'phone_open', phoneId: 'p1' }) }
    const c2 = p.begin('touch').code
    expect(p.offer('p2', phoneKeyPair().pub, c2)).toEqual({ ok: false, reason: 'ledger_full' })
    expect(p.unpair('p1')).toBe(false)
    expect(p.isPaired('p1')).toBe(true)
    const big = Array.from({ length: MAX_PAIRING_LEDGER + 1 }, () => ({}))
    expect(() => new PairingLedger().restore(big)).toThrow()
  })
  it('a phoneId over 64 characters: offer refuses it (bad_phone_id), the ledger cuts it, no lastRefusal is kept; the unpair API refuses it as malformed', async () => {
    const p = new PhonePairing(); const { code } = p.begin('touch')
    expect(p.offer('y'.repeat(65), phoneKeyPair().pub, code)).toEqual({ ok: false, reason: 'bad_phone_id' })
    expect(p.ledger.all().at(-1)!.phoneId).toBe('y'.repeat(64))
    expect(p.pairingStatus('y'.repeat(65))).toEqual({ state: 'unknown' })
    const r = rig(); r.pair('p1', r.K.P1.pub)
    expect(await r.unpair('z'.repeat(65), r.K.P1.key)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('Shield B1 to B4, B6: the ledger is MACed with a host-held key and authoritative for state at load', () => {
  const jpath = (r: { dir: string }) => join(r.dir, 'j', 'a.json')
  const keyFile = (r: { dir: string }) => join(r.dir, 'm', 'x.installed.ledger-key')
  it('keeps a 32-byte key next to the install marker (0600, outside the journal folder) and a MAC of the head in the journal', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    expect(readFileSync(keyFile(r), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(keyFile(r)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(jpath(r), 'utf8')).pairingLedgerMac).toMatch(/^[0-9a-f]{64}$/)
    const r2 = rig(r.dir, r.clock, r.K)
    expect(r2.svc.journal().recovered).toBe(false)
    expect(r2.svc.journal().pairing.isPaired('p1')).toBe(true)
  })
  it('a deleted key file with pairings present fails closed (ledger_key_missing), keeps the phone, records it via ledger_reset, locks changes', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    rmSync(keyFile(r))
    const r2 = rig(r.dir, r.clock, r.K)
    const j = r2.svc.journal()
    expect(j.recovered).toBe(true)
    expect(j.pairingLedger.all().map((e) => [e.kind, e.reason ?? e.via])).toEqual([['ledger_reset', 'ledger_key_missing'], ['phone_paired', 'ledger_reset']])
    expect(j.pairing.changeRefusal()).toBe('ledger_locked')
    // The reset chain verifies on the next load (new key, new MAC, state backed by the carried-over entries).
    const r3 = rig(r.dir, r.clock, r.K)
    expect(r3.svc.journal().pairingLedger.all()).toHaveLength(2)
    expect(r3.svc.journal().pairing.isPaired('p1')).toBe(true)
  })
  it('an edited MAC fails closed (mac_mismatch)', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    const d = JSON.parse(readFileSync(jpath(r), 'utf8')); d.pairingLedgerMac = '0'.repeat(64); writeFileSync(jpath(r), JSON.stringify(d))
    expect(rig(r.dir, r.clock, r.K).svc.journal().pairingLedger.all()[0]).toMatchObject({ kind: 'ledger_reset', reason: 'mac_mismatch' })
  })
  it('a swapped deny key is dropped (deny_key_revoked not_in_ledger); a phone the state lost is recorded unpaired (missing_from_state)', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub); await r.enrollDevice(r.K.D1.pub)
    const d = JSON.parse(readFileSync(jpath(r), 'utf8'))
    const EVIL = phoneKeyPair()
    const denyHolder = JSON.stringify(d.pairing).includes(r.K.D1.pub)
    expect(denyHolder).toBe(true)
    d.pairing = JSON.parse(JSON.stringify(d.pairing).split(r.K.D1.pub).join(EVIL.pub))
    d.pairing.phones = d.pairing.phones.filter((x: string) => x !== 'p2'); delete d.pairing.phoneKeys.p2
    writeFileSync(jpath(r), JSON.stringify(d))
    const r2 = rig(r.dir, r.clock, r.K)
    const j = r2.svc.journal()
    expect(j.recovered).toBe(true)
    expect(j.pairing.toJSON()).not.toMatchObject({ denyKeys: { p1: expect.anything() } })
    expect(JSON.stringify(j.pairing.toJSON())).not.toContain(EVIL.pub)
    const tail = j.pairingLedger.all().slice(-2)
    expect(tail).toEqual([expect.objectContaining({ kind: 'deny_key_revoked', phoneId: 'p1', reason: 'not_in_ledger' }), expect.objectContaining({ kind: 'phone_unpaired', phoneId: 'p2', reason: 'missing_from_state' })])
    expect(j.pairing.isPaired('p1')).toBe(true)
  })
})

describe('(h) ildra.ledger.confirm.request: the device confirms the phone and device list at the current head', () => {
  type Head = { seq: number; hash: string }
  const setup = async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); await r.enrollDevice(r.K.D1.pub)
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const head = (await r.ledger() as { head: Head }).head
    const confirm = (o: { key?: KeyObject; head?: string; seq?: number; at?: number; conn?: string; phoneId?: string; extra?: Record<string, unknown> } = {}) => {
      const h = o.head ?? head.hash; const s = o.seq ?? head.seq; const at = o.at ?? r.clock.t
      return r.core.requests.ildra_ledger_confirm({ head: h, seq: s, at, phoneSignature: sig(o.key ?? r.K.P1.key, ledgerConfirmMessage(h, s, at)), from: { phoneId: o.phoneId ?? 'p1' }, ...o.extra }, r.remote(o.conn ?? 'ph1'))
    }
    const hold = (req: AskRequest, holdMs = 2000, approved = true) => r.core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved, holdMs }, r.remote('dev'))
    const refused = () => r.events.filter((e) => e.type === 'ildra.ledger.confirm_refused').map((e) => (e.body as { reason: string }).reason)
    return { r, head, confirm, hold, refused }
  }
  it('signed by the main key at the current head: a 60 s touch-only hold prompt; a held answer sends ildra.ledger.confirmed and appends ledger_confirmed', async () => {
    const { r, head, confirm, hold } = await setup()
    const at = r.clock.t
    const p = confirm({ at }); await tick()
    const req = r.sent.at(-1)!
    expect(req).toMatchObject({ action: 'Confirm your phone and device list?', channel: 'touch', tier: 'ask' })
    expect(req.expiresAt - req.openedAt).toBe(60_000)
    expect(await hold(req)).toEqual({ ok: true })
    expect(await p).toEqual({ ok: true, head: head.hash, seq: head.seq, at })
    expect(r.events.filter((e) => e.type === 'ildra.ledger.confirmed').map((e) => e.body)).toEqual([{ head: head.hash, seq: head.seq, at }])
    const last = r.svc.journal().pairingLedger.all().at(-1)!
    expect(last).toMatchObject({ kind: 'ledger_confirmed', phoneId: 'p1', via: 'touch', since: head.seq, prev: head.hash, askId: req.id })
    // The same request again: the head moved (by the ledger_confirmed itself), so it cannot be replayed.
    expect(await confirm({ at })).toEqual({ ok: false, reason: 'stale_head' })
  })
  it('the deny key is verifier_rejected; another key is bad_signature; refusals are logged and sent as ildra.ledger.confirm_refused', async () => {
    const { r, confirm, refused } = await setup()
    expect(await confirm({ key: r.K.D1.key })).toEqual({ ok: false, reason: 'verifier_rejected' })
    expect(r.svc.journal().pairing.verifierLog.at(-1)).toMatchObject({ verb: 'ledger.confirm', reason: 'verifier_rejected' })
    expect(await confirm({ key: phoneKeyPair().key })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(refused()).toEqual(['verifier_rejected', 'bad_signature'])
    expect(r.svc.journal().pairingLedger.all().filter((e) => e.kind === 'ledger_confirm_refused').map((e) => e.reason)).toEqual(['verifier_rejected', 'bad_signature'])
    expect(r.sent.some((q) => q.action === 'Confirm your phone and device list?')).toBe(false)
  })
  it('stale_head, malformed and unpaired_phone are refused before any prompt', async () => {
    const { r, head, confirm, refused } = await setup()
    expect(await confirm({ seq: head.seq - 1 })).toEqual({ ok: false, reason: 'stale_head' })
    expect(await confirm({ head: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'stale_head' })
    expect(await r.core.requests.ildra_ledger_confirm({ head: 'x', seq: 1, at: 1, phoneSignature: 'AAAA', from: { phoneId: 'p1' } }, r.remote('ph1'))).toEqual({ ok: false, reason: 'malformed' })
    expect(await confirm({ conn: 'ph2', phoneId: 'p2', key: r.K.P2.key })).toEqual({ ok: false, reason: 'unpaired_phone' })
    expect(refused()).toEqual(['stale_head', 'stale_head', 'malformed', 'unpaired_phone'])
    expect(r.sent).toHaveLength(0)
  })
  it('one confirm at a time (busy); unanswered within 60 s, or not held, it ends as timeout', async () => {
    const { r, confirm, hold, refused } = await setup()
    const p = confirm(); await tick()
    const req = r.sent.at(-1)!
    expect(await confirm()).toEqual({ ok: false, reason: 'busy' })
    r.clock.t += 60_001
    await hold(req)
    expect(await p).toEqual({ ok: false, reason: 'timeout' })
    expect(refused()).toEqual(['busy', 'timeout'])
    expect(r.svc.journal().pairingLedger.all().some((e) => e.kind === 'ledger_confirmed')).toBe(false)
    // A device Deny confirms nothing either.
    const head2 = (await r.ledger() as { head: Head }).head
    const p2 = confirm({ head: head2.hash, seq: head2.seq }); await tick()
    await hold(r.sent.at(-1)!, 2000, false)
    expect(await p2).toEqual({ ok: false, reason: 'timeout' })
  })
  it('same hold rules as touch: a short hold is an attempt (prompt stays); the phone cannot answer it; a head that moves during the prompt is stale_head', async () => {
    const { r, confirm, hold } = await setup()
    const p = confirm(); await tick()
    const req = r.sent.at(-1)!
    await hold(req, 100); await tick()
    expect(r.events.some((e) => e.type === 'ildra.ask.attempt')).toBe(true)
    expect(r.svc.journal().ledger.get(req.id)).not.toBeNull()
    await r.answer(req, 'ph1', 'p1', true); await tick()
    expect(r.svc.journal().ledger.get(req.id)).not.toBeNull() // the phone did not settle it
    expect(r.events.some((e) => e.type === 'ildra.ledger.confirmed')).toBe(false)
    r.pair('p2', r.K.P2.pub) // the list changes while the prompt is up
    await hold(req)
    expect(await p).toEqual({ ok: false, reason: 'stale_head' })
    expect(r.svc.journal().pairingLedger.all().at(-1)).toMatchObject({ kind: 'ledger_confirm_refused', reason: 'stale_head', askId: req.id })
  })
})

describe('Wire: B5 to B9 and (h) messages match the vendored schema; the Ildra examples verify', () => {
  const schema = JSON.parse(readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
  const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module
  const ajv = new (Ajv2020 as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true })
  ajv.addSchema(schema)
  const env = (type: string, body: unknown): string[] => { const f = ajv.getSchema(schema.$id)!; return f({ type, proto: 1, body }) ? [] : (f.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`) }
  const PROTOCOL = process.env.ILDRA_PROTOCOL_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'protocol')
  it('emitted ledger_reset, ledger page (reset, ack, confirmed, refused entries), confirmed and confirm_refused validate', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub); r.pair('p2', r.K.P2.pub); await r.enrollDevice(r.K.D1.pub)
    expect(proveBridge(r.core, 'dev', r.K.DEVK.key)).toBe(true)
    const path = join(r.dir, 'j', 'a.json'); const d = JSON.parse(readFileSync(path, 'utf8')); d.pairingLedgerMac = '0'.repeat(64); writeFileSync(path, JSON.stringify(d))
    const r2 = rig(r.dir, r.clock, r.K)
    expect(proveBridge(r2.core, 'dev', r.K.DEVK.key)).toBe(true)
    const reset = r2.events.find((e) => e.type === 'ildra.pairing.ledger_reset')!
    expect(env('ildra.pairing.ledger_reset', reset.body)).toEqual([])
    const rb = reset.body as { seq: number; hash: string }
    const ack = { seq: rb.seq, hash: rb.hash, signature: sig(r.K.P1.key, ledgerAckMessage(rb.seq, rb.hash)) }
    expect(env('ildra.pairing.ledger_ack', ack)).toEqual([])
    expect(await r2.core.requests.ildra_pairing_ledger_ack({ ...ack, from: { phoneId: 'p1' } }, r2.remote('ph1'))).toEqual({ ok: true })
    const head = (await r2.ledger() as { head: { seq: number; hash: string } }).head
    const at = r2.clock.t
    const msg = { head: head.hash, seq: head.seq, at, phoneSignature: sig(r.K.P1.key, ledgerConfirmMessage(head.hash, head.seq, at)) }
    expect(env('ildra.ledger.confirm.request', msg)).toEqual([])
    // A refusal first (the deny key), so a ledger_confirm_refused entry and event exist.
    expect(await r2.core.requests.ildra_ledger_confirm({ ...msg, phoneSignature: sig(r.K.D1.key, ledgerConfirmMessage(head.hash, head.seq, at)), from: { phoneId: 'p1' } }, r2.remote('ph1'))).toEqual({ ok: false, reason: 'verifier_rejected' })
    const head2 = (await r2.ledger() as { head: { seq: number; hash: string } }).head
    const msg2 = { head: head2.hash, seq: head2.seq, at, phoneSignature: sig(r.K.P1.key, ledgerConfirmMessage(head2.hash, head2.seq, at)) }
    const p = r2.core.requests.ildra_ledger_confirm({ ...msg2, from: { phoneId: 'p1' } }, r2.remote('ph1')); await tick()
    const q = r2.sent.at(-1)!
    expect(env('ildra.ask.request', q)).toEqual([])
    await r2.core.requests.ildra_ask_answer({ id: q.id, digest8: q.digest8, answerId: aid(), approved: true, holdMs: 2000 }, r2.remote('dev'))
    expect(await p).toMatchObject({ ok: true })
    for (const e of r2.events.filter((x) => x.type === 'ildra.ledger.confirmed' || x.type === 'ildra.ledger.confirm_refused')) expect(env(e.type, e.body), e.type).toEqual([])
    const page = await r2.ledger() as { ok: true; entries: unknown[]; head: unknown }
    const { ok: _ok, ...body } = page
    expect(env('ildra.pairing.ledger', body)).toEqual([])
    const kinds = (page.entries as PairingLedgerEntry[]).map((e) => e.kind)
    for (const k of ['ledger_reset', 'ledger_ack', 'ledger_confirm_refused', 'ledger_confirmed'] as const) expect(kinds).toContain(k)
    expect(env('ildra.pairing.unpair_refused', { phoneId: 'p2', reason: 'unpair_pending' })).toEqual([])
  })
  it.skipIf(!existsSync(join(PROTOCOL, 'examples', 'ledger-confirm-request.json')))('the Ildra examples: ledger_ack and ledger confirm signatures verify against the example phone main key', () => {
    const R = (f: string) => JSON.parse(readFileSync(join(PROTOCOL, 'examples', f), 'utf8'))
    const main = R('pairing-offer.json').body.phonePub as string
    const ack = R('pairing-ledger-ack.json').body
    expect(verifyPhoneSignature(main, ledgerAckMessage(ack.seq, ack.hash), ack.signature)).toBe(true)
    const c = R('ledger-confirm-request.json').body
    expect(verifyPhoneSignature(main, ledgerConfirmMessage(c.head, c.seq, c.at), c.phoneSignature)).toBe(true)
    expect(c.head).toBe(R('pairing-ledger.json').body.head.hash)
    expect(verifyPhoneSignature(main, ledgerConfirmMessage(c.head, c.seq + 1, c.at), c.phoneSignature)).toBe(false)
  })
})

describe('Shield S3 (j): the ledger read is paged: {entries, pageHead, more, nextSeq?, head}; the phone chains by pageHead', () => {
  it('600 entries come as 500 + 100; each page chains from the previous pageHead; more and nextSeq drive the next read; head is informational', async () => {
    const r = rig(); r.pair('p1', r.K.P1.pub)
    const L = r.svc.journal().pairingLedger
    while (L.all().length < 600) L.append({ kind: 'phone_open', phoneId: 'p1', by: 'p1', via: 'phone' })
    type Page = { ok: true; entries: PairingLedgerEntry[]; pageHead: string; more: boolean; nextSeq?: number; head: { seq: number; hash: string } }
    const p1 = await r.ledger() as Page
    expect(p1.entries).toHaveLength(500)
    expect(p1).toMatchObject({ more: true, nextSeq: 500, pageHead: p1.entries.at(-1)!.hash })
    expect(p1.head.seq).toBeGreaterThanOrEqual(600)
    expect(p1.pageHead).not.toBe(p1.head.hash)
    const p2 = await r.ledger(p1.nextSeq) as Page
    expect(p2.entries[0]!.prev).toBe(p1.pageHead) // chains page to page
    expect(p2.more).toBe(false)
    expect(p2.nextSeq).toBeUndefined()
    expect(p2.pageHead).toBe(p2.head.hash) // the last page ends at the head
    // An empty page (since = head) still names the hash it ends at.
    const p3 = await r.ledger(p2.head.seq) as Page
    expect(p3).toMatchObject({ entries: [], more: false, pageHead: p2.head.hash })
    expect((await r.ledger(0) as Page).entries[0]!.prev).toBe('0'.repeat(64))
  })
})
