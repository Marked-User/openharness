import { describe, expect, it } from 'vitest'
import { handoffAgentId } from './terminalHandoff.js'

const tmux = (agentId: string, paneId: string) => ({ agentId, runtimes: [{ backend: 'tmux' as const, paneId }] })
const pty = (agentId: string, instance: string, paneId: string) => ({ agentId, runtimes: [{ backend: 'ptyhost' as const, instance, paneId }] })

describe('the tile `harness remote` was typed in', () => {
  it('is the tmux pane the shell named, ahead of a pty host pane with the same id', () => {
    expect(handoffAgentId([pty('pty', 'p1', '%3'), tmux('tmux', '%3')], '%3')).toBe('tmux')
  })

  it('is a pty host pane only when no tmux pane has the id and exactly one row does', () => {
    expect(handoffAgentId([pty('pty', 'p1', '%3'), tmux('tmux', '%4')], '%3')).toBe('pty')
    expect(handoffAgentId([pty('a', 'p1', '%3'), pty('b', 'p2', '%3')], '%3')).toBeNull()
    expect(handoffAgentId([tmux('tmux', '%4')], '%3')).toBeNull()
    expect(handoffAgentId([], '%3')).toBeNull()
  })

  it('never by the bare primary pane alone: a row without that runtime is not it', () => {
    expect(handoffAgentId([{ agentId: 'other', tmuxPane: '%3', runtimes: [] } as never], '%3')).toBeNull()
  })
})
