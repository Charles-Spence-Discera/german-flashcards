import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  createSm2Scheduler,
  formatInterval,
  itemKey,
  parseItemKey,
  startOfStudyDay,
} from './scheduler'
import type { Grade, ReviewState } from './types'

// rng() === 0.5 puts the fuzz spread at exactly zero, so intervals are exact.
const noFuzz = () => 0.5
const scheduler = createSm2Scheduler(DEFAULT_SETTINGS, noFuzz)

const T0 = new Date('2026-08-12T10:00:00.000Z')
const MINUTE = 60_000
const DAY = 86_400_000

/** Minutes between the review at T0 and the resulting due date. */
function minutesUntilDue(state: ReviewState, from: Date = T0): number {
  return (new Date(state.due).getTime() - from.getTime()) / MINUTE
}

/** A graduated item, for exercising the review-phase branch directly. */
function graduated(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    ...scheduler.newState('gehen', 'de-en', T0),
    phase: 'review',
    intervalDays: 10,
    ease: 2.5,
    learningStep: -1,
    reps: 5,
    ...overrides,
  }
}

describe('item keys', () => {
  it('round-trips a card id and mode', () => {
    expect(parseItemKey(itemKey('gehen', 'de-en'))).toEqual({ cardId: 'gehen', mode: 'de-en' })
  })

  it('survives a card id containing colons', () => {
    const key = itemKey('buch::kapitel-1', 'en-de')
    expect(parseItemKey(key)).toEqual({ cardId: 'buch::kapitel-1', mode: 'en-de' })
  })

  it('rejects a string that is not a key', () => {
    expect(parseItemKey('gehen')).toBeNull()
  })
})

describe('a new item', () => {
  it('starts due immediately, unseen, at the default ease', () => {
    const state = scheduler.newState('gehen', 'de-en', T0)
    expect(state).toMatchObject({
      phase: 'new',
      ease: 2.5,
      intervalDays: 0,
      reps: 0,
      lapses: 0,
      lastReviewed: null,
    })
    expect(scheduler.isDue(state, T0)).toBe(true)
  })

  it('goes to the first learning step on "again"', () => {
    const next = scheduler.review(scheduler.newState('gehen', 'de-en', T0), 'again', T0)
    expect(next.phase).toBe('learning')
    expect(minutesUntilDue(next)).toBe(1)
  })

  it('skips to the second learning step on "good"', () => {
    const next = scheduler.review(scheduler.newState('gehen', 'de-en', T0), 'good', T0)
    expect(next.phase).toBe('learning')
    expect(minutesUntilDue(next)).toBe(10)
  })

  it('graduates straight out on "easy"', () => {
    const next = scheduler.review(scheduler.newState('gehen', 'de-en', T0), 'easy', T0)
    expect(next.phase).toBe('review')
    expect(next.intervalDays).toBe(DEFAULT_SETTINGS.easyIntervalDays)
  })

  it('graduates after working through the ladder with "good"', () => {
    let state = scheduler.newState('gehen', 'de-en', T0)
    state = scheduler.review(state, 'good', T0) // -> 10 min step
    state = scheduler.review(state, 'good', T0) // -> graduates
    expect(state.phase).toBe('review')
    expect(state.intervalDays).toBe(DEFAULT_SETTINGS.graduatingIntervalDays)
    expect(state.learningStep).toBe(-1)
  })

  it('sends a lapsed learning step back to the start on "again"', () => {
    let state = scheduler.newState('gehen', 'de-en', T0)
    state = scheduler.review(state, 'good', T0)
    state = scheduler.review(state, 'again', T0)
    expect(minutesUntilDue(state)).toBe(1)
    expect(state.learningStep).toBe(0)
  })

  it('repeats the current step on "hard" rather than advancing', () => {
    let state = scheduler.newState('gehen', 'de-en', T0)
    state = scheduler.review(state, 'good', T0) // step 1
    state = scheduler.review(state, 'hard', T0) // stays on step 1
    expect(state.learningStep).toBe(1)
    expect(minutesUntilDue(state)).toBe(10)
  })

  it('does not count learning steps as lapses', () => {
    let state = scheduler.newState('gehen', 'de-en', T0)
    state = scheduler.review(state, 'again', T0)
    state = scheduler.review(state, 'again', T0)
    expect(state.lapses).toBe(0)
  })
})

