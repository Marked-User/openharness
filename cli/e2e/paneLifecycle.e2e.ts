/**
 * A pane whose engine was stopped by hand stays the person's (#600). Ctrl-C to stop Codex, after it has
 * worked, left the pane a shell that said so ("This pane is a shell now — run codex again, or stop the
 * pane"), and 10–15 s later the window closed it: the daemon told it the agent had ended and named no
 * shell to move to. Now the window is told to move there, the shell is still there long after, Ctrl-D in
 * it ends it the usual way, and a close of the harness that ended is answered at once.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>
const engines: Engine[] = ['claude', 'codex']
const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const deleted = (client: LocalClient, agentId: string, what: string) =>
  client.next((frame) => frame.type === 'agent_deleted' && frame.payload?.agentId === agentId, 45_000, what)

let daemon: IsolatedDaemon | null = null
afterEach(async () => { await daemon?.stop(); daemon = null })

describe('a pane whose engine was stopped by hand (#600)', () => {
  it.each(engines)('%s: the pane stays a shell after the engine exits, and Ctrl-D in it ends it cleanly', async (engine) => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, `stopped-by-hand-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 120_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the conversation to bind', async () => {
      const found = await row(client, created.agent.id)
      return found?.sessionId && found.status === 'active' ? found : null
    }, 60_000, 500)
    const ended = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === agent.id, 45_000, 'turn_ended')
    client.send('message', { agentId: agent.id, content: 'some real work first' })
    await ended
    const pane = String(agent.tmuxPane)

    // Typed into the pane, as a person quits the engine.
    const gone = deleted(client, agent.id, 'agent_deleted (the engine)')
    await d.tmux.run('send-keys', '-t', pane, '-l', '!exit')
    await d.tmux.run('send-keys', '-t', pane, 'Enter')
    const successor = (await gone).payload?.successor as string | undefined
    expect(successor, 'the window is told which shell keeps the pane').toBeTruthy()
    const shell = await until('the shell row', async () => (await row(client, successor!)) ?? null, 30_000, 500)
    expect(shell.engine).toBe('terminal')
    expect(shell.tmuxPane).toBe(pane)
    expect(await d.capture(pane)).toContain('This pane is a shell now')

    // Well past the 10–15 s after which the pane used to go.
    await new Promise((resolve) => setTimeout(resolve, 20_000))
    expect((await row(client, successor!))?.status).toBe('active')
    expect((await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_dead}')).trim()).toBe('0')
    // The harness that ended is closed already: a close of it is answered at once, never left unconfirmed.
    const closed = await client.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode: 'now' }, 15_000)
    expect(closed).toMatchObject({ closed: true })

    // Ctrl-D ends the shell, and with it the pane and its row.
    const shellGone = deleted(client, successor!, 'agent_deleted (the shell)')
    await d.tmux.run('send-keys', '-t', pane, 'C-d')
    await shellGone
    await until('the shell to stop counting as active', async () => (await row(client, successor!))?.status !== 'active' || null, 30_000, 500)
    await until('the pane to go', async () => !(await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}').catch(() => '')).split('\n').includes(pane) || null, 15_000, 250)
    client.close()
  }, 240_000)
})
