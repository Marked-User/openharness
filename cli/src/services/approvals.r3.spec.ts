/**
 * Shield round 3 conditions for M1 sign-off on 1845a5c90 (security/FINDINGS.md):
 * R3-1 the marker/journal folder check follows symlinks; R3-3 send:false only counts from first-party or
 * bridge-owned manifest entries; R3-2 (GA) the signed device hold hook, not wired for M1.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ApprovalDenied, AskLedger, isSendTool, openJournal, signedHoldPayload, signedHoldVerifier, stampManifest,
  type AskAnswer,
} from './approvals.js'

const dir = () => mkdtempSync(join(tmpdir(), 'r3-'))

describe('R3-1: the marker and journal folders are compared by realpath', () => {
  it('marker folder is a symlink to the journal folder', () => {
    const d = dir(); mkdirSync(join(d, 'j')); symlinkSync(join(d, 'j'), join(d, 'm'))
    expect(() => openJournal(join(d, 'j', 'j.json'), { markerPath: join(d, 'm', 'x.installed') })).toThrow(ApprovalDenied)
  })
  it('marker folder is a symlink to a folder below the journal folder, even when the rest does not exist yet', () => {
    const d = dir(); mkdirSync(join(d, 'j', 'deep'), { recursive: true }); symlinkSync(join(d, 'j', 'deep'), join(d, 'm'))
    expect(() => openJournal(join(d, 'j', 'j.json'), { markerPath: join(d, 'm', 'a', 'b', 'x.installed') })).toThrow(/journal/)
  })
  it('journal folder is a symlink into the marker folder (the other direction)', () => {
    const d = dir(); mkdirSync(join(d, 'm', 'inner'), { recursive: true }); symlinkSync(join(d, 'm', 'inner'), join(d, 'j'))
    expect(() => openJournal(join(d, 'j', 'j.json'), { markerPath: join(d, 'm', 'x.installed') })).toThrow(ApprovalDenied)
  })
  it('a plain journal folder inside the marker folder is refused too', () => {
    const d = dir(); mkdirSync(join(d, 'm', 'j'), { recursive: true })
    expect(() => openJournal(join(d, 'm', 'j', 'j.json'), { markerPath: join(d, 'm', 'x.installed') })).toThrow(ApprovalDenied)
  })
  it('a symlink to an unrelated sibling folder is fine', () => {
    const d = dir(); mkdirSync(join(d, 'j')); mkdirSync(join(d, 'real-m')); symlinkSync(join(d, 'real-m'), join(d, 'm'))
    expect(openJournal(join(d, 'j', 'j.json'), { markerPath: join(d, 'm', 'x.installed') }).recovered).toBe(false)
  })
  it('folders that share a name prefix are not nested', () => {
    const d = dir(); mkdirSync(join(d, 'state')); mkdirSync(join(d, 'state-markers'))
    expect(openJournal(join(d, 'state', 'j.json'), { markerPath: join(d, 'state-markers', 'x.installed') }).recovered).toBe(false)
  })
})

describe('R3-3: who may declare send:false', () => {
  it('only first_party or bridge entries opt out of the send checks', () => {
    expect(isSendTool([{ name: 't', send: false, owner: 'first_party' }], 't')).toBe(false)
    expect(isSendTool([{ name: 't', send: false, owner: 'bridge' }], 't')).toBe(false)
    for (const owner of [undefined, 'third_party', 'store:acme', '', 'Bridge', 1, null]) {
      expect(isSendTool([{ name: 't', send: false, owner }], 't'), String(owner)).toBe(true)
    }
  })
  it('stampManifest sets the owner from where the manifest came from, never from the manifest', () => {
    const claimed = [{ name: 'evil.mail', send: false, owner: 'bridge' }, { name: 'ok' }]
    const third = stampManifest(claimed, 'third_party')
    expect(third.map((e) => e.owner)).toEqual(['third_party', 'third_party'])
    expect(isSendTool(third, 'evil.mail')).toBe(true)
    expect(claimed[0]!.owner).toBe('bridge') // input untouched
    const own = stampManifest([{ name: 'fs.rename', send: false, owner: 'third_party' }], 'bridge')
    expect(isSendTool(own, 'fs.rename')).toBe(false)
    expect(stampManifest(null, 'bridge')).toEqual([])
  })
  it('an unknown source stamps nothing that can opt out', () => {
    expect(isSendTool(stampManifest([{ name: 't', send: false }], 'mystery' as never), 't')).toBe(true)
  })
})

describe('R3-2 (GA, D5 b): signed device hold hook', () => {
  it('canonical payload binds id, digest8, holdMs and counter', () => {
    expect(signedHoldPayload('id-1', '0011aabb', 1620, 7)).toBe('ildra-hold-v1|id-1|0011aabb|1620|7')
  })
  it('the verifier stub checks touch answers only, against the next counter, and fails closed', () => {
    const seen: string[] = []
    let counter = 6
    const v = signedHoldVerifier({ nextCounter: () => ++counter, verify: (payload, sig) => { seen.push(payload); return sig === 'good' } })
    const l = new AskLedger({ verifier: v })
    const t = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    const ans = (sig?: string): AskAnswer => ({ id: t.id, digest8: t.digest8, approved: true, holdMs: 1620, ...(sig ? { signature: sig } : {}) })
    expect(l.settle(ans('good'))).toEqual({ ok: true })
    expect(seen).toEqual([`ildra-hold-v1|${t.id}|${t.digest8}|1620|7`])
    const t2 = l.open({ action: 'Rename a file', tier: 'ask', channel: 'touch' })
    expect(l.settle({ id: t2.id, digest8: t2.digest8, approved: true, holdMs: 1620 })).toEqual({ ok: false, reason: 'verifier_rejected' })
    const p = l.open({ action: 'Rename a file', tier: 'ask', channel: 'phone' })
    expect(v(p, { id: p.id, digest8: p.digest8, approved: true })).toBe(true)
    const throwing = signedHoldVerifier({ nextCounter: () => 1, verify: () => { throw new Error('x') } })
    expect(throwing(t, ans('good'))).toBe(false)
  })
})
