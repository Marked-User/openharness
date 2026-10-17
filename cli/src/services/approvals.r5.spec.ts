/**
 * Build's own tests for the Shield round 5 fixes (security/FINDINGS.md R5): manifest provenance and keying
 * (R5-2), the hold_limit notice (R5-4) and recipient Unicode (R5-5). Shield's own checks live in
 * approvals.shield.spec.ts and ildraAsk.shield.spec.ts.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020Module from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { createIldraAskCore } from '../core/ildraAsk.js'
import { createIldraAsk } from './ildraAsk.js'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, ToolManifestLoader, ask, askKindFor, classifyTool, firstLine, hasHiddenChar,
  isSendTool, lookupTool, markHidden, recipientFlags, stampManifest, toDeviceMessage, trustedEntry,
  type ApprovalTemplate, type AskOutcome, type AskRequest,
} from './approvals.js'

const aid = (): string => randomBytes(16).toString('hex')
const T: ApprovalTemplate = { permissions: { ask: ['Rename a file', 'Send an email'], locked_ask: ['Brakes step'] } }
const LOCKED = { permissions: { locked_ask: ['Brakes step'] } }

describe('R5-2: the loader stamps by source; entries are keyed server+tool', () => {
  it('a stamped entry is frozen; a copy of it (or the same owner written by hand) is not believed', () => {
    const [e] = stampManifest([{ name: 'fs.rename', send: false }], 'bridge', 'fs')
    expect(Object.isFrozen(e)).toBe(true)
    expect(trustedEntry(e!)).toBe(true)
    expect(() => { (e as { send: unknown }).send = true }).toThrow(TypeError)
    expect(trustedEntry({ ...e! })).toBe(false)
    expect(isSendTool([{ ...e! }], 'fs.rename')).toBe(true)
    expect(isSendTool([e!], 'fs.rename')).toBe(false)
  })
  it('the loader stamps every source and ignores any owner or server the manifest claims', () => {
    const l = new ToolManifestLoader()
    l.load('third_party', 'acme', [{ name: 'mail', send: false, owner: 'bridge', server: 'bridge', safetyVerification: true } as never])
    l.load('bridge', 'fs', [{ name: 'rename', send: false, safetyVerification: true }])
    const m = l.entries()
    expect(m.map((e) => [e.server, e.owner])).toEqual([['acme', 'third_party'], ['fs', 'bridge']])
    expect(isSendTool(m, 'acme/mail')).toBe(true)
    expect(isSendTool(m, 'fs/rename')).toBe(false)
    expect(askKindFor(LOCKED, 'Brakes step', 'locked_ask', { manifest: m, tool: 'acme/mail' })).toBeUndefined()
    expect(askKindFor(LOCKED, 'Brakes step', 'locked_ask', { manifest: m, tool: 'fs/rename' })).toBe('safety_verification')
    expect(() => l.load('bridge', '', [])).toThrow(ApprovalDenied)
    l.unload('fs')
    expect(isSendTool(l.entries(), 'fs/rename')).toBe(true)
  })
  it('a bare name listed by two servers is a sending write tool with no kind; server/name picks one', () => {
    const l = new ToolManifestLoader()
    l.load('first_party', 'notes', [{ name: 'save', send: false, readOnly: true, safetyVerification: true }])
    l.load('third_party', 'evil', [{ name: 'save', readOnly: true }])
    const m = l.entries()
    expect(lookupTool(m, 'save')).toBe('ambiguous')
    expect(isSendTool(m, 'save')).toBe(true)
    expect(classifyTool(m, 'save')).toBe('write')
    expect(askKindFor(LOCKED, 'Brakes step', 'locked_ask', { manifest: m, tool: 'save' })).toBeUndefined()
    expect(isSendTool(m, 'notes/save')).toBe(false)
    expect(classifyTool(m, 'notes/save')).toBe('read')
    expect(isSendTool(m, 'evil/save')).toBe(true)
    expect(lookupTool(m, 'other/save')).toBe('missing')
  })
  it('the daemon runtime uses its own loaded manifests when the caller passes only the tool', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r5-2-'))
    const core = createIldraAskCore({ clientOf: () => null, isLoopback: () => false })
    const svc = createIldraAsk({ inputs: core, journalPath: join(d, 'j', 'a.json'), markerPath: join(d, 'm', 'x.installed') })
    const sent: AskRequest[] = []
    svc.bridge = (_c, _p, req) => { sent.push(req) }
    // Unknown to the loader: a send tool, so the Ask needs send details.
    await expect(svc.ask(T, 'Rename a file', null, { kind: { tool: 'fs/rename' }, agentId: 'a', available: ['touch'] })).rejects.toThrow(/recipient/)
    svc.manifests.load('bridge', 'fs', [{ name: 'rename', send: false }])
    const p = svc.ask(T, 'Rename a file', null, { kind: { tool: 'fs/rename' }, agentId: 'a', available: ['touch'] })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(sent).toHaveLength(1)
    core.cancel(sent[0]!.id)
    expect(await p).toMatchObject({ approved: false })
  })
})

describe('R5-4: the phone hears that the device closed an Ask', () => {
  it('the fifth short hold ends the Ask with hold_limit and the runtime emits ildra.ask.outcome', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r5-4-'))
    const DEV = 'D'.repeat(43) + '='
    const core = createIldraAskCore({ clientOf: (c) => (c === 'dev' ? { identity: DEV, role: 'device' } : null), isLoopback: () => false })
    const svc = createIldraAsk({ inputs: core, journalPath: join(d, 'j', 'a.json'), markerPath: join(d, 'm', 'x.installed') })
    const sent: AskRequest[] = []
    const events: [string, unknown][] = []
    svc.bridge = (_c, _p, req) => { sent.push(req) }
    svc.events = ((type: string, body: unknown) => { events.push([type, body]) }) as never
    const p = svc.ask(T, 'Rename a file', null, { kind: { tool: 'fs/rename', manifest: stampManifest([{ name: 'rename', send: false }], 'bridge', 'fs') }, agentId: 'a', available: ['touch'] })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    for (let i = 0; i < 5; i++) {
      await core.requests.ildra_ask_answer({ id: sent[0]!.id, digest8: sent[0]!.digest8, answerId: aid(), approved: true, holdMs: 300 }, { local: false, owner: false, connection: 'dev' })
      for (let k = 0; k < 20; k++) await Promise.resolve()
    }
    const out = await p
    expect(out).toMatchObject({ approved: false, channel: 'touch', reason: 'hold_limit' })
    expect(events.filter(([t]) => t === 'ildra.ask.attempt')).toHaveLength(5)
    expect(events.at(-1)).toEqual(['ildra.ask.outcome', out])
  })
})

describe('R5-5: recipient Unicode', () => {
  const kind = { manifest: [{ name: 'gmail.send', send: true }], tool: 'gmail.send' }
  const run = async (recipient: string, message = 'hi') => {
    let req: AskRequest | undefined; let prompt = ''
    const out: AskOutcome = await ask(T, 'Send an email', null, (_c, p, q) => { prompt = p; req = q!; return { id: q!.id, digest8: q!.digest8, answerId: aid(), approved: false } },
      { kind, ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'], send: { recipient, message } })
    return { out, req, prompt }
  }
  const HIDDEN = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F', '\u061C',
    '\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u2028', '\u2029', '\r', '\n', '\t', '\u0000', '\u001B', '\u007F', '\u0085']
  it('every bidi, zero-width, separator and control character in the recipient refuses the Ask before a prompt', async () => {
    for (const c of HIDDEN) {
      expect(hasHiddenChar(`a${c}b@x.com`), JSON.stringify(c)).toBe(true)
      const { out, req } = await run(`a${c}b@x.com`)
      expect(out, JSON.stringify(c)).toMatchObject({ approved: false, channel: null, reason: 'malformed' })
      expect(req).toBeUndefined()
    }
    expect(() => new AskLedger().open({ action: 'x', tier: 'ask', channel: 'touch', recipient: 'a\u202Eb', firstLine: 'hi' })).toThrow(ApprovalDenied)
  })
  it('the first line shows hidden characters as visible markers (display only)', () => {
    expect(markHidden('Pay\u202Eevil')).toBe('Pay⟦U+202E⟧evil')
    expect(firstLine('Hello\u2028Wire $9,000 now\nsecond')).toBe('Hello⟦U+2028⟧Wire $9,000 now')
    expect(firstLine('a\u200Bb\tc')).toBe('a⟦U+200B⟧b c')
    expect(Array.from(firstLine('\u200B'.repeat(100))).length).toBe(80)
  })
  it('mixed-script domains (and local parts) are flagged and marked; a single script is not', async () => {
    expect(recipientFlags('bob@p\u0430ypal.com')).toEqual(['mixed_script', 'non_ascii']) // Cyrillic а in a Latin label
    expect(recipientFlags('bob@\u043f\u0440\u0438\u043c\u0435\u0440.com')).toEqual(['mixed_script', 'non_ascii']) // Cyrillic label, Latin TLD
    expect(recipientFlags('\u0430lice@x.com')).toEqual(['mixed_script'])
    expect(recipientFlags('alice@example.com')).toEqual([])
    expect(recipientFlags('\u0438\u0432\u0430\u043d@\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444')).toEqual(['non_ascii'])
    expect(recipientFlags('+1 555 0100')).toEqual([])
    // v3.3: flagged recipients are phone only, so a touch-only Ask has no channel and opens nothing.
    expect((await run('bob@p\u0430ypal.com')).out).toMatchObject({ approved: false, channel: null, reason: 'no_channel' })
    const req = new AskLedger().open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'bob@p\u0430ypal.com', firstLine: 'hi' })
    expect(req.recipientFlags).toEqual(['mixed_script', 'non_ascii', 'new_recipient'])
    expect(req.recipient).toBe('bob@p\u0430ypal.com')
    expect(req.recipientAscii).toMatch(/^bob@xn--/)
    expect((toDeviceMessage(req, req.openedAt) as { body: string }).body).toBe('Use your phone')
    const plain = await run('bob@paypal.com')
    expect(plain.req!.recipientFlags).toEqual(['new_recipient'])
    expect(plain.prompt).toContain('to bob@paypal.com: "hi"')
  })
  it('the wire schema refuses a hidden character in recipient and accepts recipientFlags', async () => {
    const schema = JSON.parse(readFileSync(new URL('./ildra-messages.schema.json', import.meta.url), 'utf8'))
    const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module
    const ajv = new (Ajv2020 as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true })
    ajv.addSchema(schema)
    const v = ajv.getSchema(`${schema.$id}#/$defs/AskRequest`)!
    const req = new AskLedger().open({ action: 'Send an email', tier: 'ask', channel: 'phone', recipient: 'bob@p\u0430ypal.com', firstLine: 'hi' })
    expect(v(req), JSON.stringify(v.errors)).toBe(true)
    expect(v({ ...req, channel: 'touch' })).toBe(false) // v3.3: flagged recipients are phone only
    for (const c of HIDDEN) expect(v({ ...req, recipient: `a${c}b@x.com` }), JSON.stringify(c)).toBe(false)
    expect(v({ ...req, recipientFlags: ['other'] })).toBe(false)
    const { recipient: _r, firstLine: _f, ...noSend } = req!
    expect(v(noSend)).toBe(false) // recipientFlags needs recipient
  })
})
