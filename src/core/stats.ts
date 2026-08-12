/**
 * Derived study statistics.
 *
 * Everything here is computed from the review log and current item states — nothing
 * is accumulated as it happens. Running totals drift the moment a write is lost or a
 * backup is merged; recomputation cannot.
 */

import { startOfStudyDay } from './scheduler'
import type { ReviewItem, ReviewLogEntry } from './types'

/** Interval at which a card is considered properly known, matching Anki's convention. */
export const MATURE_INTERVAL_DAYS = 21

const DAY_MS = 86_400_000

export interface Stats {
  total: number
  fresh: number
  learning: number
  /** Graduated, but not yet at a long interval. */
  young: number
  /** Graduated with an interval of at least three weeks. */
  mature: number
  /** Reviews per study day, oldest first, ending today. */
  reviewsPerDay: number[]
  /** Share of graduated reviews not answered "again", or null if there are none yet. */
  retention: number | null
  /** Consecutive study days with at least one review, counting back from today. */
  streakDays: number
  /** Total reviews ever logged. */
  reviewsAllTime: number
}

/** The start of the study day a timestamp belongs to, as a bucket key. */
function dayBucket(at: number, dayStartHour: number): number {
  return startOfStudyDay(new Date(at), dayStartHour).getTime()
}

export function computeStats(
  items: ReviewItem[],
  log: ReviewLogEntry[],
  now: Date,
  dayStartHour: number,
  windowDays = 30,
): Stats {
  let fresh = 0
  let learning = 0
  let young = 0
  let mature = 0

  for (const item of items) {
    switch (item.state.phase) {
      case 'new':
        fresh++
        break
      case 'learning':
      case 'relearning':
        learning++
        break
      default:
        if (item.state.intervalDays >= MATURE_INTERVAL_DAYS) mature++
        else young++
    }
  }

  const perDay = new Map<number, number>()
  let graduatedReviews = 0
  let recalled = 0

  const todayStart = startOfStudyDay(now, dayStartHour).getTime()
  const windowStart = todayStart - (windowDays - 1) * DAY_MS

  for (const entry of log) {
    const at = Date.parse(entry.at)
    if (Number.isNaN(at)) continue
    const bucket = dayBucket(at, dayStartHour)
    perDay.set(bucket, (perDay.get(bucket) ?? 0) + 1)

    // Retention is only meaningful for graduated cards: failing a learning step is
    // part of learning, not forgetting.
    if (at >= windowStart && entry.phaseBefore === 'review') {
      graduatedReviews++
      if (entry.grade !== 'again') recalled++
    }
  }

  const reviewsPerDay: number[] = []
  for (let offset = windowDays - 1; offset >= 0; offset--) {
    reviewsPerDay.push(perDay.get(todayStart - offset * DAY_MS) ?? 0)
  }

  // A day with no reviews yet does not break a streak that ran up to yesterday.
  let streakDays = 0
  let cursor = (perDay.get(todayStart) ?? 0) > 0 ? todayStart : todayStart - DAY_MS
  while ((perDay.get(cursor) ?? 0) > 0) {
    streakDays++
    cursor -= DAY_MS
  }

  return {
    total: items.length,
    fresh,
    learning,
    young,
    mature,
    reviewsPerDay,
    retention: graduatedReviews > 0 ? recalled / graduatedReviews : null,
    streakDays,
    reviewsAllTime: log.length,
  }
}
