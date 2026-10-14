/**
 * An object off the wire: the contract's key names (`gridProtocol.ts`) — so a renamed field fails `tsc` where
 * it is read — with every value still unchecked. The generated types keep an index signature (a newer server
 * may add keys), which would erase the names from `keyof`, so the declared keys are picked out first.
 */
export type Unchecked<T> = { [K in keyof T as string extends K ? never : number extends K ? never : K]?: unknown }
