import { describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  detectVersion,
  hasErrors,
  parseVocabFile,
} from './schema'

const minimal = { id: 'gehen', de: 'gehen', en: 'to go' }

describe('detectVersion', () => {
  it('treats an unversioned bare array as v0', () => {
    expect(detectVersion([minimal])).toBe(0)
  })

  it('treats an unversioned object as v0', () => {
    expect(detectVersion({ cards: [minimal] })).toBe(0)
  })

  it('reads an explicit version', () => {
    expect(detectVersion({ schemaVersion: 1, cards: [] })).toBe(1)
  })
})

describe('migration from v0', () => {
  it('upgrades a bare array of cards', () => {
    const { file, sourceVersion } = parseVocabFile([minimal])
    expect(sourceVersion).toBe(0)
    expect(file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(file.cards).toHaveLength(1)
    expect(file.cards[0]?.de).toBe('gehen')
  })

  it('renames the legacy bookEx field to ex1', () => {
    const { file } = parseVocabFile([
      { ...minimal, bookEx: 'Er ging durch die Stadt. [He walked through the city.]' },
    ])
    expect(file.cards[0]?.ex1).toBe('Er ging durch die Stadt. [He walked through the city.]')
    expect(file.cards[0]).not.toHaveProperty('bookEx')
  })

  it('does not let bookEx clobber an existing ex1', () => {
    const { file } = parseVocabFile([{ ...minimal, ex1: 'kept', bookEx: 'discarded' }])
    expect(file.cards[0]?.ex1).toBe('kept')
  })

  it('preserves decks and meta already present in a v0 object', () => {
    const { file } = parseVocabFile({
      cards: [minimal],
      decks: [{ id: 'all', name: 'Alles', filter: {} }],
      meta: { note: 'hello' },
    })
    expect(file.decks).toHaveLength(1)
    expect(file.meta.note).toBe('hello')
  })
})

describe('forward compatibility', () => {
  it('refuses a file from a newer schema rather than guessing', () => {
    const { file, problems } = parseVocabFile({
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      cards: [minimal],
    })
    expect(hasErrors(problems)).toBe(true)
    expect(file.cards).toHaveLength(0)
    expect(problems[0]?.message).toContain('understands up to')
  })
})

describe('required fields', () => {
  it.each([
    ['id', { de: 'gehen', en: 'to go' }],
    ['de', { id: 'gehen', en: 'to go' }],
    ['en', { id: 'gehen', de: 'gehen' }],
  ])('rejects a card missing %s', (field, card) => {
    const { file, problems } = parseVocabFile({ schemaVersion: 1, cards: [card] })
    expect(file.cards).toHaveLength(0)
    expect(problems.some((p) => p.level === 'error' && p.field === field)).toBe(true)
  })

  it('treats a blank string as missing', () => {
    const { file } = parseVocabFile({ schemaVersion: 1, cards: [{ ...minimal, en: '   ' }] })
    expect(file.cards).toHaveLength(0)
  })

  it('drops only the bad card and keeps the rest', () => {
    const { file, problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [minimal, { de: 'laufen', en: 'to run' }, { id: 'sehen', de: 'sehen', en: 'to see' }],
    })
    expect(file.cards.map((c) => c.id)).toEqual(['gehen', 'sehen'])
    expect(hasErrors(problems)).toBe(true)
  })

  it('names the German word when an id is missing, so the entry can be found', () => {
    const { problems } = parseVocabFile({ schemaVersion: 1, cards: [{ de: 'laufen', en: 'to run' }] })
    expect(problems[0]?.message).toContain('laufen')
  })
})

describe('duplicate ids', () => {
  it('keeps the first and rejects the second', () => {
    const { file, problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [minimal, { id: 'gehen', de: 'gehen (2)', en: 'duplicate' }],
    })
    expect(file.cards).toHaveLength(1)
    expect(file.cards[0]?.en).toBe('to go')
    expect(problems.some((p) => p.message.includes('Duplicate id'))).toBe(true)
  })
})

