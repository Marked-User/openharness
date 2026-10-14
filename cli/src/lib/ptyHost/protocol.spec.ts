import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  FrameKind,
  FrameReader,
  MAX_FRAME,
  PTY_PROTOCOL,
  type HelloLine,
  type PtyOp,
} from './protocol.js'

describe('ptyHost protocol framing', () => {
  it('decodes frames split across chunks', () => {
    const frame = encodeFrame(FrameKind.Output, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 104, 105]))
    const reader = new FrameReader()
    expect(reader.push(frame.subarray(0, 3))).toEqual([])
    const [out] = reader.push(frame.subarray(3))
    expect(out.kind).toBe(FrameKind.Output)
    expect(Buffer.from(out.payload.subarray(8)).toString()).toBe('hi')
  })

  it('decodes several frames from one chunk and keeps the remainder', () => {
    const a = encodeFrame(FrameKind.Pause, Buffer.alloc(0))
    const b = encodeFrame(FrameKind.Paste, Buffer.from('xyz'))
    const reader = new FrameReader()
    const got = reader.push(Buffer.concat([a, b.subarray(0, 4)]))
    expect(got.map(f => f.kind)).toEqual([FrameKind.Pause])
    const rest = reader.push(b.subarray(4))
    expect(rest).toHaveLength(1)
    expect(rest[0].payload.toString()).toBe('xyz')
  })

  it('matches the wire layout [kind][u32 BE len][payload]', () => {
    const f = encodeFrame(FrameKind.Resize, Buffer.from('ab'))
    expect([...f]).toEqual([4, 0, 0, 0, 2, 97, 98])
  })

  it('rejects frames over 8 MiB by throwing from push', () => {
    const head = Buffer.alloc(5)
    head.writeUInt8(FrameKind.Output, 0)
    head.writeUInt32BE(MAX_FRAME + 1, 1)
    expect(() => new FrameReader().push(head)).toThrow(/too large/)
    expect(() => encodeFrame(FrameKind.Output, Buffer.alloc(MAX_FRAME + 1))).toThrow(/too large/)
  })

  it('accepts a frame of exactly 8 MiB', () => {
    const f = encodeFrame(FrameKind.Output, Buffer.alloc(MAX_FRAME))
    const [out] = new FrameReader().push(f)
    expect(out.payload.length).toBe(MAX_FRAME)
  })

  it('rejects unknown frame kinds', () => {
    expect(() => new FrameReader().push(Buffer.from([99, 0, 0, 0, 0]))).toThrow(/unknown frame kind/)
  })
})

describe('ptyHost protocol messages', () => {
  it('exposes a positive protocol number for the hello line', () => {
    const hello: HelloLine = {
      hello: { token: 't', protocol: PTY_PROTOCOL, role: 'control', clientId: 'c' },
    }
    expect(JSON.parse(JSON.stringify(hello)).hello.protocol).toBe(PTY_PROTOCOL)
    expect(PTY_PROTOCOL).toBeGreaterThan(0)
  })

  it('serialises ops with wire (camelCase) field names', () => {
    const ops: PtyOp[] = [
      { op: 'holdOpen', pane: '%1', token: 'u' },
      { op: 'respawn', pane: '%1', command: ['sh'], expectedHeldToken: 'u' },
      { op: 'kill', pane: '%1', graceMs: 10 },
      { op: 'capture', pane: '%1', historyLines: 3, ansi: true, visible: false },
    ]
    const wire = ops.map(o => JSON.parse(JSON.stringify({ id: 1, ...o })))
    expect(wire[0]).toEqual({ id: 1, op: 'holdOpen', pane: '%1', token: 'u' })
    expect(wire[1].expectedHeldToken).toBe('u')
    expect(wire[2].graceMs).toBe(10)
    expect(wire[3].historyLines).toBe(3)
  })
})
