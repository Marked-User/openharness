/**
 * Build's tests for Shield round 7 (R7-1, R7-2, R7-3, R7-4, R7-10, the core channel stamp) and the App R7 schema
 * rule (lookalike requires an ASCII lookalikeOf). Shield's own GAP tests in approvals.shield-r6.spec.ts flip
 * (fail) when these hold, as intended.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020Module from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore, type IldraAskClient } from '../core/ildraAsk.js'
import { stampChannel as stampForTest } from '../core/ildraChannel.js'
import { deviceFingerprint, deviceProofMessage, enrollConfirmMessage, verifyEd25519 } from '../core/ildraDeviceProof.js'
import { createIldraAsk } from './ildraAsk.js'
import { deviceKeyPair, phoneKeyPair, proveBridge, signedConfirm } from './ildraAsk.testkit.js'
import {
  ApprovalWindow, AskLedger, HIDDEN_SCHEMA_PATTERN, PhonePairing, UNPAIRED_NOTIFY, UNPAIRED_WINDOW_MS, ask, classifyTool, markHidden,
  openJournal, recipientFlags, resolveTool, stampManifest, toDeviceMessage,
  type AskAnswer, type AskRequest, type ApprovalTemplate,
} from './approvals.js'
import { HIDDEN_COUNT, HIDDEN_SOURCES, HIDDEN_VERSION } from './unicode/hidden.js'
import { lookalikeOf } from './recipient.js'

const schema = JSON.parse(readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module
const ajv = new (Ajv2020 as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true })
ajv.addSchema(schema)
const valid = (name: string, v: unknown): boolean => ajv.getSchema(`${schema.$id}#/$defs/${name}`)!(v) as boolean
const env = (type: string, body: unknown): boolean => ajv.getSchema(schema.$id)!({ type, proto: 1, body }) as boolean

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file', 'Send an email'], locked_ask: ['Brakes step'], auto: ['Send a note'] } }
const kind = { manifest: stampManifest([{ name: 'fs.rename', send: false }], 'bridge'), tool: 'fs.rename' }
const DEV = 'D'.repeat(43) + '='
const DEV2 = 'E'.repeat(43) + '='
const PHONE = 'P'.repeat(43) + '='
const OTHER = 'X'.repeat(43) + '='
const paired = (): PhonePairing => { const p = new PhonePairing(); const { code } = p.begin('touch'); p.offer('p1', PHONE, code); p.confirm('p1', 'touch', true); return p }
const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); for (let i = 0; i < 20; i++) await Promise.resolve() }

function rig(clients: Record<string, IldraAskClient>, path?: string) {
  const d = path ?? mkdtempSync(join(tmpdir(), 'build-r7-'))
  const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:') })
  const svc = createIldraAsk({ inputs: core, journalPath: join(d, 'j', 'a.json'), markerPath: join(d, 'm', 'x.installed') })
  const sent: AskRequest[] = []
  const events: { type: string; body: unknown }[] = []
  svc.bridge = (_c, _p, req) => { sent.push(req) }
  svc.events = (type, body) => { events.push({ type, body }) }
  const answer = (req: AskRequest, connection: string, extra: Record<string, unknown> = {}) =>
    core.requests.ildra_ask_answer({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, holdMs: 2000, ...extra }, { local: false, owner: false, connection })
  const pair = (key: string) => { const p = svc.journal().pairing; const { code } = p.begin('touch'); p.offer('p1', key, code); p.confirm('p1', 'touch', true) }
  const remote = (connection: string) => ({ local: false, owner: false, connection })
  return { d, core, svc, sent, events, answer, pair, remote }
}

describe('R7-1: only the phone-confirmed, proven Ildra device answers on touch', () => {
  // Batch A: the paired phone's key is a real Ed25519 key; it signs every enroll confirm.
  const PK = phoneKeyPair()
  const full = () => rig({ dev: { identity: DEV, role: 'device' }, dev2: { identity: DEV2, role: 'device' }, ph: { identity: PK.pub, role: 'web' }, x: { identity: OTHER, role: 'web' } })
  const conf = (r: ReturnType<typeof full>, pub: string, approved = true) => ({ ...signedConfirm(r.svc, PK.key, pub, approved), from: { phoneId: 'p1' } })
  const enrolled = (r: ReturnType<typeof full>, pub: string) => { const j = r.svc.journal(); const b = j.device.begin(pub)!; j.device.confirm(pub, b.nonce, true, { uv: 'biometric', phoneId: 'p1' }) }

  it('with no enrolled key, a device-role connection is no_authority and gets no challenge', async () => {
    const r = full()
    expect(r.core.challengeDevice('dev')).toBeNull()
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'dev')).toEqual({ ok: false, reason: 'no_authority' })
    expect(r.svc.journal().ledger.pending()).toBe(1)
    r.core.cancel(r.sent[0]!.id); await p
  })

  it('enroll is pending until the paired phone confirms; the device itself, another key or an unpaired phone cannot confirm', async () => {
    const r = full(); r.pair(PK.pub)
    const { pub, key } = deviceKeyPair()
    const begun = await r.core.requests.ildra_device_enroll({ devicePub: pub }, r.remote('dev'))
    expect(begun).toMatchObject({ ok: true, devicePub: pub })
    expect(r.events.find((e) => e.type === 'ildra.device.enroll')?.body).toMatchObject({ devicePub: pub })
    expect(r.svc.journal().device.device()).toBeNull()
    expect(proveBridge(r.core, 'dev', key)).toBe(false) // pending grants nothing
    // The device (device role), a web key that is not the paired phone, or a loopback owner cannot confirm.
    expect(await r.core.requests.ildra_device_enroll_confirm(conf(r, pub), r.remote('dev'))).toMatchObject({ ok: false })
    expect(await r.core.requests.ildra_device_enroll_confirm(conf(r, pub), r.remote('x'))).toEqual({ ok: false, reason: 'unpaired_phone' })
    expect(await r.core.requests.ildra_device_enroll_confirm(conf(r, pub), { local: true, owner: true, connection: 'local:sock' })).toMatchObject({ ok: false })
    expect(r.svc.journal().device.device()).toBeNull()
    expect(await r.core.requests.ildra_device_enroll_confirm(conf(r, pub), r.remote('ph'))).toEqual({ ok: true, state: 'enrolled' })
    expect(r.events.find((e) => e.type === 'ildra.device.enroll.status')?.body).toMatchObject({ state: 'enrolled' })
    expect(r.svc.journal().device.device()).toBe(pub)
    expect(proveBridge(r.core, 'dev', key)).toBe(true)
  })

  it('after enrollment only the proven connection answers; an unproven device-role connection or a second key is no_authority, even with holdMs 2000', async () => {
    const r = full(); r.pair(PK.pub)
    const { pub, key } = deviceKeyPair(); enrolled(r, pub)
    expect(proveBridge(r.core, 'dev', key)).toBe(true)
    const other = deviceKeyPair()
    expect(proveBridge(r.core, 'dev2', other.key)).toBe(false)
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'dev2')).toEqual({ ok: false, reason: 'no_authority' })
    expect(await r.answer(r.sent[0]!, 'local:pair')).toEqual({ ok: false, reason: 'no_authority' })
    await r.answer(r.sent[0]!, 'dev')
    expect(await p).toMatchObject({ approved: true, channel: 'touch' })
  })

  it('a wrong signature, a reused nonce, a stale nonce or a loopback connection never proves', () => {
    let now = 1_000_000
    const clients: Record<string, IldraAskClient> = { dev: { identity: DEV, role: 'device' }, 'local:dev': { identity: DEV, role: 'device' } }
    const core = createIldraAskCore({ clientOf: (c) => clients[c] ?? null, isLoopback: (c) => c.startsWith('local:'), now: () => now })
    const { pub, key } = deviceKeyPair()
    core.deviceKey = () => pub
    expect(core.challengeDevice('local:dev')).toBeNull()
    const n1 = core.challengeDevice('dev')!
    const wrong = generateKeyPairSync('ed25519').privateKey
    expect(core.proveDevice('dev', sign(null, Buffer.from(deviceProofMessage(n1)), wrong).toString('base64'))).toBe(false)
    const n2 = core.challengeDevice('dev')!
    const good = sign(null, Buffer.from(deviceProofMessage(n2)), key).toString('base64')
    expect(core.proveDevice('dev', good)).toBe(true)
    expect(core.proveDevice('dev', good)).toBe(false) // nonce spent
    const n3 = core.challengeDevice('dev')!
    now += 61_000
    expect(core.proveDevice('dev', sign(null, Buffer.from(deviceProofMessage(n3)), key).toString('base64'))).toBe(false)
  })

  it('the phone revokes with a signed approved false on the enrollment nonce: the bridge loses authority at once; the journal stores only the public key', async () => {
    const r = full(); r.pair(PK.pub)
    const { pub, key } = deviceKeyPair(); enrolled(r, pub)
    expect(proveBridge(r.core, 'dev', key)).toBe(true)
    const text = readFileSync(join(r.d, 'j', 'a.json'), 'utf8')
    expect(text).toContain(pub)
    expect(text).not.toMatch(/PRIVATE|privateKey/)
    expect(await r.core.requests.ildra_device_enroll_confirm(conf(r, pub, false), r.remote('ph'))).toEqual({ ok: true, state: 'revoked' })
    const p = r.svc.ask(T, 'Rename a file', null, { kind, agentId: 'a', available: ['touch'] })
    await tick()
    expect(await r.answer(r.sent[0]!, 'dev')).toEqual({ ok: false, reason: 'no_authority' })
    r.core.cancel(r.sent[0]!.id); await p
  })

  it('a pending key expires after 10 minutes unconfirmed', () => {
    let now = 5_000_000
    const j = openJournal(join(mkdtempSync(join(tmpdir(), 'build-r7e-')), 'j.json'), { now: () => now, markerPath: join(mkdtempSync(join(tmpdir(), 'build-r7m-')), 'x') })
    const { pub } = deviceKeyPair()
    const b = j.device.begin(pub)!
    now += 10 * 60_000 + 1
    expect(j.device.confirm(pub, b.nonce, true, { uv: 'biometric', phoneId: 'p1' })).toBe('expired')
    expect(j.device.device()).toBeNull()
  })

  it('wire: the device messages and the examples match the schema', () => {
    const { pub } = deviceKeyPair()
    const fp = deviceFingerprint(pub)
    const nonce = randomBytes(32).toString('base64url')
    const signature = Buffer.alloc(64, 1).toString('base64')
    expect(env('ildra.device.enroll', { devicePub: pub, fingerprint: fp, nonce, expiresAt: 1, source: 'device' })).toBe(true)
    expect(env('ildra.device.enroll', { devicePub: pub, fingerprint: '0123456789abcdef', nonce, expiresAt: 1, source: 'device' })).toBe(false)
    expect(env('ildra.device.enroll.confirm', { devicePub: pub, nonce, approved: true, uv: 'biometric', signature })).toBe(true)
    expect(env('ildra.device.enroll.confirm', { devicePub: pub, nonce, approved: true, uv: 'passcode', signature })).toBe(true)
    expect(env('ildra.device.enroll.confirm', { devicePub: pub, nonce, approved: true, signature })).toBe(false) // uv required
    expect(env('ildra.device.enroll.confirm', { devicePub: pub, nonce, approved: true, uv: 'face', signature })).toBe(false)
    expect(env('ildra.device.enroll.confirm', { devicePub: pub, nonce, approved: true, uv: 'biometric' })).toBe(false) // signature required
    expect(env('ildra.device.enroll.confirm', { devicePub: pub, approved: true })).toBe(false)
    expect(env('ildra.device.enroll.status', { state: 'revoked', fingerprint: fp, at: 1 })).toBe(true)
    expect(env('ildra.device.enroll.status', { state: 'enrolled', fingerprint: fp, at: 1, uv: 'passcode' })).toBe(true)
    expect(env('ildra.device.enroll.replaced', { oldFingerprint: fp, newFingerprint: fp, source: 'local_socket', at: 1 })).toBe(true)
    expect(env('ildra.device.enroll.replaced', { oldFingerprint: fp, newFingerprint: fp, source: 'other', at: 1 })).toBe(false)
    expect(env('ildra.device.challenge', { nonce: randomBytes(32).toString('base64url') })).toBe(true)
    expect(env('ildra.device.proof', { signature: Buffer.alloc(64, 1).toString('base64') })).toBe(true)
    expect(env('ildra.device.proof', { signature: 'x' })).toBe(false)
  })
})

describe('Batch A: fingerprint, enroll.replaced, and the signed uv on enroll.confirm (Design Q55)', () => {
  const PK = phoneKeyPair()
  const clients = (): Record<string, IldraAskClient> => ({ dev: { identity: DEV, role: 'device' }, ph: { identity: PK.pub, role: 'web' } })
  const setup = () => { const r = rig(clients()); r.pair(PK.pub); return r }
  const send = (r: ReturnType<typeof setup>, body: Record<string, unknown>) => r.core.requests.ildra_device_enroll_confirm({ ...body, from: { phoneId: 'p1' } }, r.remote('ph'))

  it('the fingerprint is 16 digits (shown 4 groups of 4) from SHA-256 of the raw key, deterministic, and the RFC 8032 key gives the pinned value', () => {
    const rfc = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='
    expect(deviceFingerprint(rfc)).toMatch(/^[0-9]{16}$/) // shown as 4 groups of 4
    expect(deviceFingerprint(rfc)).toBe(deviceFingerprint(rfc))
    const raw = Buffer.from(rfc, 'base64')
    const n = BigInt('0x' + createHash('sha256').update(raw).digest().subarray(0, 8).toString('hex')) % 10n ** 16n
    expect(deviceFingerprint(rfc)).toBe(n.toString().padStart(16, '0'))
    expect(deviceFingerprint(deviceKeyPair().pub)).not.toBe(deviceFingerprint(rfc))
  })

  it('enroll and enroll.status carry the same fingerprint; status carries the journaled uv', async () => {
    const r = setup(); const { pub } = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: pub }, r.remote('dev'))
    const e = r.events.find((x) => x.type === 'ildra.device.enroll')!.body as { fingerprint: string; nonce: string; source: string }
    expect(e).toMatchObject({ fingerprint: deviceFingerprint(pub), source: 'device' })
    expect(e.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await send(r, signedConfirm(r.svc, PK.key, pub, true, 'passcode'))).toEqual({ ok: true, state: 'enrolled' })
    expect(r.events.find((x) => x.type === 'ildra.device.enroll.status')!.body).toMatchObject({ state: 'enrolled', fingerprint: e.fingerprint, uv: 'passcode' })
    expect(r.svc.journal().device.enrolled()).toMatchObject({ pub, uv: 'passcode', phoneId: 'p1' })
    const text = readFileSync(join(r.d, 'j', 'a.json'), 'utf8')
    expect(text).toContain('"uv":"passcode"')
    // The journaled uv survives a restart.
    const r2 = rig(clients(), r.d)
    expect(r2.svc.journal().device.enrolled()).toMatchObject({ pub, uv: 'passcode', phoneId: 'p1' })
  })

  it('a confirm without uv, with any other uv, or with uv outside the signature is refused and enrolls nothing', async () => {
    const r = setup(); const { pub } = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: pub }, r.remote('dev'))
    const good = signedConfirm(r.svc, PK.key, pub, true, 'biometric')
    const { uv: _uv, ...noUv } = good
    expect(await send(r, noUv)).toEqual({ ok: false, reason: 'malformed' })
    expect(await send(r, { ...good, uv: 'face' })).toEqual({ ok: false, reason: 'malformed' })
    expect(await send(r, { ...good, uv: null })).toEqual({ ok: false, reason: 'malformed' })
    expect(await send(r, signedConfirm(r.svc, PK.key, pub, true, 'face'))).toEqual({ ok: false, reason: 'malformed' })
    expect(await send(r, { ...good, uv: 'passcode' })).toEqual({ ok: false, reason: 'bad_signature' }) // uv is inside the signature
    expect(await send(r, { ...good, approved: false })).toEqual({ ok: false, reason: 'bad_signature' })
    const { signature: _s, ...noSig } = good
    expect(await send(r, noSig)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await send(r, signedConfirm(r.svc, deviceKeyPair().key, pub))).toEqual({ ok: false, reason: 'bad_signature' }) // not the paired key
    expect(r.svc.journal().device.device()).toBeNull()
    expect(r.events.some((x) => x.type === 'ildra.device.enroll.status')).toBe(false)
    expect(await send(r, good)).toEqual({ ok: true, state: 'enrolled' })
    expect(await send(r, good)).toEqual({ ok: false, reason: 'unknown_id' }) // a replay finds no pending enrollment
  })

  it('a signature over another nonce or another key is unknown_id; a signed decline is refused with the fingerprint', async () => {
    const r = setup(); const { pub } = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: pub }, r.remote('dev'))
    const wrongNonce = randomBytes(32).toString('base64url')
    const sig = (dp: string, n: string, a: boolean) => sign(null, Buffer.from(enrollConfirmMessage(dp, n, a, 'biometric'), 'utf8'), PK.key).toString('base64')
    expect(await send(r, { devicePub: pub, nonce: wrongNonce, approved: true, uv: 'biometric', signature: sig(pub, wrongNonce, true) })).toEqual({ ok: false, reason: 'unknown_id' })
    const other = deviceKeyPair().pub; const n = r.svc.journal().device.pending()!.nonce
    expect(await send(r, { devicePub: other, nonce: n, approved: true, uv: 'biometric', signature: sig(other, n, true) })).toEqual({ ok: false, reason: 'unknown_id' })
    expect(await send(r, signedConfirm(r.svc, PK.key, pub, false))).toEqual({ ok: true, state: 'refused' })
    expect(r.events.find((x) => x.type === 'ildra.device.enroll.status')!.body).toEqual({ state: 'refused', fingerprint: deviceFingerprint(pub), at: expect.any(Number) })
    expect(r.svc.journal().device.device()).toBeNull()
  })

  it('the protocol example confirm is a real signature by the RFC 8032 test 2 phone key over the test 1 device key', () => {
    const phonePub = 'PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw='
    const b = { devicePub: '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=', nonce: 'aWxkcmEtZW5yb2xsLWV4YW1wbGUtbm9uY2UtMzItYnk', approved: true, uv: 'biometric' as const,
      signature: 'jGPFORgmzKO7buZgTluXSuZbKnSjohKAtqpXR13aDUDHnPAxUkZG+elNQHP71W047eLaeUwqWkg3UdGLu0RpAw==' }
    expect(env('ildra.device.enroll.confirm', b)).toBe(true)
    expect(verifyEd25519(phonePub, enrollConfirmMessage(b.devicePub, b.nonce, b.approved, b.uv), b.signature)).toBe(true)
    expect(verifyEd25519(phonePub, enrollConfirmMessage(b.devicePub, b.nonce, b.approved, 'passcode'), b.signature)).toBe(false)
    expect(deviceFingerprint(b.devicePub)).toBe('9450083890274913')
  })

  it('a later enroll request, from the local socket too, replaces the pending one and alerts the phone with both fingerprints and the source', async () => {
    const r = setup(); const real = deviceKeyPair(); const evil = deviceKeyPair()
    await r.core.requests.ildra_device_enroll({ devicePub: real.pub }, r.remote('dev'))
    expect(r.events.some((x) => x.type === 'ildra.device.enroll.replaced')).toBe(false) // nothing pending before
    const realConfirm = signedConfirm(r.svc, PK.key, real.pub)
    await r.core.requests.ildra_device_enroll({ devicePub: evil.pub }, { local: true, owner: true, connection: 'local:sock' })
    expect(r.events.find((x) => x.type === 'ildra.device.enroll.replaced')!.body).toEqual({ oldFingerprint: deviceFingerprint(real.pub), newFingerprint: deviceFingerprint(evil.pub), source: 'local_socket', at: expect.any(Number) })
    expect(r.events.filter((x) => x.type === 'ildra.device.enroll').map((x) => (x.body as { source: string }).source)).toEqual(['device', 'local_socket'])
    expect(await send(r, realConfirm)).toEqual({ ok: false, reason: 'unknown_id' }) // the pushed-out one cannot be confirmed
    await r.core.requests.ildra_device_enroll({ devicePub: real.pub }, r.remote('dev'))
    expect(r.events.filter((x) => x.type === 'ildra.device.enroll.replaced').at(-1)!.body).toMatchObject({ oldFingerprint: deviceFingerprint(evil.pub), source: 'device' })
    expect(await send(r, realConfirm)).toEqual({ ok: false, reason: 'unknown_id' }) // a fresh nonce: the old signature is dead
    expect(await send(r, signedConfirm(r.svc, PK.key, real.pub))).toEqual({ ok: true, state: 'enrolled' })
  })
})

describe('R7 ledger rule: the Ask service settles only answers stamped by the core channel layer', () => {
  it('a direct settle on the service ledger, whatever via it claims, is no_authority; the core-stamped answer settles', async () => {
    const r = rig({ ph: { identity: PHONE, role: 'web' } }); r.pair(PHONE)
    const p = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await tick()
    const req = r.sent[0]!
    const l = r.svc.journal().ledger
    expect(l.requiresChannelStamp()).toBe(true)
    const forged = { id: req.id, digest8: req.digest8, answerId: aid(), approved: true, via: 'phone', from: { phoneId: 'p1', machinePub: PHONE } } as AskAnswer
    expect(l.settle(forged, { via: 'phone', isPaired: () => true })).toEqual({ ok: false, reason: 'no_authority' })
    expect(l.pending()).toBe(1)
    await r.answer(req, 'ph', { from: { phoneId: 'p1' } })
    expect(await p).toMatchObject({ approved: true, channel: 'phone' })
  })
  it('architecture: only core/ildraAsk.ts imports stampChannel', () => {
    const root = new URL('..', import.meta.url)
    const hits: string[] = []
    const walk = (dir: URL, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`); continue }
        if (!/\.tsx?$/.test(e.name) || /\.spec\.tsx?$/.test(e.name)) continue
        const text = readFileSync(new URL(e.name, dir), 'utf8')
        if (/\bstampChannel\b/.test(text) && `${rel}${e.name}` !== 'core/ildraChannel.ts') hits.push(`${rel}${e.name}`)
      }
    }
    walk(root, '')
    expect(hits).toEqual(['core/ildraAsk.ts'])
  })
})

describe('R7-2: hidden characters by category (Unicode 16.0.0)', () => {
  const send = async (recipient: string, message = 'hi') => {
    let req: AskRequest | undefined
    const out = await ask(T, 'Send an email', null, (_c, _p, q) => { req = q!; return null },
      { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch', 'phone'], isPaired: () => true, send: { recipient, message } })
    return { out, req }
  }
  const tags = Array.from({ length: 0x80 }, (_, i) => String.fromCodePoint(0xE0000 + i))
  const samples = ['\u00AD', '\u034F', '\u2063', '\uFE0F', '\u061C', '\u180E', '\u200B', '\u2066', '\u3164', '\uFFA0', '\u{1D173}', '\u{E0100}', ...tags]
  it('each one in the recipient is refused (malformed) and no Ask opens; in the first line each is a visible marker', async () => {
    for (const c of ['\u00AD', '\u034F', '\u2063', '\uFE0F', '\u{E0000}', '\u{E0041}', '\u{E007F}']) {
      const { out, req } = await send(`bo${c}b@x.com`)
      expect(out, JSON.stringify(c)).toMatchObject({ approved: false, reason: 'malformed' })
      expect(req, JSON.stringify(c)).toBeUndefined()
      const cp = c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
      expect(markHidden(`a${c}b`)).toBe(`a\u27E6U+${cp}\u27E7b`)
      const shown = await send('bob@x.com', `Hi${c} there`)
      expect(shown.req!.firstLine).toContain(`\u27E6U+${cp}\u27E7`)
    }
  })
  it('every sample, all 128 tags included, is refused by the daemon and by the schema pattern', async () => {
    const re = new RegExp(HIDDEN_SCHEMA_PATTERN, 'u')
    for (const c of samples) {
      expect((await send(`a${c}@x.com`)).out.reason, JSON.stringify(c)).toBe('malformed')
      expect(re.test(`a${c}@x.com`), JSON.stringify(c)).toBe(false)
    }
    expect(re.test('jos\u00E9@example.com')).toBe(true)
  })
  it('the table is pinned and the schema carries exactly its pattern', () => {
    expect(HIDDEN_VERSION).toBe('16.0.0')
    expect(HIDDEN_COUNT).toBe(4273)
    expect(Object.keys(HIDDEN_SOURCES).sort()).toEqual(['DerivedCoreProperties.txt', 'PropList.txt', 'UnicodeData.txt'])
    expect(schema.$defs.AskRequest.properties.recipient.pattern).toBe(HIDDEN_SCHEMA_PATTERN)
  })
})

describe('R7-3: script mixing over the whole address, non-ASCII anywhere', () => {
  const show = async (recipient: string, contacts: string[] = []) => {
    let req: AskRequest | undefined
    const out = await ask(T, 'Send an email', null, (_c, _p, q) => { req = q!; return null },
      { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'], contacts, send: { recipient, message: 'hi' } })
    return { out, req }
  }
  it('an all-Cyrillic local part before an ASCII domain (palochka, skeleton apple-ish) is mixed_script and non_ascii, never on the device', async () => {
    const cyr = '\u0430\u0440\u0440\u04CF\u0435@gmail.com'
    for (const contacts of [[], ['apple@gmail.com']]) {
      expect(recipientFlags(cyr, { contacts })).toEqual(expect.arrayContaining(['mixed_script', 'non_ascii']))
      const { out, req } = await show(cyr, contacts)
      expect(req).toBeUndefined() // phone only, and no phone here
      expect(out).toMatchObject({ approved: false, reason: 'no_channel' })
    }
  })
  it('a non-ASCII local part alone is non_ascii (phone only), not mixed_script', () => {
    const f = recipientFlags('jos\u00E9@example.com')
    expect(f).toContain('non_ascii'); expect(f).not.toContain('mixed_script')
    expect(recipientFlags('ann@example.com')).not.toContain('non_ascii')
  })
})

describe('R7-4: no Auto from an untrusted hint; a send is never Auto', () => {
  it('a third-party or unstamped readOnlyHint is a write; a trusted first-party one is a read', () => {
    const tp = stampManifest([{ name: 'evil.wipe', annotations: { readOnlyHint: true } }], 'third_party', 'evil')
    expect(classifyTool(tp, 'evil.wipe')).toBe('write')
    expect(resolveTool(T, 'evil.wipe', tp)).toBe('ask')
    expect(classifyTool([{ name: 'raw', annotations: { readOnlyHint: true } }], 'raw')).toBe('write')
    expect(classifyTool(stampManifest([{ name: 'mcp.search', annotations: { readOnlyHint: true } }], 'first_party'), 'mcp.search')).toBe('read')
  })
  it('a send through a trusted read tool, or on an auto template item, still asks', async () => {
    const fp = stampManifest([{ name: 'mcp.search', annotations: { readOnlyHint: true } }], 'first_party')
    for (const [action, k] of [['Search', { manifest: fp, tool: 'mcp.search' }], ['Send a note', kind]] as const) {
      let prompted = 0
      const out = await ask(T, action, null, () => { prompted++; return null },
        { kind: k, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'], send: { recipient: 'boss@company.com', message: 'Wire $9,000 now' } })
      expect(out.tier, action).not.toBe('auto')
      expect(prompted, action).toBe(1)
    }
  })
})

describe('R7-10: an unpaired phone answer is refused first and spends nothing', () => {
  it('an unpaired answer leaves the Ask open with nothing recorded; then the real phone approves', async () => {
    const r = rig({ ph: { identity: PHONE, role: 'web' }, x: { identity: OTHER, role: 'web' } }); r.pair(PHONE)
    const p = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await tick()
    const l = r.svc.journal().ledger
    const before = JSON.stringify(l.toJSON())
    const answerId = aid()
    await r.answer(r.sent[0]!, 'x', { from: { phoneId: 'p1' }, answerId })
    await tick()
    expect(JSON.stringify(l.toJSON())).toBe(before) // no answerId, no spend
    expect(l.attempts()).toEqual([])
    expect(r.events.filter((e) => e.type === 'ildra.ask.attempt')).toEqual([])
    // The real phone may even reuse that answerId: it was never recorded.
    await r.answer(r.sent[r.sent.length - 1]!, 'ph', { from: { phoneId: 'p1' }, answerId })
    expect(await p).toMatchObject({ approved: true, channel: 'phone', reason: 'approved' })
  })
  it('a flood of 200 unpaired answers to a payment Ask never ends it (no reprompt cap); then the real phone approves', async () => {
    const r = rig({ ph: { identity: PHONE, role: 'web' }, x: { identity: OTHER, role: 'web' } }); r.pair(PHONE)
    const P: ApprovalTemplate = { permissions: { ask: ['Pay an invoice'] } }
    const p = r.svc.ask(P, 'Pay an invoice', null, { kind, agentId: 'a', available: ['phone'], amountMinor: 900_000 })
    await tick()
    const req = r.sent[0]!
    expect(req.channel).toBe('phone')
    let settled = false
    void p.then(() => { settled = true })
    for (let i = 0; i < 200; i++) {
      await r.answer(r.sent[r.sent.length - 1]!, 'x', { from: { phoneId: 'p1' } })
      await tick()
    }
    expect(settled).toBe(false)
    const l = r.svc.journal().ledger
    expect(l.pending()).toBe(1)
    expect(l.attempts()).toEqual([])
    expect(l.unpairedCount().count).toBe(200)
    expect(r.events.filter((e) => e.type === 'ildra.ask.unpaired')).toHaveLength(1) // once per window
    expect(r.sent[r.sent.length - 1]!.id).toBe(req.id)
    await r.answer(r.sent[r.sent.length - 1]!, 'ph', { from: { phoneId: 'p1' } })
    expect(await p).toMatchObject({ approved: true, channel: 'phone', reason: 'approved' })
  })
  it('the same through ask() directly with channel-stamped answers; after expiry the flood ends it as expired', async () => {
    let now = 1_000_000
    const pp = new PhonePairing({ now: () => now }); const { code } = pp.begin('touch'); pp.offer('p1', PHONE, code); pp.confirm('p1', 'touch', true)
    const P: ApprovalTemplate = { permissions: { ask: ['Pay an invoice'] } }
    for (const finalKey of [PHONE, null]) {
      const ledger = new AskLedger({ now: () => now, requireChannelStamp: true })
      let n = 0
      const out = await ask(P, 'Pay an invoice', null, (_c, _p, q) => {
        n++
        const a = { id: q!.id, digest8: q!.digest8, answerId: aid(), approved: true, via: 'phone', from: { phoneId: 'p1', machinePub: n <= 200 || finalKey === null ? OTHER : PHONE } }
        if (n > 200 && finalKey === null) now = q!.expiresAt // the flood outlives the Ask
        stampForTest(a, 'phone') // as the core channel layer does for every remote answer
        return a
      }, { kind, ledger, window: new ApprovalWindow(), agentId: 'a', available: ['phone'], pairing: pp, amountMinor: 900_000 })
      if (finalKey) expect(out).toMatchObject({ approved: true, reason: 'approved' })
      else expect(out).toMatchObject({ approved: false, reason: 'expired' })
      expect(n).toBe(201)
    }
  })
  it('it is checked before anything else: a wrong digest or a bad challenge from an unpaired key is still unpaired_phone', () => {
    const l = new AskLedger(); const pp = new PhonePairing(); const { code } = pp.begin('touch'); pp.offer('p1', PHONE, code); pp.confirm('p1', 'touch', true)
    const req = l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone' })
    const ctx = { via: 'phone' as const, isPaired: (id: string, pub?: string) => (pub === undefined ? pp.isPaired(id) : pp.isPairedKey(id, pub)) }
    expect(l.settle({ id: req.id, digest8: 'deadbeef', answerId: aid(), approved: true, via: 'phone', from: { phoneId: 'p1', machinePub: OTHER } } as AskAnswer, ctx)).toEqual({ ok: false, reason: 'unpaired_phone' })
    expect(l.pending()).toBe(1)
    expect(l.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, via: 'phone', from: { phoneId: 'p1', machinePub: PHONE } } as AskAnswer, ctx)).toEqual({ ok: true })
  })
  it('only an aggregate count reaches the paired phone: once per window at the threshold', () => {
    let now = 1_000_000
    const l = new AskLedger({ now: () => now })
    const seen: { count: number; since: number; at: number }[] = []
    l.onUnpaired = (u) => seen.push(u)
    const req = l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone' })
    const ctx = { via: 'phone' as const, isPaired: () => false }
    const bad = (): unknown => l.settle({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, via: 'phone', from: { phoneId: 'p1', machinePub: OTHER } } as AskAnswer, ctx)
    for (let i = 0; i < UNPAIRED_NOTIFY - 1; i++) bad()
    expect(seen).toEqual([])
    bad(); bad(); bad()
    expect(seen).toEqual([{ count: UNPAIRED_NOTIFY, since: 1_000_000, at: 1_000_000 }])
    now += UNPAIRED_WINDOW_MS
    for (let i = 0; i < UNPAIRED_NOTIFY; i++) bad()
    expect(seen).toHaveLength(2)
    expect(l.pending()).toBe(1)
    expect(valid('AskUnpaired', seen[0])).toBe(true)
    expect(valid('AskUnpaired', { ...seen[0], count: 4 })).toBe(false) // locked: always 3
    expect([UNPAIRED_WINDOW_MS, UNPAIRED_NOTIFY]).toEqual([600_000, 3])
    // App R7-10: unpaired_phone is never a phone attempt on the wire.
    expect(valid('AskAttempt', { id: req.id, answerId: aid(), channel: 'phone', reason: 'unpaired_phone', at: 1 })).toBe(false)
    expect(valid('AskAttempt', { id: req.id, answerId: aid(), channel: 'phone', reason: 'digest_mismatch', at: 1 })).toBe(true)
    expect(seen[0]).not.toHaveProperty('id')
  })
})

describe('Shield R7 ruling: pairing state, not an unpaired answer, ends a phone Ask (no_paired_phone)', () => {
  it('with no phone paired, an unpaired answer is refused (unpaired_phone) and the Ask stays open', () => {
    const l = new AskLedger({ requireChannelStamp: true })
    const req = l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone' })
    const a = stampForTest({ id: req.id, digest8: req.digest8, answerId: aid(), approved: true, from: { phoneId: 'p1', machinePub: OTHER } } as AskAnswer, 'phone')
    expect(l.settle(a, { isPaired: () => false })).toEqual({ ok: false, reason: 'unpaired_phone' })
    expect(l.pending()).toBe(1)
    expect(l.endedReason(req.id)).toBeNull()
  })
  it('runtime: an unpaired answer leaves it open; unpairing the last phone ends it with no_paired_phone, and the outcome is on the wire', async () => {
    const r = rig({ ph: { identity: PHONE, role: 'web' }, x: { identity: OTHER, role: 'web' } }); r.pair(PHONE)
    const p = r.svc.ask(T, 'Brakes step', null, { kind, agentId: 'a', available: ['phone'] })
    await tick()
    await r.answer(r.sent[0]!, 'x', { from: { phoneId: 'p1' } })
    await tick()
    expect(r.svc.journal().ledger.pending()).toBe(1)
    r.svc.journal().pairing.unpair('p1')
    const out = await p
    expect(out).toMatchObject({ approved: false, channel: 'phone', reason: 'no_paired_phone' })
    expect(r.svc.journal().ledger.pending()).toBe(0)
    const ev = r.events.find((e) => e.type === 'ildra.ask.outcome')
    expect(ev?.body).toMatchObject({ reason: 'no_paired_phone' })
    expect(env('ildra.ask.outcome', ev!.body)).toBe(true)
    // A late answer from the re-paired phone cannot revive it.
    r.pair(PHONE)
    expect(await r.answer(r.sent[r.sent.length - 1]!, 'ph', { from: { phoneId: 'p1' } })).toMatchObject({ ok: false })
  })
  it('direct ask() on a journal: the unpair ends the waiting Ask; a device Ask is untouched; opening with no phone paired is no_paired_phone', async () => {
    const d = mkdtempSync(join(tmpdir(), 'build-r7n-'))
    const j = openJournal(join(d, 'j', 'j.json'), { markerPath: join(d, 'm', 'x') })
    const { code } = j.pairing.begin('touch'); j.pairing.offer('p1', PHONE, code); j.pairing.confirm('p1', 'touch', true)
    const dev = j.ledger.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    let n = 0
    const out = await ask(T, 'Brakes step', null, (_c, _p, q) => {
      n++
      if (n === 2) j.pairing.unpair('p1')
      return stampForTest({ id: q!.id, digest8: q!.digest8, answerId: aid(), approved: true, from: { phoneId: 'p1', machinePub: OTHER } }, 'phone')
    }, { kind, ledger: j.ledger, window: j.window, agentId: 'a', available: ['phone'], pairing: j.pairing })
    expect(out).toMatchObject({ approved: false, reason: 'no_paired_phone' })
    expect(n).toBe(2)
    expect(j.ledger.get(dev.id)).not.toBeNull()
    expect(await ask(T, 'Brakes step', null, () => null, { kind, ledger: j.ledger, window: j.window, agentId: 'a', available: ['phone'], pairing: j.pairing }))
      .toMatchObject({ approved: false, channel: null, reason: 'no_paired_phone' })
    // Only phone-only Asks whose route is the phone say no_paired_phone; no phone channel at all stays no_channel.
    expect(await ask(T, 'Brakes step', null, () => null, { kind, ledger: j.ledger, window: j.window, agentId: 'a', available: ['touch'], pairing: j.pairing }))
      .toMatchObject({ approved: false, channel: null, reason: 'no_channel' })
  })
})

describe('R7-10 bound: only channel-stamped refusals are uncounted', () => {
  it('an unstamped in-process unpaired answerFn (no remote sender) keeps the MAX_REPROMPTS bound and ends with unpaired_phone', async () => {
    const pp = new PhonePairing(); const { code } = pp.begin('touch'); pp.offer('p1', PHONE, code); pp.confirm('p1', 'touch', true)
    let n = 0
    const out = await ask(T, 'Brakes step', null, (_c, _p, q) => { n++; return { id: q!.id, digest8: q!.digest8, answerId: aid(), approved: true, from: { phoneId: 'evil' } } },
      { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['phone'], pairing: pp })
    expect(out).toMatchObject({ approved: false, reason: 'unpaired_phone' })
    expect(n).toBe(101)
  })
})

describe('App R7 schema rule: lookalike requires an ASCII lookalikeOf, and the daemon always sends one', () => {
  const base = { id: '3a1f7c2e-9d4b-4e6a-8c0f-1b2d3e4f5a6b', digest8: 'c6327fa9', openedAt: 1, expiresAt: 86400001, channel: 'phone', tier: 'ask', action: 'Send an email', recipient: 'dana@ex\u0430mple.com', firstLine: 'hi', recipientAscii: 'dana@xn--exmple-4nf.com' }
  it('the schema requires lookalikeOf with the flag and only allows ASCII', () => {
    expect(valid('AskRequest', { ...base, recipientFlags: ['lookalike'] })).toBe(false)
    expect(valid('AskRequest', { ...base, recipientFlags: ['lookalike'], lookalikeOf: 'dana@example.com' })).toBe(true)
    expect(valid('AskRequest', { ...base, recipientFlags: ['lookalike'], lookalikeOf: 'jos\u00E9@example.com' })).toBe(false)
  })
  it('the daemon request with the flag carries an ASCII lookalikeOf, also for a contact whose local part is not ASCII', async () => {
    for (const [recipient, contact, expected] of [
      ['dana@ex\u0430mple.com', 'dana@example.com', 'dana@example.com'],
      ['jos\u00E9@ex\u0430mple.com', 'jos\u00E9@example.com', 'example.com'],
    ] as const) {
      expect(lookalikeOf(recipient, { contacts: [contact] })).toBe(expected)
      let req: AskRequest | undefined
      await ask(T, 'Send an email', null, (_c, _p, q) => { req = q!; return null },
        { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['phone'], isPaired: () => true, pairing: paired(), contacts: [contact], send: { recipient, message: 'hi' } })
      expect(req!.recipientFlags).toContain('lookalike')
      expect(req!.lookalikeOf).toBe(expected)
      expect(/^[\u0021-\u007E]+$/.test(req!.lookalikeOf!)).toBe(true)
      expect(valid('AskRequest', req), JSON.stringify(req)).toBe(true)
      expect(toDeviceMessage(req!, 1)).toBeDefined()
    }
  })
})
