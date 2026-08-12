import { describe, expect, it } from 'vitest'
import { mergeProgress } from './merge'
import { DEFAULT_SETTINGS, createSm2Scheduler, itemKey } from './scheduler'
import type { Card, ItemMode, ReviewState } from './types'

const scheduler = createSm2Scheduler(DEFAULT_SETTINGS, () => 0.5)
const NOW = new Date('2026-08-12T10:00:00.000Z')
const MODES: ItemMode[] = ['de-en']

function card(id: string, overrides: Partial<Card> = {}): Card {
  return { id, de: id, en: `${id} (en)`, ...overrides }
}

/** A well-used review state, so any accidental reset is obvious in assertions. */
function progressed(cardId: string, mode: ItemMode = 'de-en'): ReviewState {
  return {
    key: itemKey(cardId, mode),
    cardId,
    mode,
    phase: 'review',
    ease: 2.15,
    intervalDays: 47,
    learningStep: -1,
    due: '2026-09-20T04:00:00.000Z',
    lastReviewed: '2026-08-04T09:12:00.000Z',
    reps: 12,
    lapses: 3,
  }
}

function storage(...states: ReviewState[]): Map<string, ReviewState> {
  return new Map(states.map((state) => [state.key, state]))
}

function merge(cards: Card[], stored: Map<string, ReviewState>, modes: ItemMode[] = MODES) {
  return mergeProgress({ cards, stored, modes, scheduler, now: NOW })
}

describe('first run', () => {
  it('creates fresh state for every card and queues it for writing', () => {
    const result = merge([card('gehen'), card('laufen')], storage())
    expect(result.items).toHaveLength(2)
    expect(result.toPersist).toHaveLength(2)
    expect(result.toDelete).toEqual([])
    expect(result.stats).toMatchObject({ cards: 2, itemsCreated: 2, itemsExisting: 0 })
    expect(result.items[0]?.state.phase).toBe('new')
  })

  it('handles an empty collection', () => {
    const result = merge([], storage())
    expect(result.items).toEqual([])
    expect(result.toPersist).toEqual([])
    expect(result.toDelete).toEqual([])
  })
})

describe('existing progress', () => {
  it('reuses stored scheduling state verbatim', () => {
    const existing = progressed('gehen')
    const result = merge([card('gehen')], storage(existing))
    expect(result.items[0]?.state).toEqual(existing)
    expect(result.stats.itemsExisting).toBe(1)
  })

  it('does not rewrite storage for cards that already have progress', () => {
    const result = merge([card('gehen')], storage(progressed('gehen')))
    expect(result.toPersist).toEqual([])
  })

  it('only writes the cards that are actually new', () => {
    const result = merge([card('gehen'), card('sehen')], storage(progressed('gehen')))
    expect(result.toPersist.map((s) => s.cardId)).toEqual(['sehen'])
  })
})

describe('content edits never touch progress', () => {
  it('keeps scheduling when every content field changes', () => {
    const existing = progressed('gehen')
    const edited = card('gehen', {
      de: 'gehen (überarbeitet)',
      en: 'to walk, to go',
      forms: 'ging, ist gegangen',
      ex1: 'a completely different sentence',
      ex2: 'another one',
      notiz: 'new note',
      syn: ['laufen'],
      source: 'Ein anderes Buch',
      chapter: '9',
      tags: ['neu'],
      pos: 'verb',
    })

    const result = merge([edited], storage(existing))

    expect(result.items[0]?.state).toEqual(existing)
    expect(result.items[0]?.card.en).toBe('to walk, to go')
    expect(result.toPersist).toEqual([])
    expect(result.toDelete).toEqual([])
  })

  it('serves the card content from the file, not from any cached copy', () => {
    const result = merge([card('gehen', { en: 'fresh translation' })], storage(progressed('gehen')))
    expect(result.items[0]?.card.en).toBe('fresh translation')
  })
})

