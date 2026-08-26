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
 * - **Aufbau cards** — productive modes newly unlocked on words already known — are
 *   new cards too, but budgeted apart from fresh vocabulary. Sharing one allowance
 *   would mean a wave of level-ups quietly starving a new chapter, or the reverse;
 *   two budgets let either be throttled without touching the other.
 */

import { isAufbauMode } from './modes'
import { parseItemKey, startOfStudyDay } from './scheduler'
import type { AppSettings, SessionMode } from './settings'
import type { Card, Deck, DeckFilter, ReviewItem, ReviewLogEntry } from './types'

/**
 * How long a word counts as "just seen" for the purposes of Breite.
 *
 * The problem being solved is priming, which is short-lived: answering a word ten
 * minutes ago makes the next asking a test of working memory, whereas answering it
 * this morning does not. An hour is comfortably longer than a session and far
 * shorter than a day, which is the span the user explicitly wanted left alone.
 */
const SIBLING_WINDOW_MS = 60 * 60 * 1000

/**
 * Cards answered recently enough that asking them another way would test recall of
 * the last few minutes rather than of the word.
 *
 * Derived from the review log rather than held in session state, so it costs no
 * storage, survives a reload mid-session, and needs no cleanup.
 */
export function recentlyReviewed(
  log: ReviewLogEntry[],
  now: Date,
  windowMs: number = SIBLING_WINDOW_MS,
): Set<string> {
  const cutoff = now.getTime() - windowMs
  const ids = new Set<string>()
  for (const entry of log) {
    if (Date.parse(entry.at) < cutoff) continue
    const parsed = parseItemKey(entry.key)
    if (parsed !== null) ids.add(parsed.cardId)
  }
  return ids
}

export interface DailyCounts {
  /** Previously unseen vocabulary introduced today. */
  introduced: number
  /** Newly unlocked Aufbau items introduced today, budgeted separately. */
  aufbauIntroduced: number
  /** Graduated cards reviewed today. Learning steps are excluded. */
  reviewed: number
}

export interface QueueCounts {
  learning: number
  review: number
  /** New vocabulary available today, after the daily cap. */
  fresh: number
  /** Newly unlocked Aufbau items available today, after their own cap. */
  aufbau: number
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
  /**
   * Cards answered in the recent past, whose other modes Breite should hold back.
   * Omitted means the session has no memory, which is only right in tests.
   */
  recentCardIds?: Set<string>
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
  let aufbauIntroduced = 0
  let reviewed = 0
  for (const entry of log) {
    if (Date.parse(entry.at) < dayStart) continue
    if (entry.phaseBefore === 'new') {
      // The mode is already encoded in the log key, so the two populations can be
      // told apart retroactively — no migration, and history written before Aufbau
      // existed classifies correctly as ordinary vocabulary.
      const parsed = parseItemKey(entry.key)
      if (parsed !== null && isAufbauMode(parsed.mode)) aufbauIntroduced++
      else introduced++
    } else if (entry.phaseBefore === 'review') reviewed++
  }
  return { introduced, aufbauIntroduced, reviewed }
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
  aufbau: ReviewItem[]
  waiting: number
}

