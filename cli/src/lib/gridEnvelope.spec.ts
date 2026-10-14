/**
 * `grid --json`'s refusal envelope, read off a stderr it shares with everything else `grid` writes. Each
 * envelope below is built as the contract's `CliErrorEnvelope` (`gridProtocol.ts`, grid-protocol `cli-error`),
 * so an envelope the contract reshapes fails `tsc` here as well as where it is read.
 */
import { describe, expect, it } from 'vitest'
import { gridEnvelopes } from './gridEnvelope.js'
import { GRID_ASLEEP_CODE, type CliErrorEnvelope } from './gridProtocol.js'

const line = (error: CliErrorEnvelope['error']): string => JSON.stringify({ error } satisfies CliErrorEnvelope)

describe('gridEnvelopes', () => {
  it('reads the code a program compares and the sentence a person is shown, among the lines beside them', () => {
    const asleep = line({ code: GRID_ASLEEP_CODE, message: 'Grid team is asleep: this grid is resting', status: 503 })
    const stderr = `${asleep}\nGrid team is asleep: this grid is resting\n`

    expect(gridEnvelopes(stderr)).toEqual([{ code: GRID_ASLEEP_CODE, message: 'Grid team is asleep: this grid is resting' }])
  })

  it('keeps every envelope, in the order written', () => {
    const first = line({ code: null, message: 'first', status: null })
    const second = line({ code: 'second_code', message: 'second', status: 400 })

    expect(gridEnvelopes(`warning: something\n${first}\n${second}\n`)).toEqual([
      { code: null, message: 'first' },
      { code: 'second_code', message: 'second' },
    ])
  })

  it('reads a code that is not a string, and a sentence with nothing displayable left, as none', () => {
    const odd = JSON.stringify({ error: { code: 7, message: ' \n\t ', status: 400 } })
    const bare = JSON.stringify({ error: {} })

    expect(gridEnvelopes(`${odd}\n${bare}\n`)).toEqual([{ code: null, message: null }, { code: null, message: null }])
  })

  it('leaves the code exactly as sent, and makes the sentence safe for a screen and bounded', () => {
    const noisy = `one\u001b[2Jtwo‮three${'x'.repeat(700)}`
    const [read] = gridEnvelopes(line({ code: ' grid_asleep ', message: noisy, status: 503 }))

    expect(read?.code).toBe(' grid_asleep ')
    expect(read?.message?.startsWith('one [2Jtwo three')).toBe(true)
    expect(Array.from(read?.message ?? '')).toHaveLength(600)
    expect(read?.message?.endsWith('…')).toBe(true)
  })

  it('skips what is not an envelope: plain text, broken JSON, an array, an error that is not an object', () => {
    const stderr = [
      'grid: error: unrecognized arguments: --no-wake',
      '{"error": {"code": "grid_asleep"',
      '[{"error": {"code": "grid_asleep"}}]',
      JSON.stringify({ error: 'grid_asleep' }),
      JSON.stringify({ detail: 'asleep', code: GRID_ASLEEP_CODE }),
    ].join('\n')

    expect(gridEnvelopes(stderr)).toEqual([])
  })
})