describe('a graduated item', () => {
  it('multiplies the interval by ease on "good"', () => {
    const next = scheduler.review(graduated(), 'good', T0)
    expect(next.intervalDays).toBe(25) // 10 * 2.5
    expect(next.ease).toBe(2.5)
  })

  it('uses the hard multiplier and lowers ease on "hard"', () => {
    const next = scheduler.review(graduated(), 'hard', T0)
    expect(next.intervalDays).toBe(12) // 10 * 1.2
    expect(next.ease).toBe(2.35)
  })

  it('applies the easy bonus on top of the raised ease', () => {
    const next = scheduler.review(graduated(), 'easy', T0)
    expect(next.ease).toBe(2.65)
    expect(next.intervalDays).toBe(34) // round(10 * 2.65 * 1.3)
  })

  it('anchors day-scale due dates to the start of the study day', () => {
    const next = scheduler.review(graduated({ intervalDays: 1, ease: 1.3 }), 'good', T0)
    // T0 is 10:00, the study day began at 04:00, so a 1-day interval lands at 04:00
    // the following morning rather than 10:00.
    expect(next.due).toBe('2026-08-13T04:00:00.000Z')
  })

  it('gives the same due date whether reviewed early or late in the day', () => {
    const morning = scheduler.review(graduated(), 'good', new Date('2026-08-12T06:00:00.000Z'))
    const night = scheduler.review(graduated(), 'good', new Date('2026-08-12T23:30:00.000Z'))
    expect(morning.due).toBe(night.due)
  })

  it('treats a 02:00 review as belonging to the previous study day', () => {
    const lateNight = scheduler.review(graduated(), 'good', new Date('2026-08-13T02:00:00.000Z'))
    const dayBefore = scheduler.review(graduated(), 'good', new Date('2026-08-12T20:00:00.000Z'))
    expect(lateNight.due).toBe(dayBefore.due)
  })
})

describe('lapses', () => {
  it('drops a forgotten item into relearning and counts the lapse', () => {
    const next = scheduler.review(graduated({ lapses: 1 }), 'again', T0)
    expect(next.phase).toBe('relearning')
    expect(next.lapses).toBe(2)
    expect(next.ease).toBe(2.3)
    expect(minutesUntilDue(next)).toBe(10)
  })

  it('shrinks the interval to the floor with the default multiplier of zero', () => {
    const next = scheduler.review(graduated({ intervalDays: 200 }), 'again', T0)
    expect(next.intervalDays).toBe(1)
  })

  it('honours a non-zero lapse multiplier', () => {
    const lenient = createSm2Scheduler(
      { ...DEFAULT_SETTINGS, lapseIntervalMultiplier: 0.5 },
      noFuzz,
    )
    const next = lenient.review(graduated({ intervalDays: 30 }), 'again', T0)
    expect(next.intervalDays).toBe(15)
  })

  it('returns to review after relearning, without re-counting the lapse', () => {
    const lapsed = scheduler.review(graduated(), 'again', T0)
    const recovered = scheduler.review(lapsed, 'good', T0)
    expect(recovered.phase).toBe('review')
    expect(recovered.lapses).toBe(lapsed.lapses)
  })

  it('resumes from the pre-lapse interval when relearning is answered "easy"', () => {
    const lenient = createSm2Scheduler(
      { ...DEFAULT_SETTINGS, lapseIntervalMultiplier: 0.5 },
      noFuzz,
    )
    const lapsed = lenient.review(graduated({ intervalDays: 30 }), 'again', T0)
    const recovered = lenient.review(lapsed, 'easy', T0)
    expect(recovered.phase).toBe('review')
    expect(recovered.intervalDays).toBe(15)
  })

  it('goes straight back to review when no relearning ladder is configured', () => {
    const noRelearn = createSm2Scheduler(
      { ...DEFAULT_SETTINGS, relearningStepsMinutes: [] },
      noFuzz,
    )
    const next = noRelearn.review(graduated(), 'again', T0)
    expect(next.phase).toBe('review')
    expect(next.lapses).toBe(1)
  })
})

