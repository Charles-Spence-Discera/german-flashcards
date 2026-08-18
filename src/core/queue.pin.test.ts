import { describe, expect, it } from 'vitest'
import { pinActive } from './queue'
import { itemKey } from './scheduler'
import type { Card, Phase, ReviewItem, ReviewState } from './types'

const NOW = new Date('2026-08-12T10:00:00.000Z')
const MINUTE = 60_000
const DAY = 86_400_000

function card(id: string, overrides: Partial<Card> = {}): Card {
  return { id, de: id, en: `${id} (en)`, ...overrides }
}

function item(id: string, phase: Phase, dueOffsetMs: number): ReviewItem {
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
  return { card: card(id), state }
}

describe('pinActive', () => {
  const a = item('a', 'review', -DAY)
  const b = item('b', 'review', -DAY)
  const c = item('c', 'learning', -MINUTE)

  it('leaves the queue alone when nothing is on screen yet', () => {
    expect(pinActive([a, b], null)).toEqual([a, b])
  })

  it('leaves the queue alone when the active card is already at the front', () => {
    const result = pinActive([a, b], a.state.key)
    expect(result.map((entry) => entry.card.id)).toEqual(['a', 'b'])
  })

  it('moves the active card back to the front after a reshuffle', () => {
    const result = pinActive([b, a], a.state.key)
    expect(result.map((entry) => entry.card.id)).toEqual(['a', 'b'])
  })

  it('holds position against a learning card that has just fallen due', () => {
    const result = pinActive([c, a, b], a.state.key)
    expect(result.map((entry) => entry.card.id)).toEqual(['a', 'c', 'b'])
  })

  it('releases once the active card has left the queue', () => {
    const result = pinActive([b, c], a.state.key)
    expect(result.map((entry) => entry.card.id)).toEqual(['b', 'c'])
  })

  it('preserves the relative order of everything else', () => {
    const d = item('d', 'review', -DAY)
    const result = pinActive([b, c, a, d], a.state.key)
    expect(result.map((entry) => entry.card.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
