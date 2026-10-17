/**
 * Shield pilot privacy review (security/PILOT-PRIVACY-REVIEW.md, ildra 85eb9f3) items for the daemon:
 * (a) unknown tools are treated as able to send, (b) the install marker never sits in the journal's
 * folder, (c) on-device approval: digest8 on every touch answer, a 1.5 s hold, and locked_ask and money
 * Asks on the phone only (A1).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, ApprovalWindow, AskLedger, answerMcpElicitation, DEVICE_HOLD_MIN_MS, PhonePairing, ask, defaultMarkerPath, isSendTool, openJournal,
  type AskAnswer, type AskRequest, type ApprovalTemplate, type ToolManifestEntry,
} from './approvals.js'

const T: ApprovalTemplate = { permissions: { ask: ['Send an email', 'Pay a bill', 'Rename a file'], locked_ask: ['Brakes step'] } }
const MIC = { speaking: () => {} }
const dir = () => mkdtempSync(join(tmpdir(), 'pilot-'))
const notSend = (tool: string): ToolManifestEntry[] => [{ name: tool, send: false, owner: 'bridge' }]
function paired() {
  const p = new PhonePairing()
  const { code } = p.begin('touch'); p.offer('p1', 'pub1', code); p.confirm('p1', 'touch', true)
  return p
}
const yes = (extra: Partial<AskAnswer> = {}) => (_c: unknown, _p: unknown, req?: AskRequest): AskAnswer =>
  ({ id: req!.id, digest8: req!.digest8, approved: true, from: { phoneId: 'p1' }, ...extra })

describe('(a) unknown tools can send', () => {
  it('only an explicit send:false entry is not a send', () => {
    expect(isSendTool([{ name: 't', send: false, owner: 'bridge' }], 't')).toBe(false)
    expect(isSendTool([{ name: 't', send: true }], 't')).toBe(true)
    expect(isSendTool([], 't')).toBe(true) // missing from the list
    expect(isSendTool(null, 't')).toBe(true)
    expect(isSendTool(undefined, 't')).toBe(true)
    expect(isSendTool([{ name: 't' }], 't')).toBe(true) // no send field
    for (const v of [0, 'false', null, undefined, 'no']) expect(isSendTool([{ name: 't', send: v }], 't')).toBe(true)
  })
  it('a tool missing from the manifest needs the recipient and first line', async () => {
    const o = { ledger: new AskLedger(), window: new ApprovalWindow(), agentId: 'a', available: ['touch'] }
    await expect(ask(T, 'Rename a file', null, yes({ holdMs: 2000 }), { ...o, kind: { manifest: [], tool: 'mystery' } })).rejects.toThrow(ApprovalDenied)
    await expect(ask(T, 'Rename a file', null, yes({ holdMs: 2000 }), { ...o, kind: { manifest: [{ name: 'mystery' }], tool: 'mystery' } })).rejects.toThrow(/recipient/)
    const r = await ask(T, 'Rename a file', null, yes({ holdMs: 2000 }), { ...o, kind: { manifest: [], tool: 'mystery' }, send: { recipient: 'dana@example.com', message: 'Hi' } })
    expect(r.request).toMatchObject({ recipient: 'dana@example.com', firstLine: 'Hi' })
  })
  it('an unknown send tool also needs the approval window (F5)', async () => {
    await expect(ask(T, 'Rename a file', null, yes(), { ledger: new AskLedger(), kind: { manifest: [], tool: 'mystery' }, send: { recipient: 'r', message: 'm' } })).rejects.toThrow(/window/)
  })
  it('send:false declared in the manifest keeps the plain Ask', async () => {
    const r = await ask(T, 'Rename a file', null, yes({ holdMs: 1500 }), { ledger: new AskLedger(), kind: { manifest: notSend('mv'), tool: 'mv' }, available: ['touch'] })
    expect(r).toMatchObject({ approved: true, channel: 'touch' })
    expect(r.request?.recipient).toBeUndefined()
  })
})

describe('(a) MCP elicitations from unknown tools', () => {
  it('an elicitation whose tool is unlisted or missing declines (it would need send details)', async () => {
    const base = { ledger: new AskLedger(), pairing: paired(), manifest: [{ name: 'db.query', send: false, owner: 'bridge' }], available: ['phone'] }
    for (const tool of ['mystery', undefined]) {
      const r = await answerMcpElicitation(T, { server: 'db', message: 'Drop table?', ...(tool ? { tool } : {}) }, null, yes(), base)
      expect(r.action, String(tool)).toBe('decline')
    }
    expect((await answerMcpElicitation(T, { server: 'db', message: 'Drop table?', tool: 'db.query' }, null, yes(), base)).action).toBe('accept')
  })
})

describe('(b) install marker lives outside the journal folder', () => {
  it('the default marker is not in the journal folder, and is stable per journal path', () => {
    const f = join(dir(), 'j.json')
    const m = defaultMarkerPath(f)
    expect(dirname(m)).not.toBe(dirname(f))
    expect(m.startsWith(dirname(f) + '/')).toBe(false)
    expect(m.startsWith(join(homedir(), '.ildra'))).toBe(true)
    expect(defaultMarkerPath(f)).toBe(m)
    expect(defaultMarkerPath(join(dir(), 'j.json'))).not.toBe(m)
  })
  it('ILDRA_MARKER_DIR moves the default', () => {
    const d = dir(); const old = process.env.ILDRA_MARKER_DIR
    process.env.ILDRA_MARKER_DIR = d
    try { expect(dirname(defaultMarkerPath(join(dir(), 'j.json')))).toBe(d) } finally {
      if (old === undefined) delete process.env.ILDRA_MARKER_DIR; else process.env.ILDRA_MARKER_DIR = old
    }
  })
  it('deleting the whole journal folder still fails closed with the default marker', () => {
    const d = dir(); const f = join(d, 'state', 'j.json')
    const j1 = openJournal(f)
    expect(j1.recovered).toBe(false)
    expect(existsSync(defaultMarkerPath(f))).toBe(true)
    rmSync(join(d, 'state'), { recursive: true })
    expect(openJournal(f).recovered).toBe(true)
  })
  it('refuses a marker in the journal folder or below it', () => {
    const d = dir(); const f = join(d, 'j.json')
    expect(() => openJournal(f, { markerPath: join(d, 'j.json.installed') })).toThrow(ApprovalDenied)
    expect(() => openJournal(f, { markerPath: join(d, 'sub', 'm') })).toThrow(/journal/)
    expect(() => openJournal(f, { markerPath: join(d, '.', 'x', '..', 'm') })).toThrow(ApprovalDenied)
    expect(existsSync(f)).toBe(false) // refused before anything is written
  })
  it('a marker in a sibling folder is fine', () => {
    const d = dir(); mkdirSync(join(d, 'journal')); mkdirSync(join(d, 'markers'))
    const j = openJournal(join(d, 'journal', 'j.json'), { markerPath: join(d, 'markers', 'm') })
    expect(j.recovered).toBe(false)
    expect(existsSync(join(d, 'markers', 'm'))).toBe(true)
  })
})

describe('(c) on-device approval', () => {
  it('locked_ask and money Asks go to the phone only, never the device touch or voice', async () => {
    const pairing = paired()
    const base = { ledger: new AskLedger(), pairing, mic: MIC, kind: { manifest: notSend('t'), tool: 't' } }
    const l = await ask(T, 'Brakes step', null, yes(), { ...base, available: ['voice', 'touch', 'phone'] })
    expect(l).toMatchObject({ approved: true, channel: 'phone' })
    const m = await ask(T, 'Pay a bill', null, yes(), { ...base, window: new ApprovalWindow(), agentId: 'a', amountMinor: 100, available: ['voice', 'touch', 'phone'] })
    expect(m).toMatchObject({ approved: true, channel: 'phone' })
  })
  it('no paired phone: locked_ask and money fail closed instead of falling back to the device', async () => {
    const base = { ledger: new AskLedger(), mic: MIC, kind: { manifest: notSend('t'), tool: 't' }, available: ['voice', 'touch', 'phone'] }
    let asked = 0
    const fn = (...a: Parameters<ReturnType<typeof yes>>) => { asked++; return yes({ holdMs: 3000 })(...a) }
    expect(await ask(T, 'Brakes step', null, fn, base)).toEqual({ approved: false, channel: null, tier: 'locked_ask' })
    expect(await ask(T, 'Pay a bill', null, fn, { ...base, window: new ApprovalWindow(), agentId: 'a', amountMinor: 0 })).toMatchObject({ approved: false, channel: null })
    expect(asked).toBe(0)
  })
  it('the ledger refuses to open a locked_ask or money Ask on any channel but phone', () => {
    const l = new AskLedger()
    expect(() => l.open({ action: 'Brakes step', tier: 'locked_ask', channel: 'touch' })).toThrow(ApprovalDenied)
    expect(() => l.open({ action: 'Pay a bill', tier: 'ask', channel: 'touch', amountMinor: 1 })).toThrow(ApprovalDenied)
    expect(() => l.open({ action: 'Pay a bill', tier: 'ask', channel: 'voice', amountMinor: 1 })).toThrow(ApprovalDenied)
    expect(l.open({ action: 'Pay a bill', tier: 'ask', channel: 'phone', amountMinor: 1 }).channel).toBe('phone')
    expect(l.pending()).toBe(1)
  })
  it('a device approval needs a hold of at least 1.5 s', async () => {
    expect(DEVICE_HOLD_MIN_MS).toBe(1500)
    const o = { kind: { manifest: notSend('t'), tool: 't' }, available: ['touch'] }
    for (const [holdMs, ok] of [[undefined, false], [0, false], [600, false], [1499, false], [1500, true], [4000, true]] as const) {
      const r = await ask(T, 'Rename a file', null, yes(holdMs === undefined ? {} : { holdMs }), { ...o, ledger: new AskLedger() })
      expect(r.approved, String(holdMs)).toBe(ok)
      if (!ok) expect(r.reason).toBe('hold_too_short')
    }
  })
  it('a non-number, NaN or negative hold is not a hold', () => {
    for (const holdMs of ['2000', Number.NaN, -5, Infinity] as unknown[]) {
      const l = new AskLedger(); const req = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
      expect(l.settle({ id: req.id, digest8: req.digest8, approved: true, holdMs } as AskAnswer), String(holdMs)).toEqual({ ok: false, reason: 'hold_too_short' })
    }
  })
  it('a device deny needs no hold (swipe)', () => {
    const l = new AskLedger(); const req = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    expect(l.settle({ id: req.id, digest8: req.digest8, approved: false })).toEqual({ ok: true })
  })
  it('the hold rule applies to the device only: phone answers need no holdMs', async () => {
    const r = await ask(T, 'Rename a file', null, yes(), { ledger: new AskLedger(), pairing: paired(), kind: { manifest: notSend('t'), tool: 't' }, available: ['phone'] })
    expect(r).toMatchObject({ approved: true, channel: 'phone' })
  })
  it('a device answer must carry the digest8 of what it showed', () => {
    const l = new AskLedger()
    for (const digest8 of [undefined, '', 'deadbeef']) {
      const req = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
      const r = l.settle({ id: req.id, digest8, approved: true, holdMs: 2000 } as AskAnswer)
      expect(r.ok, String(digest8)).toBe(false)
      expect(['malformed', 'digest_mismatch']).toContain((r as { reason: string }).reason)
    }
    const req = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    expect(l.settle({ id: req.id, digest8: req.digest8, approved: true, holdMs: 2000 })).toEqual({ ok: true })
  })
  it('a journal from before the rule: a pending money or locked_ask Ask on touch or voice is denied on restore', () => {
    const l = new AskLedger()
    const mk = (id: string, channel: string, extra: object) => ({ id, digest8: '0011aabb', openedAt: 0, expiresAt: Date.now() + 60_000, channel, tier: 'ask', action: 'a', ...extra }) as AskRequest
    l.restore({ open: [
      mk('m-touch', 'touch', { amountMinor: 5, currency: 'USD' }), mk('l-touch', 'touch', { tier: 'locked_ask' }), mk('m-voice', 'voice', { amountMinor: 5, currency: 'USD', challenge: 'maple river' }),
      mk('m-phone', 'phone', { amountMinor: 5, currency: 'USD' }), mk('plain', 'touch', {}),
    ], spent: [] })
    expect(l.pending()).toBe(2)
    expect(l.settle({ id: 'm-touch', digest8: '0011aabb', approved: true, holdMs: 5000 })).toEqual({ ok: false, reason: 'replayed' })
    expect(l.settle({ id: 'l-touch', digest8: '0011aabb', approved: true, holdMs: 5000 })).toEqual({ ok: false, reason: 'replayed' })
    expect(l.settle({ id: 'plain', digest8: '0011aabb', approved: true, holdMs: 5000 })).toEqual({ ok: true })
  })
  it('reference mode (parity with eng/reference) keeps its old channel order', async () => {
    const r = await ask(T, 'Brakes step', null, () => true, { reference: true, available: ['touch'] })
    expect(r).toEqual({ approved: true, channel: 'touch', tier: 'locked_ask' })
  })
})
