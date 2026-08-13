import { describe, expect, it } from 'vitest'
import { applyDefaults, buildVocabDocument, cardIdsByFile, mergeBatches } from './batches'

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  de: id,
  en: `${id} (en)`,
  ...extra,
})

describe('applyDefaults', () => {
  it('fills fields the card does not set', () => {
    const result = applyDefaults(card('a'), {
      source: 'Das Lied der Krähen',
      chapter: '5',
      added: '2026-08-13',
    }) as Record<string, unknown>

    expect(result).toMatchObject({
      source: 'Das Lied der Krähen',
      chapter: '5',
      added: '2026-08-13',
    })
  })

  it('never overwrites a value written on the card', () => {
    const result = applyDefaults(card('a', { source: 'Eigene Quelle', chapter: '9' }), {
      source: 'Batch-Quelle',
      chapter: '5',
    }) as Record<string, unknown>

    expect(result.source).toBe('Eigene Quelle')
    expect(result.chapter).toBe('9')
  })

  it('unions tags rather than replacing them', () => {
    const result = applyDefaults(card('a', { tags: ['verb'] }), {
      tags: ['kapitel-5'],
    }) as Record<string, unknown>

    expect(result.tags).toEqual(['kapitel-5', 'verb'])
  })

  it('does not duplicate a tag present on both', () => {
    const result = applyDefaults(card('a', { tags: ['b2', 'verb'] }), {
      tags: ['b2'],
    }) as Record<string, unknown>

    expect(result.tags).toEqual(['b2', 'verb'])
  })

  it('leaves the card untouched when there are no defaults', () => {
    const original = card('a')
    expect(applyDefaults(original, {})).toEqual(original)
  })

  it('does not mutate its input', () => {
    const original = card('a')
    const snapshot = structuredClone(original)
    applyDefaults(original, { source: 'X', tags: ['y'] })
    expect(original).toEqual(snapshot)
  })

  it('passes non-objects through rather than throwing', () => {
    expect(applyDefaults(null, { source: 'X' })).toBeNull()
    expect(applyDefaults('nope', { source: 'X' })).toBe('nope')
  })
})

describe('mergeBatches', () => {
  it('concatenates batches in the order given', () => {
    const result = mergeBatches([
      { name: 'a.json', content: { cards: [card('one')] } },
      { name: 'b.json', content: { cards: [card('two'), card('three')] } },
    ])

    expect(result.cards.map((c) => (c as { id: string }).id)).toEqual(['one', 'two', 'three'])
    expect(result.problems).toEqual([])
  })

  it('applies each batch its own defaults', () => {
    const result = mergeBatches([
      { name: 'kap1.json', content: { defaults: { chapter: '1' }, cards: [card('a')] } },
      { name: 'kap2.json', content: { defaults: { chapter: '2' }, cards: [card('b')] } },
    ])

    expect(result.cards.map((c) => (c as { chapter: string }).chapter)).toEqual(['1', '2'])
  })

  it('accepts a bare array for a batch with nothing to declare', () => {
    const result = mergeBatches([{ name: 'plain.json', content: [card('a')] }])
    expect(result.cards).toHaveLength(1)
    expect(result.problems).toEqual([])
  })

  it('coerces a numeric chapter default', () => {
    const result = mergeBatches([
      { name: 'a.json', content: { defaults: { chapter: 5 }, cards: [card('a')] } },
    ])
    expect((result.cards[0] as { chapter: string }).chapter).toBe('5')
  })

  it('records which file each card came from', () => {
    const result = mergeBatches([
      { name: 'a.json', content: { cards: [card('one')] } },
      { name: 'b.json', content: { cards: [card('two')] } },
    ])
    expect(result.origins).toEqual(['a.json', 'b.json'])
  })

  it('reports a batch missing its cards array and skips it', () => {
    const result = mergeBatches([
      { name: 'broken.json', content: { defaults: { chapter: '1' } } },
      { name: 'good.json', content: { cards: [card('a')] } },
    ])

    expect(result.problems).toEqual([
      { file: 'broken.json', message: expect.stringContaining('no "cards" array') },
    ])
    expect(result.cards).toHaveLength(1)
  })

  it('reports a batch that is not an object or array', () => {
    const result = mergeBatches([{ name: 'weird.json', content: 42 }])
    expect(result.problems[0]?.file).toBe('weird.json')
    expect(result.cards).toEqual([])
  })

  it('flags an empty batch, which is almost always a mistake', () => {
    const result = mergeBatches([{ name: 'empty.json', content: { cards: [] } }])
    expect(result.problems[0]?.message).toContain('no cards')
  })

  it('handles no batches at all', () => {
    expect(mergeBatches([])).toEqual({ cards: [], origins: [], problems: [] })
  })

  it('does not validate cards, leaving that to the schema layer', () => {
    // A card with no id is nonsense, but rejecting it here would put the definition
    // of a valid card in two places.
    const result = mergeBatches([{ name: 'a.json', content: { cards: [{ de: 'nur Deutsch' }] } }])
    expect(result.cards).toHaveLength(1)
    expect(result.problems).toEqual([])
  })
})

describe('buildVocabDocument', () => {
  it('assembles cards, decks and meta into the app-facing shape', () => {
    const document = buildVocabDocument(
      [card('a')],
      { meta: { note: 'hallo' }, decks: [{ id: 'all', name: 'Alle', filter: {} }] },
      1,
    )

    expect(document.schemaVersion).toBe(1)
    expect(document.cards).toHaveLength(1)
    expect(document.decks).toHaveLength(1)
    expect((document.meta as { note: string }).note).toBe('hallo')
  })

  it('stamps a generation time, since the file is built not authored', () => {
    const document = buildVocabDocument([], {}, 1)
    const generated = (document.meta as { generated: string }).generated
    expect(Number.isNaN(Date.parse(generated))).toBe(false)
  })

  it('tolerates a missing or malformed decks document', () => {
    for (const input of [null, undefined, 'nope', []]) {
      const document = buildVocabDocument([card('a')], input, 1)
      expect(document.decks).toEqual([])
      expect(document.cards).toHaveLength(1)
    }
  })
})

describe('cardIdsByFile', () => {
  it('maps each card id back to its batch', () => {
    const map = cardIdsByFile([card('a'), card('b')], ['one.json', 'two.json'])
    expect(map.get('a')).toBe('one.json')
    expect(map.get('b')).toBe('two.json')
  })

  it('keeps the first file to claim an id, so duplicates can be reported', () => {
    const map = cardIdsByFile([card('a'), card('a')], ['first.json', 'second.json'])
    expect(map.get('a')).toBe('first.json')
  })
})
