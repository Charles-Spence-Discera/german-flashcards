import { describe, expect, it } from 'vitest'
import { buildQueue, dailyCounts, matchesFilter, queueCounts } from './queue'
import { DEFAULT_APP_SETTINGS } from './settings'
import { itemKey } from './scheduler'
import type { AppSettings } from './settings'
import type { Card, Deck, Phase, ReviewItem, ReviewLogEntry, ReviewState } from './types'

const NOW = new Date('2026-08-12T10:00:00.000Z')
const MINUTE = 60_000
const DAY = 86_400_000

function card(id: string, overrides: Partial<Card> = {}): Card {
  return { id, de: id, en: `${id} (en)`, ...overrides }
}

function item(id: string, phase: Phase, dueOffsetMs: number, cardOverrides: Partial<Card> = {}): ReviewItem {
  const state: ReviewState = {
    key: itemKey(id, 'de-en'),
    cardId: id,
    mode: 'de-en',
    phase,
    ease: 2.5,
    intervalDays: phase === 'new' ? 0 : 10,
    learningStep: phase === 'learning' || phase === 'relearning' ? 0 : -1,
    due: new Date(NOW.getTime() + dueOffsetMs).toISOString(),
    lastReviewed: phase === 'new' ? null : '2026-08-01T10:00:00.000Z',
    reps: phase === 'new' ? 0 : 5,
    lapses: 0,
  }
  return { card: card(id, cardOverrides), state }
}

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_APP_SETTINGS,
  ...overrides,
})

const nothingDone = { introduced: 0, reviewed: 0 }

/** rng returning 0 makes Fisher–Yates a no-op, so review order stays deterministic. */
const noShuffle = () => 0

function queue(items: ReviewItem[], overrides: Partial<Parameters<typeof buildQueue>[0]> = {}) {
  return buildQueue({
    items,
    settings: settings(),
    doneToday: nothingDone,
    now: NOW,
    rng: noShuffle,
    ...overrides,
  })
}

describe('matchesFilter', () => {
  const subject = card('gehen', {
    source: 'Das Lied der Krähen',
    chapter: '4',
    tags: ['verb', 'b2'],
  })

  it('matches everything on an empty filter', () => {
    expect(matchesFilter(subject, {})).toBe(true)
  })

  it.each([
    ['source', { sources: ['Das Lied der Krähen'] }, true],
    ['other source', { sources: ['Ein anderes Buch'] }, false],
    ['chapter', { chapters: ['4'] }, true],
    ['other chapter', { chapters: ['9'] }, false],
    ['one of several tags', { tags: ['b2', 'nonexistent'] }, true],
    ['no matching tag', { tags: ['c1'] }, false],
    ['explicit id', { ids: ['gehen'] }, true],
    ['other id', { ids: ['laufen'] }, false],
  ])('matches by %s', (_label, filter, expected) => {
    expect(matchesFilter(subject, filter)).toBe(expected)
  })

  it('requires every field to match', () => {
    expect(matchesFilter(subject, { sources: ['Das Lied der Krähen'], chapters: ['9'] })).toBe(false)
    expect(matchesFilter(subject, { sources: ['Das Lied der Krähen'], chapters: ['4'] })).toBe(true)
  })

  it('excludes cards missing the field a filter names', () => {
    expect(matchesFilter(card('bare'), { sources: ['Irgendwas'] })).toBe(false)
    expect(matchesFilter(card('bare'), { tags: ['b2'] })).toBe(false)
  })
})

describe('dailyCounts', () => {
  function entry(phaseBefore: Phase, at: string): ReviewLogEntry {
    return { key: 'a::de-en', at, grade: 'good', phaseBefore, prevIntervalDays: 1, nextIntervalDays: 3 }
  }

  it('separates new cards from reviews and ignores learning steps', () => {
    const counts = dailyCounts(
      [
        entry('new', '2026-08-12T09:00:00.000Z'),
        entry('new', '2026-08-12T09:05:00.000Z'),
        entry('review', '2026-08-12T09:10:00.000Z'),
        entry('learning', '2026-08-12T09:15:00.000Z'),
        entry('relearning', '2026-08-12T09:20:00.000Z'),
      ],
      NOW,
      4,
    )
    expect(counts).toEqual({ introduced: 2, reviewed: 1 })
  })

  it('ignores work from previous days', () => {
    const counts = dailyCounts(
      [entry('new', '2026-08-11T09:00:00.000Z'), entry('new', '2026-08-12T09:00:00.000Z')],
      NOW,
      4,
    )
    expect(counts.introduced).toBe(1)
  })

  it('counts a 02:00 review against the previous study day', () => {
    const lateNight = new Date('2026-08-13T02:00:00.000Z')
    const counts = dailyCounts([entry('new', '2026-08-12T23:00:00.000Z')], lateNight, 4)
    expect(counts.introduced).toBe(1)
  })
})

