/**
 * Send-Ask recipients (protocol v3.3, Shield and Design): UTS #39 skeletons from Unicode's confusables table
 * (unicode/confusables.ts, generated and pinned), the ASCII (punycode) form of the domain, and the
 * comparison forms the daemon keeps for known contacts and domains. No service imports; approvals.ts uses it.
 */
import { domainToASCII } from 'node:url'
import { CONFUSABLES_DATA } from './unicode/confusables.js'

let table: Map<number, string> | null = null
function confusables(): Map<number, string> {
  if (table) return table
  table = new Map()
  for (const row of CONFUSABLES_DATA.split(';')) {
    const [src, dst] = row.split(':')
    table.set(parseInt(src!, 16), String.fromCodePoint(...dst!.split('.').map((h) => parseInt(h, 16))))
  }
  return table
}

/** UTS #39 skeleton(X): NFD, map each code point through the confusables table, NFD again. */
export function skeleton(s: string): string {
  const t = confusables()
  let out = ''
  for (const ch of s.normalize('NFD')) out += t.get(ch.codePointAt(0)!) ?? ch
  return out.normalize('NFD')
}

/** A recipient split at its last '@' (no '@': all local part, no domain), NFC normalized. */
export function splitRecipient(recipient: string): { local: string; domain: string | null } {
  const r = recipient.normalize('NFC')
  const at = r.lastIndexOf('@')
  return at < 0 ? { local: r, domain: null } : { local: r.slice(0, at), domain: r.slice(at + 1) }
}

/** The form compared against known contacts: NFC, domain lowercased (domains are case-insensitive). */
export function recipientKey(recipient: string): string {
  const { local, domain } = splitRecipient(recipient)
  return domain === null ? local : `${local}@${domain.toLowerCase()}`
}

/** Skeleton of a contact: skeleton(local) '@' skeleton(lowercased domain). */
export function recipientSkeleton(recipient: string): string {
  const { local, domain } = splitRecipient(recipient)
  return domain === null ? skeleton(local) : `${skeleton(local)}@${skeleton(domain.toLowerCase())}`
}

/**
 * recipientAscii: the local part as is, '@', the domain in ASCII (IDNA / punycode, lowercased). null when the
 * domain cannot be converted (an invalid IDN): the Ask is refused as malformed.
 */
export function recipientAscii(recipient: string): string | null {
  const { local, domain } = splitRecipient(recipient)
  if (domain === null) return local
  const ascii = domainToASCII(domain)
  return ascii ? `${local}@${ascii}` : null
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\u0000-\u007F]/
/** True when the recipient's domain has any non-ASCII character. */
export function nonAsciiDomain(recipient: string): boolean {
  const { domain } = splitRecipient(recipient)
  return domain !== null && NON_ASCII.test(domain)
}

/** What the daemon knows: contacts it has sent to or was given, and known domains. */
export interface RecipientKnowledge {
  contacts?: Iterable<string>
  domains?: Iterable<string>
}

/**
 * lookalikeOf (v3.3): the known contact or domain a lookalike recipient matches, in ASCII form (domain punycode),
 * for display only ("It looks like dana@acme.com"); null when it is not a lookalike.
 * lookalike: the recipient's skeleton (local part and domain) equals a known contact's skeleton, or its
 * domain's skeleton equals a known domain's, while the text itself differs (after NFC and domain lowercasing).
 */
export function lookalikeOf(recipient: string, known: RecipientKnowledge): string | null {
  const key = recipientKey(recipient)
  const sk = recipientSkeleton(recipient)
  for (const c of known.contacts ?? []) {
    if (typeof c !== 'string') continue
    if (recipientKey(c) !== key && recipientSkeleton(c) === sk) return asciiForm(c)
  }
  const { domain } = splitRecipient(recipient)
  if (domain === null) return null
  const d = domain.toLowerCase()
  const dsk = skeleton(d)
  const domains = new Set<string>()
  for (const x of known.domains ?? []) if (typeof x === 'string') domains.add(x.normalize('NFC').toLowerCase())
  for (const c of known.contacts ?? []) {
    if (typeof c !== 'string') continue
    const cd = splitRecipient(c).domain
    if (cd !== null) domains.add(cd.normalize('NFC').toLowerCase())
  }
  for (const x of domains) if (x !== d && skeleton(x) === dsk) return domainToASCII(x) || x
  return null
}

/** The ASCII form of a known contact for display (lookalikeOf): domain in punycode, local part as is. */
function asciiForm(contact: string): string {
  return recipientAscii(contact) ?? recipientKey(contact)
}

export function isLookalike(recipient: string, known: RecipientKnowledge): boolean {
  return lookalikeOf(recipient, known) !== null
}

/** new_recipient: not a known contact (compared by recipientKey). */
export function isNewRecipient(recipient: string, known: RecipientKnowledge): boolean {
  const key = recipientKey(recipient)
  for (const c of known.contacts ?? []) if (typeof c === 'string' && recipientKey(c) === key) return false
  return true
}
