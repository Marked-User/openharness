import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeHookIntake } from '../../src/engines/kit/nativeHookJournal.js'
import { readHookCredential } from '../../src/lib/hookAuth.js'
import { until, type IsolatedDaemon } from './daemon.js'

/** Discovery binding can precede the initial hook's durable admission. Before
 * a storage fault, confirm that exact admission without sending a warm-up turn.
 * The ordinary duplicate response may finish the original pending admission;
 * record presence by itself is never proof that its effect completed. */
export async function confirmInitialNativeHook(daemon: IsolatedDaemon, agent: { id: string; engine: string; sessionId: string }): Promise<void> {
  const intake = await until(`${agent.engine} initial hook intake`, () => {
    const matches: NativeHookIntake[] = []
    for (const entry of readdirSync(daemon.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.native-hook-effects-\d{3}\.history$/.test(entry.name)) continue
      const directory = join(daemon.dataDir, entry.name)
      for (const name of readdirSync(directory).filter(name => /^\d{8}\.json$/.test(name)).sort()) {
        const record = JSON.parse(readFileSync(join(directory, name), 'utf8'))
        const body = record.event?.intake as NativeHookIntake | undefined
        if (record.event?.kind === 'intake' && body?.agentId === agent.id && body.conversationId === agent.sessionId
          && body.payload.engine === agent.engine && body.payload.hookEvent === 'SessionStart') matches.push(body)
      }
    }
    if (matches.length > 1) throw Error('Initial native hook intake is ambiguous')
    return matches[0]
  }, 60_000, 200)
  const token = readHookCredential(daemon.dataDir)
  if (!token) throw Error('Private daemon hook credential is unavailable')
  await until(`${agent.engine} initial hook admission`, async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/api/hook/session-start`, {
      method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { 'content-type': 'application/json', 'x-harness-hook-token': token,
        'x-harness-hook-delivery-id': intake.id,
        ...(intake.firedAt === undefined ? {} : { 'x-harness-hook-fired-at': String(intake.firedAt) }) },
      body: JSON.stringify(intake.payload),
    })
    const reply = await response.json() as { ok?: boolean; pending?: boolean }
    return response.status === 200 && reply.ok === true && !reply.pending
  }, 60_000, 200)
}
