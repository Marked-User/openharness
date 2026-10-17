/**
 * Wire checks for the v3 protocol additions (DECISIONS ad47477, DEVICE-INTERFACE section 11): answerId,
 * ildra.ask.attempt, ildra.ask.handoff, AskOutcome reasons, and the digest8 vectors. Uses the vendored schema;
 * the Ildra repo's protocol/examples are checked when present (ILDRA_PROTOCOL_DIR, or the sibling checkout).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020Module from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  ANSWER_ID, ApprovalDenied, AskLedger, InvalidUnicode, PhonePairing, actionDigest8, ask, askKindFor, canonicalJson, fromDeviceReply, neverOutcome, stampManifest,
  type ApprovalTemplate, type AskRequest, type ToolManifestEntry,
} from './approvals.js'

const schema = JSON.parse(readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module
const ajv = new (Ajv2020 as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true })
ajv.addSchema(schema)
const errs = (ref: string, v: unknown): string[] => {
  const f = ajv.getSchema(ref)!
  return f(v) ? [] : (f.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`)
}
const def = (name: string) => `${schema.$id}#/$defs/${name}`
const env = (type: string, body: unknown) => errs(schema.$id, { type, proto: 1, body })
const PROTOCOL = process.env.ILDRA_PROTOCOL_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'protocol')
const hasProtocol = existsSync(join(PROTOCOL, 'examples'))

describe('answerId', () => {
  it('schema AnswerId and the ledger accept exactly the same strings', () => {
    const cases: [unknown, boolean][] = [
      [randomUUID(), true], [randomBytes(16).toString('hex'), true], ['A'.repeat(16), true], ['a-'.repeat(32), true],
      ['a'.repeat(15), false], ['a'.repeat(65), false], ['', false], ['under_score_123456', false], ['sp ace 1234567890', false], [7, false],
    ]
    for (const [v, ok] of cases) {
      expect(errs(def('AnswerId'), v).length === 0, String(v)).toBe(ok)
      expect(typeof v === 'string' && ANSWER_ID.test(v), String(v)).toBe(ok)
    }
  })
  it('is required on AskAnswer; a mapped device reply validates', () => {
    expect(errs(def('AskAnswer'), { id: randomUUID(), digest8: '0011aabb', approved: true }).join()).toMatch(/answerId/)
    const a = fromDeviceReply({ type: 'prompt.reply', id: randomUUID(), answer_id: randomBytes(16).toString('hex'), answer: 'yes', digest8: '0011aabb', hold_ms: 1620 })
    expect(env('ildra.ask.answer', a)).toEqual([])
  })
})

describe('ildra.ask.attempt, ildra.ask.handoff and outcome reasons from the daemon', () => {
  it('a short hold emits a valid ildra.ask.attempt; one with no holdMs omits it', () => {
    const l = new AskLedger()
    const seen: unknown[] = []
    l.onAttempt = (a) => seen.push(a)
    const r = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    l.settle({ id: r.id, digest8: r.digest8, answerId: randomBytes(16).toString('hex'), approved: true, holdMs: 300 })
    l.settle({ id: r.id, digest8: r.digest8, answerId: randomUUID(), approved: true })
    expect(seen).toHaveLength(2)
    for (const a of seen) expect(env('ildra.ask.attempt', a)).toEqual([])
    expect(seen[1]).not.toHaveProperty('holdMs')
    expect(l.toJSON().attempts).toEqual(seen)
    expect(env('ildra.ask.attempt', { ...(seen[0] as object), reason: 'expired' }).length).toBeGreaterThan(0)
    expect(env('ildra.ask.attempt', { ...(seen[0] as object), channel: 'phone' }).length).toBeGreaterThan(0)
  })
  it('attempts survive a journal round trip', () => {
    const l = new AskLedger()
    const r = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    l.settle({ id: r.id, digest8: r.digest8, answerId: randomUUID(), approved: true, holdMs: 10 })
    const back = new AskLedger()
    back.restore(JSON.parse(JSON.stringify(l.toJSON())))
    expect(back.attempts()).toEqual(l.attempts())
  })
  it('a stale_channel attempt after a handoff validates', () => {
    const l = new AskLedger()
    const seen: unknown[] = []
    l.onAttempt = (a) => seen.push(a)
    const r = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    l.handoff(r.id, 'phone')
    expect(l.settle({ id: r.id, digest8: r.digest8, answerId: randomBytes(16).toString('hex'), approved: true, holdMs: 1700 })).toEqual({ ok: false, reason: 'stale_channel' })
    expect(seen).toHaveLength(1)
    expect(env('ildra.ask.attempt', seen[0])).toEqual([])
    expect(env('ildra.ask.rejection', { ok: false, reason: 'stale_channel' })).toEqual([])
  })
  it('handoff output validates; only touch to phone', () => {
    const l = new AskLedger()
    const r = l.open({ action: 'a', tier: 'ask', channel: 'touch' })
    expect(env('ildra.ask.handoff', l.handoff(r.id, 'phone'))).toEqual([])
    expect(env('ildra.ask.handoff', { id: r.id, from: 'phone', to: 'touch', at: 1 }).length).toBeGreaterThan(0)
  })
  it('AskOutcome: reason always; approved exactly when approved; denied, expired, no_channel, never, malformed otherwise', () => {
    expect(env('ildra.ask.outcome', { approved: true, channel: 'touch', tier: 'ask', reason: 'approved' })).toEqual([])
    expect(env('ildra.ask.outcome', { approved: true, channel: 'touch', tier: 'ask' }).length).toBeGreaterThan(0)
    for (const reason of ['denied', 'expired', 'no_channel', 'malformed', 'stale_channel', 'digest_mismatch']) {
      expect(env('ildra.ask.outcome', { approved: false, channel: reason === 'no_channel' ? null : 'touch', tier: 'ask', reason }), reason).toEqual([])
    }
    expect(env('ildra.ask.outcome', neverOutcome())).toEqual([])
    expect(env('ildra.ask.outcome', { approved: true, channel: 'touch', tier: 'ask', reason: 'denied' }).length).toBeGreaterThan(0)
    expect(env('ildra.ask.outcome', { approved: false, channel: 'touch', tier: 'ask', reason: 'approved' }).length).toBeGreaterThan(0)
  })
})

describe.runIf(hasProtocol)('Ildra protocol files', () => {
  it('every example validates', () => {
    const files = readdirSync(join(PROTOCOL, 'examples')).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) expect(errs(schema.$id, JSON.parse(readFileSync(join(PROTOCOL, 'examples', f), 'utf8'))), f).toEqual([])
  })
  it('the schema is byte-identical to the vendored copy', () => {
    expect(readFileSync(join(PROTOCOL, 'ildra-messages.schema.json'), 'utf8')).toBe(readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
  })
  it('digest8 vectors match actionDigest8 (rerun scripts/ildra/gen-protocol-vectors.ts after a rule change)', () => {
    const text = readFileSync(join(PROTOCOL, 'examples', 'vectors', 'digest8.json'), 'utf8')
    expect(readFileSync(new URL('./ildra-digest8-vectors.json', import.meta.url), 'utf8')).toBe(text) // vendored copy
    const v = JSON.parse(text) as { vectors: { name: string; action: string; fields: Record<string, unknown>; jcs: string | null; digest8: string | null; refused?: string }[] }
    expect(v.vectors.filter((x) => !x.refused).length).toBeGreaterThanOrEqual(6)
    expect(v.vectors.filter((x) => x.refused === 'malformed').length).toBeGreaterThanOrEqual(1)
    for (const x of v.vectors) {
      if (x.refused) { expect(() => actionDigest8(x.action, x.fields), x.name).toThrow(InvalidUnicode); continue }
      expect(canonicalJson({ ...x.fields, action: x.action }), x.name).toBe(x.jcs)
      expect(actionDigest8(x.action, x.fields), x.name).toBe(x.digest8)
    }
  })
})

describe('AskRequest.kind (Design copy): safety_verification on locked_ask, daemon-set, display only', () => {
  const T = { permissions: { ask: ['Rename a file'], locked_ask: ['Brakes step', 'Torque check'] }, safety_verification: ['Brakes step'] }
  const paired = () => { const p = new PhonePairing(); const { code } = p.begin('touch'); p.offer('p1', 'pub1', code); p.confirm('p1', 'touch', true); return p }
  const run = async (action: string, manifest: ToolManifestEntry[], tool = 't', template: ApprovalTemplate = T) => {
    let req: AskRequest | undefined
    await ask(template, action, null, (_c, _p, r) => { req = r; return null }, { ledger: new AskLedger(), pairing: paired(), kind: { manifest, tool }, available: ['phone'], agentId: 'rg' })
    return req!
  }
  it('comes from the template list or a trusted manifest entry; validates; not in the digest', async () => {
    const a = await run('Brakes step', stampManifest([{ name: 't', send: false }], 'bridge'))
    expect(a.kind).toBe('safety_verification')
    expect(env('ildra.ask.request', a)).toEqual([])
    const b = await run('Torque check', stampManifest([{ name: 't', send: false, safetyVerification: true }], 'bridge'))
    expect(b.kind).toBe('safety_verification')
    const plain = await run('Brakes step', stampManifest([{ name: 't', send: false }], 'bridge'), 't', { permissions: T.permissions })
    expect(plain.kind).toBeUndefined()
    expect(plain.digest8).toBe(a.digest8)
    expect(a.digest8).toBe(actionDigest8('Brakes step', { agentId: 'rg', tier: 'locked_ask' }))
  })
  it('never from an untrusted manifest entry, never on a plain Ask, never from the caller', async () => {
    expect((await run('Torque check', stampManifest([{ name: 't', send: false, safetyVerification: 'yes' }], 'bridge'))).kind).toBeUndefined()
    const third = stampManifest(stampManifest([{ name: 't', safetyVerification: true }], 'bridge'), 'third_party') // claimed owner is overwritten
    expect(askKindFor(T, 'Torque check', 'locked_ask', { manifest: third, tool: 't' })).toBeUndefined()
    expect(askKindFor(T, 'Torque check', 'locked_ask', { manifest: stampManifest([{ name: 't', safetyVerification: true }], 'bridge'), tool: 't' })).toBe('safety_verification')
    expect(askKindFor({ permissions: { ask: ['x'] }, safety_verification: ['x'] }, 'x', 'ask')).toBeUndefined()
    // AskOptions has no kind field for the request (opts.kind is the tool manifest); the ledger refuses a bad one.
    expect(() => new AskLedger().open({ action: 'x', tier: 'ask', channel: 'touch', kind: 'safety_verification' })).toThrow(ApprovalDenied)
    expect(() => new AskLedger().open({ action: 'x', tier: 'locked_ask', channel: 'phone', kind: 'other' as never })).toThrow(ApprovalDenied)
  })
  it('the schema allows kind only on locked_ask', () => {
    const r = new AskLedger().open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone', kind: 'safety_verification' })
    expect(env('ildra.ask.request', r)).toEqual([])
    expect(env('ildra.ask.request', { ...r, tier: 'ask' }).length).toBeGreaterThan(0)
    expect(env('ildra.ask.request', { ...r, kind: 'other' }).length).toBeGreaterThan(0)
  })
  it('survives a journal round trip', () => {
    const l = new AskLedger()
    const r = l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'phone', kind: 'safety_verification' })
    const back = new AskLedger(); back.restore(JSON.parse(JSON.stringify(l.toJSON())))
    expect(back.toJSON().open[0]).toMatchObject({ id: r.id, kind: 'safety_verification' })
  })
})
