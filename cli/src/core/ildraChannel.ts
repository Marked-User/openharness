/**
 * The channel layer's stamp on an Ildra answer (Shield R7 ledger via rule). core/ildraAsk.ts, and only it (a spec
 * checks the imports), stamps each answer object it builds from an authenticated connection with the channel
 * that connection may answer on. A production ledger (the Ask service's journal) settles only stamped answers and takes the
 * channel from the stamp, never from a field: a `via` written into an object by anyone else counts for nothing.
 * The stamp is a WeakMap entry on the object itself, so it cannot be copied, serialized or forged from data.
 */
export type StampedChannel = 'touch' | 'phone'
const STAMPS = new WeakMap<object, StampedChannel>()

/** core/ildraAsk.ts only. */
export function stampChannel<T extends object>(answer: T, via: StampedChannel): T {
  STAMPS.set(answer, via)
  return answer
}

/** The channel the core stamped on this exact object, or undefined. */
export function stampedChannel(answer: unknown): StampedChannel | undefined {
  return answer !== null && typeof answer === 'object' ? STAMPS.get(answer) : undefined
}
