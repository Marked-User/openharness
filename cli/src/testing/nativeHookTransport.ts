/** Exercise the shipped hook's transport without host processes or sockets. */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

export type HookReply = { status: number; body: string } | { error: true; connected: boolean } | { timeout: true; connected: boolean }

export function nativeHookTransport(platform: 'linux' | 'darwin', replies: HookReply[]) {
  const source = readFileSync(new URL('../../hook/notify.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('const DELIVERY_ID ='), end = source.indexOf('\nfunction secureStateDirectory(', start)
  if (start < 0 || end < 0) throw Error('Native hook transport source boundary is missing')
  const requests: unknown[] = []
  const post = runInNewContext(`${source.slice(start, end)}\npost`, {
    Buffer, process: { platform, uptime: () => 0.125 }, Date: { now: () => 1791676800125 },
    randomUUID: () => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    readHookCredential: () => '<hook-credential>', remainingBudget: () => 4000,
    http: { request: (options: unknown, receive: (response: EventEmitter) => void) => {
      const request = new EventEmitter() as EventEmitter & { write(text: string): void; end(): void; destroy(): void }
      let body = ''
      request.write = text => { body += text }
      request.destroy = () => {}
      request.end = () => queueMicrotask(() => {
        requests.push({ options, body })
        const reply = replies.shift()
        if (!reply) throw Error('Unexpected native hook request')
        request.emit('socket', 'status' in reply || reply.connected
          ? { connecting: false } : Object.assign(new EventEmitter(), { connecting: true }))
        if ('status' in reply) {
          const response = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding(): void }
          response.statusCode = reply.status; response.setEncoding = () => {}
          receive(response); response.emit('data', reply.body); response.emit('end')
        } else {
          request.emit('error' in reply ? 'error' : 'timeout', Error('fixture connection lost'))
        }
      })
      return request
    } },
  }) as (port: number, path: string, body: unknown, onResponse?: (reply: unknown) => void) => Promise<unknown>
  return { post, requests }
}