describe('bounds', () => {
  it('never lets ease fall below the floor, however many lapses', () => {
    let ease = DEFAULT_SETTINGS.startingEase
    for (let i = 0; i < 40; i++) ease = scheduler.review(graduated({ ease }), 'again', T0).ease
    expect(ease).toBe(DEFAULT_SETTINGS.minimumEase)
  })

  it('never lets ease fall below the floor, however many "hard" answers', () => {
    let ease = DEFAULT_SETTINGS.startingEase
    for (let i = 0; i < 40; i++) ease = scheduler.review(graduated({ ease }), 'hard', T0).ease
    expect(ease).toBe(DEFAULT_SETTINGS.minimumEase)
  })

  it('penalises ease once per lapse, not once per relearning attempt', () => {
    const lapsed = scheduler.review(graduated(), 'again', T0)
    const stillRelearning = scheduler.review(lapsed, 'again', T0)
    expect(stillRelearning.ease).toBe(lapsed.ease)
  })

  it('caps the interval at the configured maximum', () => {
    const next = scheduler.review(graduated({ intervalDays: 10_000 }), 'easy', T0)
    expect(next.intervalDays).toBe(DEFAULT_SETTINGS.maximumIntervalDays)
  })

  it('never schedules a graduated item sooner than one day', () => {
    const next = scheduler.review(graduated({ intervalDays: 1, ease: 1.3 }), 'hard', T0)
    expect(next.intervalDays).toBeGreaterThanOrEqual(1)
  })

  it('grows from the scheduled interval, not from how overdue the item was', () => {
    const onTime = scheduler.review(graduated(), 'good', T0)
    const veryLate = scheduler.review(graduated(), 'good', new Date(T0.getTime() + 90 * DAY))
    expect(veryLate.intervalDays).toBe(onTime.intervalDays)
  })
})

describe('interval fuzz', () => {
  it('keeps intervals inside the configured spread at both extremes', () => {
    for (const rngValue of [0, 1]) {
      const fuzzy = createSm2Scheduler(DEFAULT_SETTINGS, () => rngValue)
      const next = fuzzy.review(graduated(), 'good', T0)
      expect(next.intervalDays).toBeGreaterThanOrEqual(23) // 25 * 0.95
      expect(next.intervalDays).toBeLessThanOrEqual(27) // 25 * 1.05
    }
  })

  it('leaves one-day intervals unfuzzed', () => {
    for (const rngValue of [0, 0.5, 1]) {
      const fuzzy = createSm2Scheduler(DEFAULT_SETTINGS, () => rngValue)
      let state = fuzzy.newState('gehen', 'de-en', T0)
      state = fuzzy.review(state, 'good', T0)
      state = fuzzy.review(state, 'good', T0)
      expect(state.intervalDays).toBe(1)
    }
  })
})

describe('purity', () => {
  it('does not mutate the state it is given', () => {
    const before = graduated()
    const snapshot = structuredClone(before)
    scheduler.review(before, 'easy', T0)
    expect(before).toEqual(snapshot)
  })

  it('produces no preview side effects', () => {
    const before = graduated()
    const snapshot = structuredClone(before)
    scheduler.preview(before, T0)
    expect(before).toEqual(snapshot)
  })
})

describe('preview', () => {
  it('labels all four buttons for a new item', () => {
    const labels = scheduler.preview(scheduler.newState('gehen', 'de-en', T0), T0)
    expect(labels).toEqual({ again: '1 min', hard: '1 min', good: '10 min', easy: '4 d' })
  })

  it('matches what a real review would schedule', () => {
    const state = graduated()
    const labels = scheduler.preview(state, T0)
    for (const grade of ['again', 'hard', 'good', 'easy'] as Grade[]) {
      const actual = scheduler.review(state, grade, T0)
      const ms = new Date(actual.due).getTime() - T0.getTime()
      expect(labels[grade]).toBe(formatInterval(ms))
    }
  })
})

describe('isDue', () => {
  it('is false before the due date and true from it onwards', () => {
    const state = graduated({ due: new Date(T0.getTime() + DAY).toISOString() })
    expect(scheduler.isDue(state, T0)).toBe(false)
    expect(scheduler.isDue(state, new Date(T0.getTime() + DAY))).toBe(true)
    expect(scheduler.isDue(state, new Date(T0.getTime() + 2 * DAY))).toBe(true)
  })
})

describe('startOfStudyDay', () => {
  it('returns today at the rollover hour once it has passed', () => {
    expect(startOfStudyDay(new Date('2026-08-12T10:00:00Z'), 4).toISOString()).toBe(
      '2026-08-12T04:00:00.000Z',
    )
  })

  it('returns yesterday at the rollover hour before it', () => {
    expect(startOfStudyDay(new Date('2026-08-12T02:00:00Z'), 4).toISOString()).toBe(
      '2026-08-11T04:00:00.000Z',
    )
  })
})

describe('formatInterval', () => {
  it.each([
    [30 * 1000, '<1 min'],
    [MINUTE, '1 min'],
    [10 * MINUTE, '10 min'],
    [3 * 3600_000, '3 h'],
    [DAY, '1 d'],
    [25 * DAY, '25 d'],
    [90 * DAY, '3.0 mo'],
    [800 * DAY, '2.2 yr'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatInterval(ms)).toBe(expected)
  })
})
