/**
 * Writes protocol/examples/vectors/digest8.json and the digest8 values in protocol/examples/*.json from
 * approvals.ts actionDigest8 (the digest rule in protocol/README.md "Digest"). Run from cli/:
 *   npx tsx scripts/ildra/gen-protocol-vectors.ts
 * approvals.schema.spec.ts checks the written files against approvals.ts, so a rule change fails tests until rerun.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { InvalidUnicode, actionDigest8, canonicalJson } from '../../src/services/approvals.js'

const PROTOCOL = join(import.meta.dirname, '..', '..', '..', '..', 'protocol')
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
export const INVOICE_MESSAGE = 'Hi Dana, invoice attached.\nThe total is $120.00.'

const cases: { name: string; action: string; fields: Record<string, unknown> }[] = [
  { name: 'money, phone', action: 'Pay a bill', fields: { agentId: 'bills-1', tier: 'ask', amountMinor: 12000, currency: 'USD' } },
  { name: 'send with recipient and message hash', action: 'Send an invoice',
    fields: { agentId: 'bookkeeper-1', tier: 'ask', recipient: 'dana@example.com', messageSha256: sha(INVOICE_MESSAGE) } },
  { name: 'bare action, tier only', action: 'a', fields: { tier: 'ask' } },
  { name: 'locked_ask, same action as above', action: 'a', fields: { tier: 'locked_ask' } },
  { name: 'non-ASCII, null detail, nested detail, money', action: 'Caf\u00e9 \u2615',
    fields: { agentId: 'x', tier: 'locked_ask', amountMinor: 5, currency: 'USD', memo: null, list: [1, 'x', { z: 1, a: 2 }] } },
  { name: 'key order by UTF-16 code units, numbers in ES form', action: 'Rename a file',
    fields: { agentId: 'a', tier: 'ask', '\u{1F600}': 1, '\u00e9': 2, Z: 3, a: 4, n: [1e21, 0.1, -0, 1.5e-7, 100] } },
]
/** Refused: a lone UTF-16 surrogate anywhere in the digest input. No digest; the Ask outcome is reason malformed. */
const refused: { name: string; action: string; fields: Record<string, unknown> }[] = [
  { name: 'refused: lone high surrogate in a detail value', action: 'Send an invoice', fields: { agentId: 'bookkeeper-1', tier: 'ask', memo: 'x\uD800y' } },
  { name: 'refused: lone low surrogate in the action', action: 'Pay \uDC00', fields: { tier: 'ask' } },
  { name: 'refused: lone surrogate in a key', action: 'a', fields: { tier: 'ask', 'k\uDBFF': 1 } },
]

const vectors = [
  ...cases.map((c) => {
    const jcs = canonicalJson({ ...c.fields, action: c.action })
    return { name: c.name, action: c.action, fields: c.fields, jcs, sha256: sha(jcs), digest8: actionDigest8(c.action, c.fields) }
  }),
  ...refused.map((c) => {
    let threw = false
    try { actionDigest8(c.action, c.fields) } catch (e) { threw = e instanceof InvalidUnicode }
    if (!threw) throw new Error(`expected a refusal: ${c.name}`)
    return { name: c.name, action: c.action, fields: c.fields, jcs: null, sha256: null, digest8: null, refused: 'malformed' }
  }),
]
writeFileSync(join(PROTOCOL, 'examples', 'vectors', 'digest8.json'), `${JSON.stringify({
  rule: 'digest8 = first 8 lowercase hex of SHA-256(UTF-8(JCS({action, ...fields}))); fields absent are omitted; messageSha256 = hex SHA-256 of the full UTF-8 message. A lone UTF-16 surrogate anywhere in the input refuses the Ask (refused: malformed, digest8 null; AskOutcome reason malformed). See protocol/README.md "Digest".',
  invoiceMessage: INVOICE_MESSAGE,
  vectors,
}, null, 2)}\n`)

// Example envelopes: digest8 of the action each one shows.
const EX = join(PROTOCOL, 'examples')
const set = (file: string, digest8: string): void => {
  const p = join(EX, file)
  const m = JSON.parse(readFileSync(p, 'utf8')) as { body: Record<string, unknown> }
  m.body.digest8 = digest8
  writeFileSync(p, `${JSON.stringify(m)}\n`)
}
const money = vectors[0]!.digest8
const invoice = vectors[1]!.digest8
set('ask-request-money-phone.json', money)
set('ask-answer-phone.json', money)
set('ask-request-send-voice.json', invoice)
set('ask-answer-touch-hold.json', invoice)
set('ask-answer-touch-short.json', invoice)
console.log(vectors.map((v) => `${v.digest8 ?? 'refused '}  ${v.name}`).join('\n'))
