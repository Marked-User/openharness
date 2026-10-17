/**
 * Shield R5-3: the Ildra Ask pane guard covers every key path into a tmux pane, not only the terminal stream.
 * Phone chat (sessionInput), device input and askQuestion all reach a pane through TmuxBackend typeLiteral,
 * submitText or sendKey, so the guard is enforced there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => [] as string[])
vi.mock('./tmux.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tmux.js')>()
  return {
    ...actual,
    sendLiteralToTmux: async (pane: string, text: string) => { sent.push(`literal ${pane} ${text}`); return true },
    sendToTmux: async (pane: string, text: string) => { sent.push(`submit ${pane} ${text}`); return true },
    sendKeyToTmux: async (pane: string, key: string) => { sent.push(`key ${pane} ${key}`); return true },
  }
})
import { TmuxBackend } from './tmuxBackend.js'
import { AskPaneGuard } from '../services/approvals.js'

const pane = { backend: 'tmux' as const, paneId: '%7' }
const press = async (b: TmuxBackend) => [
  await b.typeLiteral(pane, '1'), await b.submitText(pane, '1'), await b.sendKey(pane, 'enter'),
]

beforeEach(() => { sent.length = 0 })

describe('TmuxBackend refuses input to a pane showing an Ildra Ask (R5-3)', () => {
  it('phone chat "1", a device key or an askQuestion press never reaches a guarded pane', async () => {
    const guard = new AskPaneGuard()
    const b = new TmuxBackend(undefined, () => 'test', () => {}, async () => ({}) as never)
    b.inputGuard = (p) => guard.filterInput(p === '%7' ? 'agent-1' : p, 'remote') === 'block'
    guard.open('agent-1', 'ask-1')
    for (const r of await press(b)) expect(r).toMatchObject({ state: 'failed', dispatch: 'rejected', reason: expect.stringContaining('ILDRA_ASK_PANE') })
    expect(sent).toEqual([])
    guard.close('agent-1')
    for (const r of await press(b)) expect(r.state).toBe('succeeded')
    expect(sent).toEqual(['literal %7 1', 'submit %7 1', 'key %7 Enter'])
  })
  it('a guard that throws counts as an open Ask; no guard wired means no Ask runtime (unchanged)', async () => {
    const b = new TmuxBackend(undefined, () => 'test', () => {}, async () => ({}) as never)
    b.inputGuard = () => { throw new Error('boom') }
    for (const r of await press(b)) expect(r).toMatchObject({ state: 'failed', dispatch: 'rejected' })
    expect(sent).toEqual([])
    b.inputGuard = null
    for (const r of await press(b)) expect(r.state).toBe('succeeded')
  })
  it('other panes are not affected', async () => {
    const b = new TmuxBackend(undefined, () => 'test', () => {}, async () => ({}) as never)
    b.inputGuard = (p) => p === '%9'
    for (const r of await press(b)) expect(r.state).toBe('succeeded')
  })
})