describe('tolerant coercion', () => {
  it('accepts a comma-joined string where a list was expected', () => {
    const { file } = parseVocabFile({
      schemaVersion: 1,
      cards: [{ ...minimal, syn: 'laufen, spazieren', tags: 'b2' }],
    })
    expect(file.cards[0]?.syn).toEqual(['laufen', 'spazieren'])
    expect(file.cards[0]?.tags).toEqual(['b2'])
  })

  it('trims whitespace from every string field', () => {
    const { file } = parseVocabFile({
      schemaVersion: 1,
      cards: [{ id: '  gehen  ', de: ' gehen ', en: ' to go ' }],
    })
    expect(file.cards[0]).toMatchObject({ id: 'gehen', de: 'gehen', en: 'to go' })
  })

  it('normalises part-of-speech spellings', () => {
    const { file } = parseVocabFile({
      schemaVersion: 1,
      cards: [
        { id: 'a', de: 'a', en: 'a', pos: 'Verb' },
        { id: 'b', de: 'b', en: 'b', pos: 'substantiv' },
        { id: 'c', de: 'c', en: 'c', pos: 'Redewendung' },
      ],
    })
    expect(file.cards.map((c) => c.pos)).toEqual(['verb', 'noun', 'phrase'])
  })

  it('falls back to "other" for an unfamiliar part of speech, with a warning', () => {
    const { file, problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [{ ...minimal, pos: 'gerundive' }],
    })
    expect(file.cards[0]?.pos).toBe('other')
    expect(hasErrors(problems)).toBe(false)
    expect(problems.some((p) => p.field === 'pos')).toBe(true)
  })

  it('accepts a numeric chapter', () => {
    const { file } = parseVocabFile({ schemaVersion: 1, cards: [{ ...minimal, chapter: 4 }] })
    expect(file.cards[0]?.chapter).toBe('4')
  })

  it('warns about a malformed added date but keeps the card', () => {
    const { file, problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [{ ...minimal, added: '12/08/2026' }],
    })
    expect(file.cards).toHaveLength(1)
    expect(file.cards[0]?.added).toBeUndefined()
    expect(problems.some((p) => p.field === 'added')).toBe(true)
  })

  it('warns about unknown fields without dropping the card', () => {
    const { file, problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [{ ...minimal, difficulty: 'hard' }],
    })
    expect(file.cards).toHaveLength(1)
    expect(hasErrors(problems)).toBe(false)
    expect(problems.some((p) => p.field === 'difficulty')).toBe(true)
  })

  it('warns when bookEx appears in a current-version file', () => {
    const { file, problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [{ ...minimal, bookEx: 'Ein Satz.' }],
    })
    expect(file.cards[0]?.ex1).toBe('Ein Satz.')
    expect(problems.some((p) => p.field === 'bookEx')).toBe(true)
    expect(hasErrors(problems)).toBe(false)
  })
})

describe('problem indices', () => {
  // Callers map an index back to the file and line that produced the entry, so it
  // must always refer to the source position, never to a position in the result.
  it('reports the source position even when earlier entries were dropped', () => {
    const { problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [
        { de: 'kein id', en: 'dropped' },
        minimal,
        { id: 'gehen', de: 'duplikat', en: 'duplicate' },
      ],
    })
    const duplicate = problems.find((p) => p.message.includes('Duplicate id'))
    expect(duplicate?.index).toBe(2)
  })

  it('reports the source position for prevIds problems too', () => {
    const { problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [
        { de: 'kein id', en: 'dropped' },
        minimal,
        { id: 'gehen-v2', de: 'gehen', en: 'to go', prevIds: ['gehen'] },
      ],
    })
    const prevIdProblem = problems.find((p) => p.field === 'prevIds')
    expect(prevIdProblem?.index).toBe(2)
  })
})

describe('prevIds', () => {
  it('accepts a rename that points at an id no longer in the file', () => {
    const { problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [{ ...minimal, id: 'gehen-v2', prevIds: ['gehen'] }],
    })
    expect(hasErrors(problems)).toBe(false)
  })

  it('rejects a previous id that is also a live card', () => {
    const { problems } = parseVocabFile({
      schemaVersion: 1,
      cards: [minimal, { id: 'gehen-v2', de: 'gehen', en: 'to go', prevIds: ['gehen'] }],
    })
    expect(problems.some((p) => p.field === 'prevIds' && p.level === 'error')).toBe(true)
  })
})

describe('decks', () => {
  it('normalises a filter and drops unusable entries', () => {
    const { file } = parseVocabFile({
      schemaVersion: 1,
      cards: [minimal],
      decks: [
        { id: 'krahen', name: 'Krähen', filter: { sources: 'Das Lied der Krähen', chapters: [1, 2] } },
        { name: 'no id' },
      ],
    })
    expect(file.decks).toHaveLength(1)
    expect(file.decks[0]?.filter.sources).toEqual(['Das Lied der Krähen'])
  })
})

describe('robustness', () => {
  it('never throws on hostile input', () => {
    for (const input of [null, undefined, 42, 'nope', [], {}, { cards: 'no' }, [null, 7]]) {
      expect(() => parseVocabFile(input)).not.toThrow()
    }
  })
})
