/**
 * Spaced-repetition scheduling.
 *
 * The implementation is SM-2 with Anki-style learning steps: sub-day steps while a
 * word is being learned, then an ease-factor-driven interval once it graduates.
 *
 * Everything is reached through the `Scheduler` interface and every input that
 * varies — the clock, the randomness used for interval fuzz — is injected. That
 * exists for two reasons: the tests can assert exact intervals rather than ranges,
 * and swapping SM-2 for FSRS later means adding a second implementation of this
 * interface rather than editing scheduling logic scattered through the UI.
 */

import type { Grade, ItemMode, Phase, ReviewState } from './types'

export interface SchedulerSettings {
  /** Minutes between each step while learning a new item. */
  learningStepsMinutes: number[]
  /** Minutes between each step while relearning a lapsed item. */
  relearningStepsMinutes: number[]
  /** Interval given when an item graduates by answering "good". */
  graduatingIntervalDays: number
  /** Interval given when an item graduates straight out via "easy". */
  easyIntervalDays: number
  /** Ease factor a new item starts with. */
  startingEase: number
  /** Ease factor floor — below this, intervals stop growing usefully. */
  minimumEase: number
  /** What remains of the interval after a lapse. 0 sends the item back to one day. */
  lapseIntervalMultiplier: number
  /** Extra multiplier applied on top of ease when answering "easy". */
  easyBonus: number
  /** Multiplier applied when answering "hard" during review. */
  hardMultiplier: number
  /** Upper bound on interval growth. */
  maximumIntervalDays: number
  /** Proportional random spread on new intervals, to stop reviews clumping. */
  fuzzFactor: number
  /** Hour at which a new study day begins. Late-night reviews count as the day before. */
  dayStartHour: number
}

export const DEFAULT_SETTINGS: SchedulerSettings = {
  learningStepsMinutes: [1, 10],
  relearningStepsMinutes: [10],
  graduatingIntervalDays: 1,
  easyIntervalDays: 4,
  startingEase: 2.5,
  minimumEase: 1.3,
  lapseIntervalMultiplier: 0,
  easyBonus: 1.3,
  hardMultiplier: 1.2,
  maximumIntervalDays: 365 * 5,
  fuzzFactor: 0.05,
  dayStartHour: 4,
}

