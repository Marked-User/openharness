import { expect, it } from 'vitest'
import { parseNativeArchiveLink, parseNativeArchiveTransfer } from './nativeArchive.js'

const link = { version: 1, agentId: 'original-agent', requestId: 'original-resume-request', launchToken: 'original-launch-token', target: 'a'.repeat(64) }
const transfer = { version: 1, link, pendingTarget: 'b'.repeat(64), processKey: 'boot\0cursor\0process\0birth', pane: '%1' }

it('copies and freezes the original transfer identity without granting admission', () => {
  const input = structuredClone(transfer), parsed = parseNativeArchiveTransfer(input)!
  input.link.launchToken = 'another-launch-token'; input.processKey = 'another-process'
  expect(parsed).toEqual(transfer)
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.link)).toBe(true)
  expect(Object.keys(parsed.link).sort()).toEqual(['agentId', 'launchToken', 'requestId', 'target', 'version'])
})

it.each([null, [], 'link', {}, { ...link, extra: true }, { ...link, version: 2 }, { ...link, agentId: '' },
  { ...link, agentId: '../agent' }, { ...link, agentId: 1 }, { ...link, requestId: 'short' }, { ...link, requestId: null },
  { ...link, launchToken: 'short' }, { ...link, launchToken: null }, { ...link, target: 'bad' }, { ...link, target: null },
])('refuses malformed original links: %j', value => {
  expect(parseNativeArchiveLink(value)).toBeNull()
})

it.each([null, [], 'transfer', {}, { ...transfer, extra: true }, { ...transfer, version: 2 }, { ...transfer, link: null },
  { ...transfer, pendingTarget: null }, { ...transfer, pendingTarget: 'bad' }, { ...transfer, processKey: null },
  { ...transfer, processKey: '' }, { ...transfer, processKey: 'a'.repeat(513) }, { ...transfer, pane: null }, { ...transfer, pane: '1' },
])('refuses malformed transfer roles: %j', value => {
  expect(parseNativeArchiveTransfer(value)).toBeNull()
})
