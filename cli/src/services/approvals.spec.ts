import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, ApprovalWindow, DEFAULT_ASK_CHANNEL, KNOWN_CHANNELS, TIER_RANK, VOICE_MONEY_LIMIT_MINOR,
  applyOverride, ask as askProd, askChannelFor, classifyTool, resolve, resolveTool, voiceAllowed,
  type ApprovalProfile, type ApprovalTemplate, type AskChannel, type Tier,
} from './approvals.js'

type Golden = {
  templates: Record<string, ApprovalTemplate>
  cases: { t: string; a: string; w: boolean; p: ApprovalProfile | null; tier: Tier }[]
  asks: { t: string; a: string; w: boolean; p: ApprovalProfile | null; c: string[] | null; m: number | null; approved?: boolean; channel?: string | null; raises?: boolean }[]
}
const ask: typeof askProd = (t, a, p, f, o = {}) => askProd(t, a, p, f, { reference: true, ...o })
const golden = JSON.parse(readFileSync(new URL('./approvals.golden.json', import.meta.url), 'utf8')) as Golden

const BK: ApprovalTemplate = { permissions: { auto: ['Read the ledger'], ask: ['Send an invoice'], never: ['Move money out'] } }
const STEPS = ['Brakes step', 'Airbag step', 'Fuel step', 'High voltage step', 'Steering step', 'Jack step']
const RG: ApprovalTemplate = { permissions: { auto: ['Look up a part'], locked_ask: STEPS } }
const STRICT = { approval_strictness: 'strict' }
const STANDARD = { approval_strictness: 'standard' }
const yes = () => true

function recorder(answer: unknown = true) {
  const calls: [AskChannel, string][] = []
  return { calls, fn: (c: AskChannel, p: string) => { calls.push([c, p]); return answer } }
}

describe('golden parity with the Ildra reference', () => {
  it('has real templates and cases', () => {
    expect(Object.keys(golden.templates).length).toBe(16)
    expect(golden.cases.length).toBeGreaterThan(1000)
  })
  it('resolve matches every case', () => {
    const bad = golden.cases.filter((k) => resolve(golden.templates[k.t]!, k.a, k.p ?? undefined, k.w) !== k.tier)
    expect(bad).toEqual([])
  })
  it('ask matches every case', async () => {
    const bad: unknown[] = []
    for (const k of golden.asks) {
      const run = ask(golden.templates[k.t]!, k.a, k.p, yes, { available: k.c ?? undefined, isWrite: k.w, amountMinor: k.m ?? undefined })
      if (k.raises) {
        await run.then(() => bad.push(k), (e) => { if (!(e instanceof ApprovalDenied)) bad.push(k) })
      } else {
        const r = await run
        if (r.approved !== k.approved || r.channel !== k.channel) bad.push({ k, r })
      }
    }
    expect(bad).toEqual([])
  })
})

describe('constants', () => {
  it('tiers, channels and limit', () => {
    expect(Object.keys(TIER_RANK).sort()).toEqual(['ask', 'auto', 'locked_ask', 'never'])
    expect(DEFAULT_ASK_CHANNEL).toEqual(['voice', 'touch', 'phone'])
    expect([...KNOWN_CHANNELS]).toEqual(['voice', 'touch', 'phone'])
    expect(VOICE_MONEY_LIMIT_MINOR).toBe(5000)
  })
})