describe('cards removed from the vocab file', () => {
  it('retains their progress as orphaned rather than deleting it', () => {
    const result = merge([card('gehen')], storage(progressed('gehen'), progressed('verschwunden')))
    expect(result.orphaned.map((s) => s.cardId)).toEqual(['verschwunden'])
    expect(result.toDelete).toEqual([])
    expect(result.stats.orphaned).toBe(1)
  })

  it('restores the original progress when the card comes back', () => {
    const stored = storage(progressed('gehen'))
    const removed = merge([], stored)
    expect(removed.orphaned).toHaveLength(1)

    const restored = merge([card('gehen')], stored)
    expect(restored.items[0]?.state).toEqual(progressed('gehen'))
    expect(restored.stats.itemsCreated).toBe(0)
  })
})

describe('suspended cards', () => {
  it('produces no review item but keeps the progress', () => {
    const result = merge([card('gehen', { suspended: true })], storage(progressed('gehen')))
    expect(result.items).toEqual([])
    expect(result.orphaned).toEqual([])
    expect(result.toDelete).toEqual([])
    expect(result.stats.suspended).toBe(1)
  })

  it('creates no new state for a suspended card that has never been seen', () => {
    const result = merge([card('neu', { suspended: true })], storage())
    expect(result.toPersist).toEqual([])
  })

  it('returns the item intact when unsuspended', () => {
    const stored = storage(progressed('gehen'))
    merge([card('gehen', { suspended: true })], stored)
    const result = merge([card('gehen')], stored)
    expect(result.items[0]?.state).toEqual(progressed('gehen'))
  })
})

describe('declared renames via prevIds', () => {
  it('carries scheduling across to the new id', () => {
    const result = merge([card('gehen-v2', { prevIds: ['gehen'] })], storage(progressed('gehen')))

    const state = result.items[0]?.state
    expect(state).toMatchObject({
      key: itemKey('gehen-v2', 'de-en'),
      cardId: 'gehen-v2',
      ease: 2.15,
      intervalDays: 47,
      reps: 12,
      lapses: 3,
      due: '2026-09-20T04:00:00.000Z',
    })
    expect(result.stats.itemsRenamed).toBe(1)
    expect(result.stats.itemsCreated).toBe(0)
  })

  it('removes the old key only after the history has been carried over', () => {
    const result = merge([card('gehen-v2', { prevIds: ['gehen'] })], storage(progressed('gehen')))
    expect(result.toDelete).toEqual([itemKey('gehen', 'de-en')])
    expect(result.toPersist.map((s) => s.key)).toEqual([itemKey('gehen-v2', 'de-en')])
  })

  it('follows a chain of renames listed oldest-last', () => {
    const result = merge(
      [card('gehen-v3', { prevIds: ['gehen-v2', 'gehen'] })],
      storage(progressed('gehen')),
    )
    expect(result.items[0]?.state.reps).toBe(12)
    expect(result.toDelete).toEqual([itemKey('gehen', 'de-en')])
  })

  it('treats the card as new when no previous id has any progress', () => {
    const result = merge([card('gehen-v2', { prevIds: ['nie-gesehen'] })], storage())
    expect(result.items[0]?.state.phase).toBe('new')
    expect(result.stats.itemsCreated).toBe(1)
    expect(result.toDelete).toEqual([])
  })

  it('prefers its own progress over an inherited one', () => {
    const own = progressed('gehen-v2')
    const result = merge(
      [card('gehen-v2', { prevIds: ['gehen'] })],
      storage(own, { ...progressed('gehen'), reps: 99 }),
    )
    expect(result.items[0]?.state.reps).toBe(12)
    expect(result.toDelete).toEqual([])
  })

  it('gives contested history to exactly one card and never deletes it twice', () => {
    // Invalid input that the validator rejects, but the merge must still not
    // corrupt storage if it somehow reaches the app.
    const result = merge(
      [card('a', { prevIds: ['alt'] }), card('b', { prevIds: ['alt'] })],
      storage(progressed('alt')),
    )
    expect(result.stats.itemsRenamed).toBe(1)
    expect(result.stats.itemsCreated).toBe(1)
    expect(result.toDelete).toEqual([itemKey('alt', 'de-en')])
  })

  it.each([
    ['suspended card first', true],
    ['renamed card first', false],
  ])('does not let a rename steal from a live suspended card (%s)', (_label, suspendedFirst) => {
    const suspendedCard = card('gehen', { suspended: true })
    const renamedCard = card('gehen-v2', { prevIds: ['gehen'] })
    const result = merge(
      suspendedFirst ? [suspendedCard, renamedCard] : [renamedCard, suspendedCard],
      storage(progressed('gehen')),
    )
    expect(result.toDelete).toEqual([])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.state.phase).toBe('new')
  })

  it.each([
    ['old card first', true],
    ['new card first', false],
  ])('does not inherit from an id that is still a live card (%s)', (_label, oldFirst) => {
    const oldCard = card('gehen')
    const claimant = card('gehen-v2', { prevIds: ['gehen'] })
    const result = merge(
      oldFirst ? [oldCard, claimant] : [claimant, oldCard],
      storage(progressed('gehen')),
    )
    expect(result.toDelete).toEqual([])
    expect(result.items.find((i) => i.card.id === 'gehen')?.state.reps).toBe(12)
    expect(result.items.find((i) => i.card.id === 'gehen-v2')?.state.phase).toBe('new')
  })
})

