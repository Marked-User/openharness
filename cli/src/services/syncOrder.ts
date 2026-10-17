/**
 * Ildra sync ordering (Shield F11, DECISIONS 2026-10-15): last-writer-wins never reads the wall clock.
 * Each record carries a version vector `clock` ({deviceId: counter}), +1 for the writing device on every
 * accepted change. If one side dominates it wins; if concurrent, the larger counter total wins, then
 * the larger deviceId, then remote. `updated_at` is display only. Port of eng/reference/ildra_ref/sync.py.
 */

export type VersionVector = Readonly<Record<string, number>>

export interface Clocked {
  clock?: unknown
  device_id?: unknown
}

function vec(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (Number.isInteger(n) && (n as number) >= 0) out[k] = n as number
  return out
}

/** a has seen everything in b and more. */
export function dominates(a: VersionVector, b: VersionVector): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  let more = false
  for (const k of keys) {
    const x = a[k] ?? 0
    const y = b[k] ?? 0
    if (x < y) return false
    if (x > y) more = true
  }
  return more
}

export function mergeClocks(a: VersionVector, b: VersionVector): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) out[k] = Math.max(a[k] ?? 0, b[k] ?? 0)
  return out
}

/** Bump the writing device's counter. */
export function tick(clock: VersionVector, deviceId: string): Record<string, number> {
  return { ...clock, [deviceId]: (clock[deviceId] ?? 0) + 1 }
}

const sum = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0)

/** Who wins a last-writer field. Never uses updated_at. */
export function localWins(local: Clocked, remote: Clocked): boolean {
  const lc = vec(local.clock)
  const rc = vec(remote.clock)
  if (dominates(lc, rc)) return true
  if (dominates(rc, lc)) return false
  const lt = sum(lc)
  const rt = sum(rc)
  if (lt !== rt) return lt > rt
  return String(local.device_id ?? '') > String(remote.device_id ?? '')
}