describe('resolve', () => {
  it('precedence never > locked_ask > ask > auto', () => {
    const t = { permissions: { auto: ['x', 'y', 'z', 'w'], ask: ['x', 'y', 'z'], locked_ask: ['x', 'y'], never: ['x'] } }
    expect([resolve(t, 'x'), resolve(t, 'y'), resolve(t, 'z'), resolve(t, 'w')]).toEqual(['never', 'locked_ask', 'ask', 'auto'])
  })
  it('exact string match only', () => {
    expect(resolve(BK, 'read the ledger')).toBe('ask')
    expect(resolve(BK, 'Read the ledger ')).toBe('ask')
    expect(resolve(BK, 'Move money ou')).toBe('ask')
  })
  it('unlisted write is ask, unlisted read is auto', () => {
    expect(resolve(BK, 'Nobody listed')).toBe('ask')
    expect(resolve(BK, 'Nobody listed', undefined, true)).toBe('ask')
    expect(resolve(BK, 'Nobody listed', undefined, false)).toBe('auto')
  })
  it('missing or null permissions and non-string items', () => {
    expect(resolve({}, 'a', null, false)).toBe('auto')
    expect(resolve({ permissions: null }, 'a')).toBe('ask')
    expect(resolve({ permissions: { never: [{ a: 1 }, null], ask: null } }, 'a', null, false)).toBe('auto')
  })
  it('listed item ignores isWrite', () => {
    expect(resolve(BK, 'Move money out', undefined, false)).toBe('never')
    expect(resolve(BK, 'Send an invoice', undefined, false)).toBe('ask')
  })
  it('strict turns auto and unlisted read into ask, never loosens', () => {
    expect(resolve(BK, 'Read the ledger', STRICT)).toBe('ask')
    expect(resolve(BK, 'Peek', STRICT, false)).toBe('ask')
    expect(resolve(BK, 'Move money out', STRICT)).toBe('never')
    for (const s of STEPS) expect(resolve(RG, s, STRICT)).toBe('locked_ask')
  })
  it('standard and empty profiles equal none', () => {
    for (const a of ['Read the ledger', 'Send an invoice', 'Move money out']) {
      expect(resolve(BK, a, STANDARD)).toBe(resolve(BK, a))
      expect(resolve(BK, a, {})).toBe(resolve(BK, a))
    }
  })
  it('no profile value loosens anything', () => {
    const profiles: ApprovalProfile[] = [
      { approval_strictness: 'loose' }, { approval_strictness: 'auto' }, { approval_strictness: null },
      { approval_strictness: 'STANDARD' }, { auto_approve: true, approval_strictness: 'standard' },
      { ask_channel: ['voice'], spend_limit: { amount_minor: 1e9, currency: 'USD' } }, { approvals: { everything: 'auto' } },
    ]
    for (const p of profiles) {
      expect(resolve(BK, 'Send an invoice', p)).toBe('ask')
      expect(resolve(BK, 'Move money out', p)).toBe('never')
      for (const s of STEPS) expect(resolve(RG, s, p)).toBe('locked_ask')
      expect(resolve(BK, 'unlisted write', p)).toBe('ask')
    }
  })
  it('locked_ask never auto under any profile', () => {
    for (const p of [null, {}, STRICT, STANDARD, { approval_strictness: 'loose' }, { ask_channel: [] }]) {
      for (const s of STEPS) expect(resolve(RG, s, p)).toBe('locked_ask')
    }
  })
})

describe('applyOverride', () => {
  it('cannot loosen locked_ask', () => {
    for (const s of STEPS) for (const r of ['auto', 'ask'] as Tier[]) expect(() => applyOverride(RG, s, r)).toThrow(ApprovalDenied)
  })
  it('cannot change a never item', () => {
    for (const r of ['auto', 'ask', 'locked_ask'] as Tier[]) expect(() => applyOverride(BK, 'Move money out', r, STANDARD)).toThrow(ApprovalDenied)
    expect(applyOverride(BK, 'Move money out', 'never')).toBe('never')
  })
  it('cannot loosen ask to auto, nor unlisted write', () => {
    expect(() => applyOverride(BK, 'Send an invoice', 'auto')).toThrow(/cannot loosen/)
    expect(() => applyOverride(BK, 'Unlisted write', 'auto')).toThrow(ApprovalDenied)
  })
  it('tightening allowed', () => {
    expect(applyOverride(BK, 'Read the ledger', 'ask', STANDARD)).toBe('ask')
    expect(applyOverride(BK, 'Read the ledger', 'never')).toBe('never')
    expect(applyOverride(BK, 'Send an invoice', 'locked_ask')).toBe('locked_ask')
    expect(applyOverride(RG, 'Brakes step', 'never')).toBe('never')
  })
  it('keeps the stricter of request and profile', () => {
    expect(applyOverride(BK, 'Read the ledger', 'auto', STRICT)).toBe('ask')
    expect(applyOverride(BK, 'Read the ledger', 'auto')).toBe('auto')
  })
})