function split(input: QueueInput): Split {
  const now = input.now ?? new Date()
  const at = now.getTime()
  const filter = input.deck?.filter

  const learning: ReviewItem[] = []
  const review: ReviewItem[] = []
  const fresh: ReviewItem[] = []
  const aufbau: ReviewItem[] = []
  let waiting = 0

  for (const item of input.items) {
    if (filter && !matchesFilter(item.card, filter)) continue

    if (item.state.phase === 'new') {
      if (isAufbauMode(item.state.mode)) aufbau.push(item)
      else fresh.push(item)
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
  return { learning, review, fresh, aufbau, waiting }
}

/**
 * Sends a word's later modes to the back of the session.
 *
 * Once a card has three modes they can all fall due on the same day, and answering
 * Deutsch → Englisch immediately primes the two productive directions — the second
 * and third askings test recall of the last thirty seconds rather than of the word.
 * In `breadth` the repeats are moved to the end of the queue, so the session covers
 * distinct words first and only doubles back if there is time.
 *
 * Deferred rather than hidden: nothing is removed from the session and nothing is
 * persisted, so the choice costs no progress and can be changed mid-session. Cards
 * already on the learning ladder are treated as seen but are never themselves moved,
 * since they are minutes-scale and time-critical.
 *
 * `recent` is what makes this hold up across a session. The queue is rebuilt after
 * every answer, so without it a sibling that was being deferred becomes the first
 * occurrence of its word the moment its partner is graded away — and jumps straight
 * to the front, which is precisely the back-to-back asking Breite exists to prevent.
 */
function spaceSiblings(
  learning: ReviewItem[],
  tail: ReviewItem[],
  mode: SessionMode,
  recent: Set<string>,
): ReviewItem[] {
  if (mode === 'depth') return tail

  const seen = new Set([...recent, ...learning.map((item) => item.card.id)])
  const kept: ReviewItem[] = []
  const deferred: ReviewItem[] = []

  for (const item of tail) {
    if (seen.has(item.card.id)) deferred.push(item)
    else {
      seen.add(item.card.id)
      kept.push(item)
    }
  }

  return [...kept, ...deferred]
}

/** How much work the deck holds right now, after daily caps. */
export function queueCounts(input: QueueInput): QueueCounts {
  const { learning, review, fresh, aufbau, waiting } = split(input)
  const { settings, doneToday } = input
  return {
    learning: learning.length,
    review: Math.min(review.length, Math.max(0, settings.maxReviewsPerDay - doneToday.reviewed)),
    fresh: Math.min(fresh.length, Math.max(0, settings.newPerDay - doneToday.introduced)),
    aufbau: Math.min(
      aufbau.length,
      Math.max(0, settings.aufbauPerDay - doneToday.aufbauIntroduced),
    ),
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
  const { learning, review, fresh, aufbau } = split(input)
  const { settings, doneToday } = input
  const rng = input.rng ?? Math.random

  const reviewBudget = Math.max(0, settings.maxReviewsPerDay - doneToday.reviewed)
  const newBudget = Math.max(0, settings.newPerDay - doneToday.introduced)
  const aufbauBudget = Math.max(0, settings.aufbauPerDay - doneToday.aufbauIntroduced)

  const cappedReviews = shuffle(review, rng).slice(0, reviewBudget)
  const cappedFresh = fresh.slice(0, newBudget)
  const cappedAufbau = aufbau.slice(0, aufbauBudget)

  // Both introductions interleave through the reviews together: they are the same
  // kind of work to a session, however differently they are budgeted.
  const tail = interleave(cappedReviews, [...cappedFresh, ...cappedAufbau])

  const recent = input.recentCardIds ?? new Set<string>()

  return [...learning, ...spaceSiblings(learning, tail, settings.sessionMode, recent)]
}

/**
 * Keeps whichever card is on screen at the front of a freshly rebuilt queue.
 *
 * `buildQueue` is recomputed continuously — on every clock tick, and whenever a
 * learning step falls due — and each rebuild reshuffles the review pile and can
 * promote a newly-due learning card ahead of everything else. Neither should be
 * visible to someone mid-card: the queue behind position 0 may reorder freely,
 * but the card being looked at must not swap itself out.
 *
 * `activeKey` is the key of the card currently shown. If it is still present in
 * the rebuilt queue it is moved back to the front; if it has genuinely gone
 * (graded, or filtered out by a deck switch) the queue is left untouched and the
 * next card takes over.
 */
export function pinActive(queue: ReviewItem[], activeKey: string | null): ReviewItem[] {
  if (activeKey === null) return queue

  const index = queue.findIndex((item) => item.state.key === activeKey)
  if (index <= 0) return queue

  const active = queue[index]
  if (active === undefined) return queue

  return [active, ...queue.slice(0, index), ...queue.slice(index + 1)]
}