describe('buildQueue ordering', () => {
  it('puts due learning steps first, most overdue first', () => {
    const result = queue([
      item('review-card', 'review', -DAY),
      item('recent-step', 'learning', -1 * MINUTE),
      item('old-step', 'learning', -30 * MINUTE),
    ])
    expect(result.slice(0, 2).map((i) => i.card.id)).toEqual(['old-step', 'recent-step'])
  })

  it('excludes items that are not yet due', () => {
    const result = queue([item('due', 'review', -DAY), item('later', 'review', DAY)])
    expect(result.map((i) => i.card.id)).toEqual(['due'])
  })

  it('treats relearning steps with the same urgency as learning steps', () => {
    const result = queue([item('review-card', 'review', -DAY), item('lapsed', 'relearning', -MINUTE)])
    expect(result[0]?.card.id).toBe('lapsed')
  })

  it('always includes new cards, whose due date is their creation time', () => {
    const result = queue([item('neu', 'new', 0)])
    expect(result.map((i) => i.card.id)).toEqual(['neu'])
  })

  it('introduces new cards in file order', () => {
    const result = queue([item('erste', 'new', 0), item('zweite', 'new', 0), item('dritte', 'new', 0)])
    expect(result.map((i) => i.card.id)).toEqual(['erste', 'zweite', 'dritte'])
  })

  it('spreads new cards through the reviews instead of front-loading them', () => {
    const reviews = Array.from({ length: 6 }, (_, i) => item(`r${i}`, 'review', -DAY))
    const fresh = [item('n0', 'new', 0), item('n1', 'new', 0)]
    const result = queue([...reviews, ...fresh])

    const positions = result
      .map((entry, index) => (entry.state.phase === 'new' ? index : -1))
      .filter((index) => index >= 0)

    expect(result).toHaveLength(8)
    expect(positions[0]).toBeGreaterThan(0)
    expect(positions[1]).toBeLessThan(result.length - 1)
  })
})

describe('daily caps', () => {
  it('caps new cards at the daily limit', () => {
    const fresh = Array.from({ length: 30 }, (_, i) => item(`n${i}`, 'new', 0))
    const result = queue(fresh, { settings: settings({ newPerDay: 5 }) })
    expect(result).toHaveLength(5)
  })

  it('counts new cards already introduced today against the limit', () => {
    const fresh = Array.from({ length: 30 }, (_, i) => item(`n${i}`, 'new', 0))
    const result = queue(fresh, {
      settings: settings({ newPerDay: 5 }),
      doneToday: { introduced: 3, reviewed: 0 },
    })
    expect(result).toHaveLength(2)
  })

  it('offers no new cards once the daily limit is used up', () => {
    const result = queue([item('n0', 'new', 0)], {
      settings: settings({ newPerDay: 5 }),
      doneToday: { introduced: 5, reviewed: 0 },
    })
    expect(result).toEqual([])
  })

  it('never goes negative when the limit is lowered mid-day', () => {
    const result = queue([item('n0', 'new', 0)], {
      settings: settings({ newPerDay: 2 }),
      doneToday: { introduced: 10, reviewed: 0 },
    })
    expect(result).toEqual([])
  })

  it('caps due reviews', () => {
    const reviews = Array.from({ length: 40 }, (_, i) => item(`r${i}`, 'review', -DAY))
    const result = queue(reviews, { settings: settings({ maxReviewsPerDay: 12 }) })
    expect(result).toHaveLength(12)
  })

  it('never caps learning steps, which are time-critical', () => {
    const steps = Array.from({ length: 20 }, (_, i) => item(`l${i}`, 'learning', -MINUTE))
    const result = queue(steps, {
      settings: settings({ maxReviewsPerDay: 1, newPerDay: 0 }),
      doneToday: { introduced: 99, reviewed: 99 },
    })
    expect(result).toHaveLength(20)
  })
})

describe('deck filtering', () => {
  const deck: Deck = {
    id: 'kap4',
    name: 'Kapitel 4',
    filter: { sources: ['Krähen'], chapters: ['4'] },
  }

  it('restricts the queue to matching cards', () => {
    const result = queue(
      [
        item('drin', 'review', -DAY, { source: 'Krähen', chapter: '4' }),
        item('falsches-kapitel', 'review', -DAY, { source: 'Krähen', chapter: '5' }),
        item('anderes-buch', 'review', -DAY, { source: 'Anderes', chapter: '4' }),
      ],
      { deck },
    )
    expect(result.map((i) => i.card.id)).toEqual(['drin'])
  })

  it('uses the whole collection when no deck is selected', () => {
    const result = queue([
      item('a', 'review', -DAY, { source: 'Krähen' }),
      item('b', 'review', -DAY, { source: 'Anderes' }),
    ])
    expect(result).toHaveLength(2)
  })
})

describe('queueCounts', () => {
  it('reports each population separately, after caps', () => {
    const counts = queueCounts({
      items: [
        item('l0', 'learning', -MINUTE),
        ...Array.from({ length: 9 }, (_, i) => item(`r${i}`, 'review', -DAY)),
        ...Array.from({ length: 9 }, (_, i) => item(`n${i}`, 'new', 0)),
        item('spaeter', 'review', DAY),
      ],
      settings: settings({ newPerDay: 4, maxReviewsPerDay: 6 }),
      doneToday: nothingDone,
      now: NOW,
    })

    expect(counts).toEqual({ learning: 1, review: 6, fresh: 4, waiting: 1 })
  })

  it('agrees with the length of the queue it describes', () => {
    const items = [
      item('l0', 'learning', -MINUTE),
      ...Array.from({ length: 9 }, (_, i) => item(`r${i}`, 'review', -DAY)),
      ...Array.from({ length: 9 }, (_, i) => item(`n${i}`, 'new', 0)),
      item('spaeter', 'review', DAY),
    ]
    const input = {
      items,
      settings: settings({ newPerDay: 4, maxReviewsPerDay: 6 }),
      doneToday: nothingDone,
      now: NOW,
      rng: noShuffle,
    }
    const counts = queueCounts(input)
    expect(buildQueue(input)).toHaveLength(counts.learning + counts.review + counts.fresh)
  })
})

describe('robustness', () => {
  it('returns an empty queue when there is nothing to do', () => {
    expect(queue([])).toEqual([])
    expect(queue([item('spaeter', 'review', DAY)])).toEqual([])
  })

  it('does not mutate the items it is given', () => {
    const items = [item('a', 'review', -DAY), item('b', 'new', 0)]
    const snapshot = structuredClone(items)
    queue(items)
    expect(items).toEqual(snapshot)
  })
})