describe('ask', () => {
  it('default order picks voice for ask tier', async () => {
    const r = recorder()
    expect(await ask(BK, 'Send an invoice', null, r.fn)).toEqual({ approved: true, channel: 'voice', tier: 'ask' })
    expect(r.calls).toEqual([['voice', 'ASK: Send an invoice']])
  })
  it('profile order respected, empty list uses default', async () => {
    expect((await ask(BK, 'Send an invoice', { ask_channel: ['phone', 'voice'] }, yes)).channel).toBe('phone')
    expect((await ask(BK, 'Send an invoice', { ask_channel: [] }, yes)).channel).toBe('voice')
  })
  it('falls back when first channel unavailable', async () => {
    expect((await ask(BK, 'Send an invoice', null, yes, { available: ['touch', 'phone'] })).channel).toBe('touch')
    expect((await ask(BK, 'Send an invoice', null, yes, { available: ['phone'] })).channel).toBe('phone')
    expect((await ask(BK, 'Send an invoice', { ask_channel: ['voice', 'phone'] }, yes, { available: ['touch', 'phone'] })).channel).toBe('phone')
  })
  it('denied, truthy-but-not-true and async answers', async () => {
    expect(await ask(BK, 'Send an invoice', null, () => false)).toEqual({ approved: false, channel: 'voice', tier: 'ask' })
    for (const a of ['yes', 1, 'true', {}]) expect((await ask(BK, 'Send an invoice', null, () => a)).approved).toBe(false)
    expect((await ask(BK, 'Send an invoice', null, async () => true)).approved).toBe(true)
  })
  it('locked_ask prompts via touch and reports tier', async () => {
    const r = recorder()
    expect(await ask(RG, 'Brakes step', STRICT, r.fn)).toEqual({ approved: true, channel: 'touch', tier: 'locked_ask' })
    expect(r.calls).toEqual([['touch', 'LOCKED_ASK: Brakes step']])
    expect((await ask(RG, 'Brakes step', null, yes, { available: ['phone'] })).channel).toBe('phone')
  })
  it('unlisted write asks', async () => {
    const r = recorder()
    expect((await ask(BK, 'Unlisted write', null, r.fn)).tier).toBe('ask')
    expect(r.calls.length).toBe(1)
  })
  it('never rejects without prompting', async () => {
    const r = recorder()
    await expect(ask(BK, 'Move money out', null, r.fn)).rejects.toThrow(ApprovalDenied)
    expect(r.calls).toEqual([])
  })
  it('auto approves without prompt; strict makes it prompt', async () => {
    const r = recorder()
    expect(await ask(BK, 'Read the ledger', null, r.fn)).toEqual({ approved: true, channel: null, tier: 'auto' })
    expect(r.calls).toEqual([])
    expect(await ask(BK, 'Read the ledger', STRICT, r.fn)).toEqual({ approved: true, channel: 'voice', tier: 'ask' })
  })
})

describe('Shield F1: voice refused for locked_ask and money over $50', () => {
  it('voiceAllowed', () => {
    expect(voiceAllowed('locked_ask')).toBe(false)
    expect(voiceAllowed('ask')).toBe(true)
    expect(voiceAllowed('ask', 5000)).toBe(true)
    expect(voiceAllowed('ask', 5001)).toBe(false)
    expect(voiceAllowed('ask', null)).toBe(true)
  })
  it('locked_ask skips voice', async () => {
    const r = recorder()
    expect((await ask(RG, 'Brakes step', null, r.fn)).channel).toBe('touch')
    expect(r.calls.map((c) => c[0])).not.toContain('voice')
  })
  it('locked_ask voice-only fails closed without prompting', async () => {
    const r = recorder()
    expect(await ask(RG, 'Brakes step', null, r.fn, { available: ['voice'] })).toEqual({ approved: false, channel: null, tier: 'locked_ask' })
    expect(await ask(RG, 'Brakes step', { ask_channel: ['voice'] }, r.fn)).toEqual({ approved: false, channel: null, tier: 'locked_ask' })
    expect(r.calls).toEqual([])
  })
  it('money at the limit allows voice, over it skips voice', async () => {
    expect((await ask(BK, 'Send an invoice', null, yes, { amountMinor: 5000 })).channel).toBe('voice')
    expect((await ask(BK, 'Send an invoice', { ask_channel: ['voice', 'phone'] }, yes, { amountMinor: 5001 })).channel).toBe('phone')
  })
  it('voice-only money over the limit fails closed', async () => {
    const r = recorder()
    expect((await ask(BK, 'Send an invoice', null, r.fn, { available: ['voice'], amountMinor: 5001 })).approved).toBe(false)
    expect(r.calls).toEqual([])
  })
})