/** Ease adjustment per grade, applied when reviewing a graduated item. */
const EASE_DELTA: Record<Grade, number> = {
  again: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.15,
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** Source of randomness for interval fuzz. Injected so tests are deterministic. */
export type Rng = () => number

export interface Scheduler {
  /** Identifies the algorithm in exported data, so old exports stay interpretable. */
  readonly id: string
  /** Scheduling state for an item that has never been seen. */
  newState(cardId: string, mode: ItemMode, now?: Date): ReviewState
  /** Applies a grade, returning fresh state. Never mutates its input. */
  review(state: ReviewState, grade: Grade, now?: Date): ReviewState
  /** Labels for the four grade buttons, e.g. `{ good: "10 min" }`. */
  preview(state: ReviewState, now?: Date): Record<Grade, string>
  isDue(state: ReviewState, now?: Date): boolean
}

/** The storage key for one testable direction of a card. */
export function itemKey(cardId: string, mode: ItemMode): string {
  return `${cardId}::${mode}`
}

/** Splits a storage key back into its parts, or null if it is not one. */
export function parseItemKey(key: string): { cardId: string; mode: ItemMode } | null {
  const separator = key.lastIndexOf('::')
  if (separator <= 0) return null
  return {
    cardId: key.slice(0, separator),
    mode: key.slice(separator + 2) as ItemMode,
  }
}

/**
 * The instant the study day containing `at` began. A review at 01:00 belongs to the
 * previous calendar day when the day starts at 04:00, which keeps a late-night
 * session from being split across two days' due counts.
 */
export function startOfStudyDay(at: Date, dayStartHour: number): Date {
  const start = new Date(at)
  start.setHours(dayStartHour, 0, 0, 0)
  if (start.getTime() > at.getTime()) start.setDate(start.getDate() - 1)
  return start
}

/** Renders a duration the way the grade buttons show it: "10 min", "3 d", "2.4 mo". */
export function formatInterval(ms: number): string {
  if (ms < MINUTE_MS) return '<1 min'
  const minutes = ms / MINUTE_MS
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)} h`
  const days = hours / 24
  if (days < 30) return `${Math.round(days)} d`
  const months = days / 30.44
  if (months < 12) return `${months.toFixed(1)} mo`
  return `${(days / 365.25).toFixed(1)} yr`
}

export function createSm2Scheduler(
  settings: SchedulerSettings = DEFAULT_SETTINGS,
  rng: Rng = Math.random,
): Scheduler {
  /** Spreads intervals so that cards learned together do not all fall due together. */
  function fuzz(days: number): number {
    // One-day intervals are left alone; fuzzing them can only round back to one.
    if (days < 2 || settings.fuzzFactor <= 0) return days
    const spread = (rng() * 2 - 1) * settings.fuzzFactor
    return days * (1 + spread)
  }

  function clampInterval(days: number): number {
    const capped = Math.min(days, settings.maximumIntervalDays)
    return Math.max(1, Math.round(capped))
  }

  function clampEase(ease: number): number {
    return Math.max(settings.minimumEase, Math.round(ease * 100) / 100)
  }

  /** Due date for a sub-day step, measured forward from the moment of review. */
  function dueInMinutes(now: Date, minutes: number): string {
    return new Date(now.getTime() + minutes * MINUTE_MS).toISOString()
  }

  /**
   * Due date for a day-scale interval. Anchored to the start of the study day rather
   * than the exact review time, so reviewing at 09:00 or 23:00 puts the card in the
   * same future day's queue.
   */
  function dueInDays(now: Date, days: number): string {
    const dayStart = startOfStudyDay(now, settings.dayStartHour)
    return new Date(dayStart.getTime() + days * DAY_MS).toISOString()
  }

  function steps(phase: Phase): number[] {
    return phase === 'relearning' ? settings.relearningStepsMinutes : settings.learningStepsMinutes
  }

  function graduate(
    state: ReviewState,
    now: Date,
    intervalDays: number,
    ease: number,
    lapses: number,
  ): ReviewState {
    const days = clampInterval(fuzz(intervalDays))
    return {
      ...state,
      phase: 'review',
      ease,
      intervalDays: days,
      learningStep: -1,
      due: dueInDays(now, days),
      lastReviewed: now.toISOString(),
      reps: state.reps + 1,
      lapses,
    }
  }

  /** Handles a grade for an item that is still on the learning/relearning ladder. */
  function reviewLearning(state: ReviewState, grade: Grade, now: Date): ReviewState {
    const ladder = steps(state.phase)
    const base = {
      ...state,
      lastReviewed: now.toISOString(),
      reps: state.reps + 1,
    }

    if (grade === 'easy') {
      // "Easy" during relearning restores the pre-lapse interval rather than
      // treating the word as brand new — it was known once.
      const target =
        state.phase === 'relearning'
          ? Math.max(state.intervalDays, settings.graduatingIntervalDays)
          : settings.easyIntervalDays
      return graduate(base, now, target, state.ease, state.lapses)
    }

    let nextStep: number
    if (grade === 'again') {
      nextStep = 0
    } else if (grade === 'hard') {
      // Repeat the current step rather than advancing; "hard" is not progress.
      nextStep = Math.max(0, state.learningStep)
    } else {
      nextStep = Math.max(0, state.learningStep) + 1
    }

    if (nextStep >= ladder.length) {
      const target =
        state.phase === 'relearning'
          ? Math.max(state.intervalDays, settings.graduatingIntervalDays)
          : settings.graduatingIntervalDays
      return graduate(base, now, target, state.ease, state.lapses)
    }

    const minutes = ladder[nextStep] ?? ladder[ladder.length - 1] ?? 10
    return {
      ...base,
      phase: state.phase === 'relearning' ? 'relearning' : 'learning',
      learningStep: nextStep,
      due: dueInMinutes(now, minutes),
    }
  }

  /** Handles a grade for a graduated item. */
  function reviewGraduated(state: ReviewState, grade: Grade, now: Date): ReviewState {
    const ease = clampEase(state.ease + EASE_DELTA[grade])

    if (grade === 'again') {
      // A lapse: drop to the relearning ladder, shrink the interval, and remember
      // the shrunken value so graduating out of relearning resumes from there.
      const lapsedInterval = clampInterval(state.intervalDays * settings.lapseIntervalMultiplier)
      const firstStep = settings.relearningStepsMinutes[0]
      const nowIso = now.toISOString()

      if (firstStep === undefined) {
        // No relearning ladder configured — go straight back into review.
        return {
          ...state,
          phase: 'review',
          ease,
          intervalDays: lapsedInterval,
          learningStep: -1,
          due: dueInDays(now, lapsedInterval),
          lastReviewed: nowIso,
          reps: state.reps + 1,
          lapses: state.lapses + 1,
        }
      }

      return {
        ...state,
        phase: 'relearning',
        ease,
        intervalDays: lapsedInterval,
        learningStep: 0,
        due: dueInMinutes(now, firstStep),
        lastReviewed: nowIso,
        reps: state.reps + 1,
        lapses: state.lapses + 1,
      }
    }

    const multiplier =
      grade === 'hard'
        ? settings.hardMultiplier
        : grade === 'easy'
          ? ease * settings.easyBonus
          : ease

    // Growth is measured from the scheduled interval, not from how late the review
    // actually happened, so a forgotten backlog cannot inflate intervals.
    const nextDays = clampInterval(fuzz(state.intervalDays * multiplier))

    return {
      ...state,
      phase: 'review',
      ease,
      intervalDays: nextDays,
      learningStep: -1,
      due: dueInDays(now, nextDays),
      lastReviewed: now.toISOString(),
      reps: state.reps + 1,
    }
  }

  return {
    id: 'sm2-v1',

    newState(cardId, mode, now = new Date()) {
      return {
        key: itemKey(cardId, mode),
        cardId,
        mode,
        phase: 'new',
        ease: settings.startingEase,
        intervalDays: 0,
        learningStep: -1,
        // Due immediately: a new item is available as soon as it enters the pool.
        due: now.toISOString(),
        lastReviewed: null,
        reps: 0,
        lapses: 0,
      }
    },

    review(state, grade, now = new Date()) {
      if (state.phase === 'review') return reviewGraduated(state, grade, now)
      // A new item enters the learning ladder on its first grade. Its step is -1,
      // meaning "before the ladder", so "again" lands on step 0 and "good" advances
      // to step 1 — a first "good" therefore skips the shortest step, as intended.
      const entering: ReviewState = state.phase === 'new' ? { ...state, phase: 'learning' } : state
      return reviewLearning(entering, grade, now)
    },

    preview(state, now = new Date()) {
      const at = now.getTime()
      const label = (grade: Grade): string => {
        // Preview must be stable across renders, so it runs without fuzz.
        const stable = createSm2Scheduler({ ...settings, fuzzFactor: 0 }, rng)
        const next = stable.review(state, grade, now)
        return formatInterval(Math.max(0, new Date(next.due).getTime() - at))
      }
      return {
        again: label('again'),
        hard: label('hard'),
        good: label('good'),
        easy: label('easy'),
      }
    },

    isDue(state, now = new Date()) {
      return new Date(state.due).getTime() <= now.getTime()
    },
  }
}
