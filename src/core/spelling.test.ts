import { describe, expect, it } from 'vitest'
import { isSpellingCheckable, isSpellingCorrect, normaliseAnswer } from './spelling'
import type { Card } from './types'

function card(de: string, overrides: Partial<Card> = {}): Card {
  return { id: 'x', de, en: 'whatever', ...overrides }
}

describe('normaliseAnswer', () => {
  it('folds umlauts to their typed substitutes', () => {
    expect(normaliseAnswer('Gerücht')).toBe('geruecht')
    expect(normaliseAnswer('größer')).toBe('groesser')
  })

  it('collapses case, padding and stray punctuation', () => {
    expect(normaliseAnswer('  Die   Gasse. ')).toBe('die gasse')
  })
})

describe('isSpellingCorrect', () => {
  it('accepts the exact word', () => {
    expect(isSpellingCorrect('protzig', card('protzig'))).toBe(true)
  })

  it('ignores case', () => {
    expect(isSpellingCorrect('PROTZIG', card('protzig'))).toBe(true)
  })

  it('accepts umlauts typed either way', () => {
    expect(isSpellingCorrect('Gerücht', card('das Gerücht', { pos: 'noun' }))).toBe(true)
    expect(isSpellingCorrect('geruecht', card('das Gerücht', { pos: 'noun' }))).toBe(true)
  })

  it('lets a noun be answered without its article', () => {
    expect(isSpellingCorrect('Gasse', card('die Gasse', { pos: 'noun' }))).toBe(true)
    expect(isSpellingCorrect('die Gasse', card('die Gasse', { pos: 'noun' }))).toBe(true)
  })

  it('does not endorse the wrong article', () => {
    // Omitting the article is a fair answer; asserting the wrong gender is not.
    expect(isSpellingCorrect('der Gasse', card('die Gasse', { pos: 'noun' }))).toBe(false)
  })

  it('rejects a different word', () => {
    expect(isSpellingCorrect('Gassen', card('die Gasse', { pos: 'noun' }))).toBe(false)
    expect(isSpellingCorrect('protzig', card('prahlerisch'))).toBe(false)
  })

  it('never ticks an empty answer', () => {
    expect(isSpellingCorrect('', card('protzig'))).toBe(false)
    expect(isSpellingCorrect('   ', card('protzig'))).toBe(false)
  })

  it('never ticks a phrase, whose placeholders cannot be typed', () => {
    const phrase = card('jdn/etw im Auge behalten', { pos: 'phrase' })
    expect(isSpellingCheckable(phrase)).toBe(false)
    // Even a literally perfect transcription earns nothing — self-grading covers it.
    expect(isSpellingCorrect('jdn/etw im Auge behalten', phrase)).toBe(false)
  })
})