describe('Shield F3: only voice, touch, phone', () => {
  it('unknown channels ignored', async () => {
    expect((await ask(BK, 'Send an invoice', { ask_channel: ['desktop', 'agent', 'phone'] }, yes)).channel).toBe('phone')
    expect(askChannelFor('ask', { ask_channel: [7, null, 'touch'] })).toBe('touch')
  })
  it('profile of only unknown channels fails closed', async () => {
    const r = recorder()
    expect(await ask(BK, 'Send an invoice', { ask_channel: ['desktop'] }, r.fn)).toEqual({ approved: false, channel: null, tier: 'ask' })
    expect(r.calls).toEqual([])
  })
})

describe('Shield F4: read vs write from the bridge tool list', () => {
  const manifest = [
    { name: 'ledger.read', readOnly: true, send: false, owner: 'bridge' },
    { name: 'mcp.search', annotations: { readOnlyHint: true } },
    { name: 'invoice.send' },
    { name: 'sneaky', readOnly: 'true' },
    { name: 'sneaky2', annotations: { readOnlyHint: 1 } },
    { name: 'nulls', annotations: null },
  ]
  it('classifyTool', () => {
    expect(classifyTool(manifest, 'ledger.read')).toBe('read')
    expect(classifyTool(manifest, 'mcp.search')).toBe('read')
    for (const t of ['invoice.send', 'sneaky', 'sneaky2', 'nulls', 'unknown']) expect(classifyTool(manifest, t)).toBe('write')
    expect(classifyTool(null, 'ledger.read')).toBe('write')
    expect(classifyTool(undefined, 'ledger.read')).toBe('write')
  })
  it('resolveTool', () => {
    expect(resolveTool(BK, 'ledger.read', manifest)).toBe('auto')
    expect(resolveTool(BK, 'unknown', manifest)).toBe('ask')
    expect(resolveTool(BK, 'ledger.read', manifest, STRICT)).toBe('ask')
  })
  it('ask with kind: unknown tool asks, read-only tool is auto', async () => {
    // Unknown tools can send (pilot review a): send details are required, the tier is still Ask.
    expect((await ask(BK, 'unknown', null, yes, { kind: { manifest, tool: 'unknown' }, send: { recipient: 'r', message: 'm' } })).tier).toBe('ask')
    expect((await ask(BK, 'ledger.read', null, yes, { kind: { manifest, tool: 'ledger.read' } })).tier).toBe('auto')
  })
  it('caller isWrite:false cannot downgrade a manifest write; caller may tighten a read', async () => {
    expect((await ask(BK, 'invoice.send', null, yes, { isWrite: false, kind: { manifest, tool: 'invoice.send' }, send: { recipient: 'r', message: 'm' } })).tier).toBe('ask')
    expect((await ask(BK, 'ledger.read', null, yes, { isWrite: true, kind: { manifest, tool: 'ledger.read' } })).tier).toBe('ask')
  })
})

