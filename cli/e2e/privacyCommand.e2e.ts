import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { CLI_ROOT, IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
const exec = promisify(execFile)
it('the terminal command reads and changes the account preference without starting a daemon', async () => {
 const backend = await FakeBackend.start()
 backend.productUsage = {enabled:true,revision:0,reports:[]}
 const d = await IsolatedDaemon.create({env:{BACKEND_WS_URL:backend.wsUrl,WEB_URL:backend.httpUrl}})
 try {
  backend.addMachine({machineId:'c3'.repeat(16),computerId:d.computerId,name:'fixture',token:'fixture-privacy-token'})
  writeFileSync(join(d.root,'auth','session.json'),JSON.stringify({version:1,accessToken:'fixture-privacy-token',autonomousEnv:'prod',computerId:d.computerId,machineId:'c3'.repeat(16),expiresAt:Date.now()+86400000,updatedAt:Date.now(),signInEpoch:'fixture'}),{mode:0o600})
  for (const [action, enabled] of [['status',true],['off',false],['on',true]] as const) {
   const result=await exec(process.execPath,['--import','tsx',join(CLI_ROOT,'src/cli.ts'),'privacy',action,'--json'],{cwd:CLI_ROOT,env:d.env,timeout:30000})
   expect(JSON.parse(result.stdout)).toMatchObject({enabled})
   expect(result.stdout+result.stderr).not.toContain('fixture-privacy-token')
  }
  expect(d.child).toBeNull()
 } finally { await d.close(); await backend.close() }
},100000)
