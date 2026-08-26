import { describe, expect, it } from 'vitest'
import { ALL_MODES, AUFBAU_MODES, BASE_MODE, isAufbauMode, isModeUnlocked, modeLabel } from './modes'
import { itemKey } from './scheduler'
import type { Card, ItemMode, Phase, ReviewState } from './types'

const THRESHOLD = 5

const subject: Card = { id: 'gehen', de: 'gehen', en: 'to go' }

function state(mode: ItemMode, phase: Phase, intervalDays: number): ReviewState {
  return {
    key: itemKey('gehen', mode),
    cardId: 'gehen',
    mode,
    phase,
    ease: 2.5,
    intervalDays,
    learningStep: phase === 'review' ? -1 : 0,
    due: '2026-09-01T04:00:00.000Z',
    lastReviewed: '2026-08-01T10:00:00.000Z',
    reps: 4,
    lapses: 0,
  }
}

function lookup(...states: ReviewState[]) {
  const map = new Map(states.map((entry) => [entry.mode, entry]))
  return (mode: ItemMode) => map.get(mode)
}

function unlocked(mode: ItemMode, ...states: ReviewState[]) {
  return isModeUnlocked(subject, mode, lookup(...states), THRESHOLD)
}

describe('mode taxonomy', () => {
  it('treats only the productive directions as Aufbau', () => {
    expect(isAufbauMode(BASE_MODE)).toBe(false)
    expect(AUFBAU_MODES.every(isAufbauMode)).toBe(true)
    expect(ALL_MODES).toEqual([BASE_MODE, ...AUFBAU_MODES])
  })

  it('names every mode it generates', () => {
    for (const mode of ALL_MODES) expect(modeLabel(mode)).not.toBe(mode)
  })
})

describe('isModeUnlocked', () => {
  it('always grants the base mode, even with no history at all', () => {
    expect(unlocked(BASE_MODE)).toBe(true)
  })

  it('withholds Aufbau modes from a card that has never been seen', () => {
    for (const mode of AUFBAU_MODES) expect(unlocked(mode)).toBe(false)
  })

  it('withholds them while the base interval is still short', () => {
    expect(unlocked('en-de', state(BASE_MODE, 'review', THRESHOLD - 1))).toBe(false)
  })

  it('grants them once the base interval reaches the threshold', () => {
    for (const mode of AUFBAU_MODES) {
      expect(unlocked(mode, state(BASE_MODE, 'review', THRESHOLD))).toBe(true)
    }
  })

  it('grants both productive modes together', () => {
    const base = state(BASE_MODE, 'review', 40)
    expect(unlocked('en-de', base)).toBe(unlocked('typed-de', base))
  })

  it('ignores a long interval that has not graduated', () => {
    // A relearning card can carry its old interval; it has not re-earned anything.
    expect(unlocked('en-de', state(BASE_MODE, 'relearning', 40))).toBe(false)
    expect(unlocked('en-de', state(BASE_MODE, 'learning', 40))).toBe(false)
  })

  it('latches: an unlocked mode survives the base card lapsing', () => {
    // The whole point — a bad week must not make existing work vanish from the queue
    // and strand its stored progress outside it.
    const lapsed = state(BASE_MODE, 'relearning', 1)
    const earned = state('typed-de', 'review', 3)
    expect(unlocked('typed-de', lapsed, earned)).toBe(true)
  })
})