describe('study modes', () => {
  it('generates one item per card per active mode', () => {
    const result = merge([card('gehen')], storage(), ['de-en', 'en-de'])
    expect(result.items.map((i) => i.state.mode)).toEqual(['de-en', 'en-de'])
  })

  it('leaves progress for inactive modes untouched', () => {
    const german = progressed('gehen', 'de-en')
    const english = progressed('gehen', 'en-de')
    const result = merge([card('gehen')], storage(german, english), ['de-en'])

    expect(result.items).toHaveLength(1)
    expect(result.orphaned).toEqual([])
    expect(result.toDelete).toEqual([])
    expect(result.stats.inactiveMode).toBe(1)
  })

  it('restores inactive-mode progress intact when the mode is switched back on', () => {
    const english = progressed('gehen', 'en-de')
    const stored = storage(progressed('gehen', 'de-en'), english)
    merge([card('gehen')], stored, ['de-en'])
    const result = merge([card('gehen')], stored, ['de-en', 'en-de'])

    expect(result.items.find((i) => i.state.mode === 'en-de')?.state).toEqual(english)
    expect(result.stats.itemsCreated).toBe(0)
  })

  it('adds a new mode without disturbing the existing one', () => {
    const german = progressed('gehen', 'de-en')
    const result = merge([card('gehen')], storage(german), ['de-en', 'en-de'])

    expect(result.items.find((i) => i.state.mode === 'de-en')?.state).toEqual(german)
    expect(result.stats.itemsCreated).toBe(1)
    expect(result.toDelete).toEqual([])
  })
})

describe('purity', () => {
  it('mutates neither the storage map nor the states inside it', () => {
    const stored = storage(progressed('gehen'), progressed('weg'))
    const snapshot = structuredClone([...stored.entries()])

    merge([card('gehen', { en: 'edited' }), card('neu', { prevIds: ['weg'] })], stored)

    expect([...stored.entries()]).toEqual(snapshot)
  })

  it('does not alias the inherited state object', () => {
    const original = progressed('gehen')
    const result = merge([card('gehen-v2', { prevIds: ['gehen'] })], storage(original))
    expect(result.items[0]?.state).not.toBe(original)
  })
})

describe('the safety property', () => {
  // The invariant the whole module exists to guarantee: nothing short of an explicit
  // rename may ever remove stored progress.
  it('proposes no deletions across a wide mix of edits', () => {
    const stored = storage(
      progressed('a'),
      progressed('b'),
      progressed('c'),
      progressed('d', 'en-de'),
    )
    const result = merge(
      [
        card('a', { en: 'rewritten', tags: ['neu'] }),
        card('b', { suspended: true }),
        card('e'),
        // 'c' and 'd' simply vanish from the file.
      ],
      stored,
    )

    expect(result.toDelete).toEqual([])
    expect(result.orphaned.map((s) => s.cardId).sort()).toEqual(['c', 'd'])
  })
})
