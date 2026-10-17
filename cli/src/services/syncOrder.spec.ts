import { describe, expect, it } from 'vitest'
import { dominates, localWins, mergeClocks, tick } from './syncOrder.js'

describe('F11 sync ordering by clock counter', () => {
  it('dominates', () => {
    expect(dominates({ a: 2 }, { a: 1 })).toBe(true)
    expect(dominates({ a: 1 }, { a: 1 })).toBe(false)
    expect(dominates({ a: 1, b: 1 }, { a: 1 })).toBe(true)
    expect(dominates({ a: 2 }, { b: 1 })).toBe(false)
    expect(dominates({}, {})).toBe(false)
  })
  it('a future wall clock does not win', () => {
    const local = { clock: { a: 1 }, updated_at: '2099-01-01', device_id: 'a' }
    const remote = { clock: { a: 1, b: 1 }, updated_at: '2020-01-01', device_id: 'b' }
    expect(localWins(local, remote)).toBe(false)
    expect(localWins(remote, local)).toBe(true)
  })
  it('concurrent: counter total, then device id, then remote', () => {
    expect(localWins({ clock: { a: 3 } }, { clock: { b: 2 } })).toBe(true)
    expect(localWins({ clock: { a: 1 } }, { clock: { b: 2 } })).toBe(false)
    expect(localWins({ clock: { a: 1 }, device_id: 'z' }, { clock: { b: 1 }, device_id: 'y' })).toBe(true)
    expect(localWins({ clock: { a: 1 }, device_id: 'y' }, { clock: { b: 1 }, device_id: 'z' })).toBe(false)
    expect(localWins({ clock: { a: 1 }, device_id: 'x' }, { clock: { b: 1 }, device_id: 'x' })).toBe(false)
    expect(localWins({}, {})).toBe(false)
  })
  it('ignores malformed clocks', () => {
    expect(localWins({ clock: [1, 2] }, { clock: { a: 1 } })).toBe(false)
    expect(localWins({ clock: { a: -5, b: 1.5, c: 'x' } }, { clock: { a: 1 } })).toBe(false)
    expect(localWins({ clock: null }, { clock: 'x' })).toBe(false)
  })
  it('merged clock is element-wise max, tick bumps one device', () => {
    expect(mergeClocks({ a: 2, b: 1 }, { b: 3, c: 1 })).toEqual({ a: 2, b: 3, c: 1 })
    expect(tick({ a: 1 }, 'a')).toEqual({ a: 2 })
    expect(tick({ a: 1 }, 'b')).toEqual({ a: 1, b: 1 })
  })
})
