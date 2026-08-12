/**
 * Deciding what to study, and in what order.
 *
 * Three populations compete for a session, and they are not interchangeable:
 *
 * - **Learning steps** are minutes-scale and time-critical. A word waiting on a
 *   ten-minute step is mid-acquisition, so these always come first and are never
 *   subject to a daily cap.
 * - **Due reviews** are the core work. Capped, so returning from a holiday to 400
 *   due cards presents a manageable session instead of an unusable one.
 * - **New cards** are optional work. Capped separately, and interleaved through the
 *   reviews rather than front-loaded, so a session does not open with a wall of
 *   unfamiliar words.
 */

import { startOfStudyDay } from './scheduler'
import type { AppSettings } from './settings'
import type { Card, Deck, DeckFilter, ReviewItem, ReviewLogEntry } from './types'

export interface DailyCounts {
  /** New cards seen for the first time today. */
  introduced: number
  /** Graduated cards reviewed today. Learning steps are excluded. */
  reviewed: number
}

export interface QueueCounts {
  learning: number
  review: number
  /** New cards available today, after the daily cap. */
  fresh: number
  /** Cards in the deck that are neither due nor available — for context, not work. */
  waiting: number
}

export interface QueueInput {
  items: ReviewItem[]
  settings: AppSettings
  doneToday: DailyCounts
  now?: Date
  /** Restrict to a deck. Null or omitted means the whole collection. */
  deck?: Deck | null
  rng?: () => number
}

/**
 * True if a card is selected by a deck filter.
 *
 * Fields are ANDed and values within a field are ORed, so
 * `{ sources: ['A', 'B'], chapters: ['1'] }` reads as "from A or B, chapter 1".
 * An empty filter matches everything, which makes "all cards" the default rather
 * than a special case.
 */
export function matchesFilter(card: Card, filter: DeckFilter): boolean {
  if (filter.ids?.length && !filter.ids.includes(card.id)) return false
  if (filter.sources?.length && (card.source === undefined || !filter.sources.includes(card.source))) {
    return false
  }
  if (
    filter.chapters?.length &&
    (card.chapter === undefined || !filter.chapters.includes(card.chapter))
  ) {
    return false
  }
  if (filter.tags?.length) {
    const tags = card.tags ?? []
    if (!filter.tags.some((tag) => tags.includes(tag))) return false
  }
  return true
}

/** Counts today's completed work, for enforcing daily caps across sessions. */
export function dailyCounts(
  log: ReviewLogEntry[],
  now: Date,
  dayStartHour: number,
): DailyCounts {
  const dayStart = startOfStudyDay(now, dayStartHour).getTime()
  let introduced = 0
  let reviewed = 0
  for (const entry of log) {
    if (Date.parse(entry.at) < dayStart) continue
    if (entry.phaseBefore === 'new') introduced++
    else if (entry.phaseBefore === 'review') reviewed++
  }
  return { introduced, reviewed }
}

/** Fisher–Yates, with injected randomness so tests can pin the order. */
function shuffle<T>(input: T[], rng: () => number): T[] {
  const out = [...input]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const a = out[i]
    const b = out[j]
    if (a !== undefined && b !== undefined) {
      out[i] = b
      out[j] = a
    }
  }
  return out
}

/**
 * Spaces new cards evenly through the reviews rather than clustering them.
 * Insertion runs back to front so that earlier positions stay valid.
 */
function interleave(reviews: ReviewItem[], fresh: ReviewItem[]): ReviewItem[] {
  if (fresh.length === 0) return reviews
  if (reviews.length === 0) return fresh

  const out = [...reviews]
  for (let i = fresh.length - 1; i >= 0; i--) {
    const item = fresh[i]
    if (item === undefined) continue
    const position = Math.round(((i + 1) * reviews.length) / (fresh.length + 1))
    out.splice(position, 0, item)
  }
  return out
}

interface Split {
  learning: ReviewItem[]
  review: ReviewItem[]
  fresh: ReviewItem[]
  waiting: number
}

function split(input: QueueInput): Split {
  const now = input.now ?? new Date()
  const at = now.getTime()
  const filter = input.deck?.filter

  const learning: ReviewItem[] = []
  const review: ReviewItem[] = []
  const fresh: ReviewItem[] = []
  let waiting = 0

  for (const item of input.items) {
    if (filter && !matchesFilter(item.card, filter)) continue

    if (item.state.phase === 'new') {
      fresh.push(item)
      continue
    }
    if (Date.parse(item.state.due) > at) {
      waiting++
      continue
    }
    if (item.state.phase === 'review') review.push(item)
    else learning.push(item)
  }

  // Learning steps run in due order: the one waiting longest is the most urgent.
  learning.sort((a, b) => Date.parse(a.state.due) - Date.parse(b.state.due))

  // New cards follow file order, so a chapter is introduced in the order it was read.
  return { learning, review, fresh, waiting }
}

/** How much work the deck holds right now, after daily caps. */
export function queueCounts(input: QueueInput): QueueCounts {
  const { learning, review, fresh, waiting } = split(input)
  const { settings, doneToday } = input
  return {
    learning: learning.length,
    review: Math.min(review.length, Math.max(0, settings.maxReviewsPerDay - doneToday.reviewed)),
    fresh: Math.min(fresh.length, Math.max(0, settings.newPerDay - doneToday.introduced)),
    waiting,
  }
}

/**
 * The ordered study queue for right now.
 *
 * Recomputed after every answer rather than held as a mutable list: an item graded
 * "again" becomes due in a minute and has to reappear later in the same session,
 * which a static queue cannot express.
 */
export function buildQueue(input: QueueInput): ReviewItem[] {
  const { learning, review, fresh } = split(input)
  const { settings, doneToday } = input
  const rng = input.rng ?? Math.random

  const reviewBudget = Math.max(0, settings.maxReviewsPerDay - doneToday.reviewed)
  const newBudget = Math.max(0, settings.newPerDay - doneToday.introduced)

  const cappedReviews = shuffle(review, rng).slice(0, reviewBudget)
  const cappedFresh = fresh.slice(0, newBudget)

  return [...learning, ...interleave(cappedReviews, cappedFresh)]
}