describe('Shield F5: running totals per agent per window', () => {
  function clock() {
    let t = 1_000_000
    return { now: () => t, advance: (ms: number) => { t += ms } }
  }
  it('defaults', () => {
    const w = new ApprovalWindow()
    expect([w.windowMs, w.voiceMoneyLimitMinor, w.bulkCount]).toEqual([86_400_000, 5000, 20])
    w.record('a')
    expect(w.totals('a')).toEqual({ count: 1, amountMinor: 0 })
  })
  it('totals and rolling expiry', () => {
    const c = clock()
    const w = new ApprovalWindow({ windowMs: 1000, now: c.now })
    w.record('a', { amountMinor: 100 })
    c.advance(600)
    w.record('a', { amountMinor: 200, count: 2 })
    expect(w.totals('a')).toEqual({ count: 3, amountMinor: 300 })
    c.advance(500)
    expect(w.totals('a')).toEqual({ count: 2, amountMinor: 200 })
    c.advance(1000)
    expect(w.totals('a')).toEqual({ count: 0, amountMinor: 0 })
  })
  it('two $45 approvals turn voice off', async () => {
    const w = new ApprovalWindow()
    const r = recorder()
    const opts = { window: w, agentId: 'bills', amountMinor: 4500, available: ['voice', 'phone'] }
    expect((await ask(BK, 'Send an invoice', null, r.fn, opts)).channel).toBe('voice')
    expect((await ask(BK, 'Send an invoice', null, r.fn, opts)).channel).toBe('phone')
    expect(r.calls[1]![1]).toBe('ASK: Send an invoice (running total today: 2 actions, $90.00)')
    expect(w.totals('bills')).toEqual({ count: 2, amountMinor: 9000 })
  })
  it('21st send turns voice off', async () => {
    const w = new ApprovalWindow()
    for (let i = 0; i < 20; i++) expect((await ask(BK, 'Send an invoice', null, yes, { window: w, agentId: 'a' })).channel).toBe('voice')
    expect((await ask(BK, 'Send an invoice', null, yes, { window: w, agentId: 'a' })).channel).toBe('touch')
    expect(w.wouldExceed('a', { count: 1 })).toEqual({ voiceAllowed: false, total: { count: 22, amountMinor: 0 } })
  })
  it('agents are independent and denials are not recorded', async () => {
    const w = new ApprovalWindow()
    w.record('a', { amountMinor: 5000 })
    expect(w.wouldExceed('a', { amountMinor: 1 }).voiceAllowed).toBe(false)
    expect(w.wouldExceed('b', { amountMinor: 1 }).voiceAllowed).toBe(true)
    await ask(BK, 'Send an invoice', null, () => false, { window: w, agentId: 'b', amountMinor: 100 })
    expect(w.totals('b')).toEqual({ count: 0, amountMinor: 0 })
  })
  it('window without agentId fails closed; bad amounts throw', async () => {
    const r = recorder()
    await expect(ask(BK, 'Send an invoice', null, r.fn, { window: new ApprovalWindow() })).rejects.toThrow(ApprovalDenied)
    expect(r.calls).toEqual([])
    const w = new ApprovalWindow()
    expect(() => w.record('a', { amountMinor: -1 })).toThrow(RangeError)
    expect(() => w.record('a', { amountMinor: 1.5 })).toThrow(RangeError)
    expect(() => w.wouldExceed('a', { count: 0 })).toThrow(RangeError)
  })
  it('auto actions bypass the window', async () => {
    const w = new ApprovalWindow()
    await ask(BK, 'Read the ledger', null, yes, { window: w, agentId: 'a' })
    expect(w.totals('a').count).toBe(0)
  })
})

describe('F6 and F2 hooks', () => {
  it('unpaired phone is not usable', async () => {
    const r = recorder()
    expect(await ask(RG, 'Brakes step', null, r.fn, { available: ['phone'], isPaired: () => false })).toEqual({ approved: false, channel: null, tier: 'locked_ask' })
    expect((await ask(RG, 'Brakes step', null, yes, { available: ['phone'], isPaired: () => true })).channel).toBe('phone')
    expect(r.calls).toEqual([])
  })
  it('a verifier without a ledger fails closed', async () => {
    await expect(ask(BK, 'Send an invoice', null, yes, { verifier: () => true })).rejects.toThrow(ApprovalDenied)
  })
})
