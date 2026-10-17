/**
 * Batch B, test-first: (1) the authoritative pairing ledger with its read API, (2) the unpair API through a
 * locked_ask (signed, rate limited, others notified, ledger entries, last owner channel needs a device touch), and
 * (3) the real ildra.ask.answered_by event and read.
 */
import { randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { askAnswerMessage, deviceFingerprint, unpairMessage, unpairTouchMessage } from '../core/ildraDeviceProof.js'
import { createIldraAsk, UNPAIR_RATE } from './ildraAsk.js'
import { deviceKeyPair, phoneKeyPair, proveBridge, signedConfirm } from './ildraAsk.testkit.js'
import { PairingLedger, stampManifest, type ApprovalTemplate, type AskRequest, type PairingLedgerEntry } from './approvals.js'

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
