/**
 * The card on screen must survive a background rebuild.
 *
 * `queue.pin.test.ts` covers `pinActive` on its own, which is why it missed this:
 * in isolation the active card is always present in the queue handed to it, and
 * the guard for an absent card reads as correct. What the app does is
 * `buildQueue` *then* `pinActive`, on a timer, and `buildQueue` can drop the
 * active card before `pinActive` ever sees it — shuffling the review pile before
 * cutting it to the daily cap means the draw decides membership, not just order.
 * These tests therefore run the pair together, over many rebuilds, the way the
 * clock tick does.
 */

import { describe, expect, it } from 'vitest'
import { buildQueue, pinActive } from './queue'
import { itemKey } from './scheduler'
import { DEFAULT_APP_SETTINGS } from './settings'
import type { Card, ReviewItem, ReviewState } from './types'

const NOW = new Date('2026-09-04T06:00:00.000Z')
const DAY = 86_400_000
const SEED = new Date('2026-09-04T02:00:00.000Z').getTime()

function dueReview(id: string): ReviewItem {
  const state: ReviewState = {
    key: itemKey(id, 'de-en'),
    cardId: id,
    mode: 'de-en',
    phase: 'review',
    ease: 2.5,
    intervalDays: 10,
    learningStep: -1,
    due: new Date(NOW.getTime() - DAY).toISOString(),
    lastReviewed: '2026-08-25T06:00:00.000Z',
    reps: 5,
    lapses: 0,
  }
  return { card: { id, de: id, en: `${id} (en)` } as Card, state }
}

/**
 * Runs the queue the way the app does: rebuild, pin, read the front, remember it
 * for the next rebuild. No grading, no input — only the clock advancing.
 */
function swapsAcrossTicks(dueCount: number, cap: number, ticks = 200): number {
  const items = Array.from({ length: dueCount }, (_, i) => dueReview(`c${i}`))
  const input = {
    items,
    settings: { ...DEFAULT_APP_SETTINGS, maxReviewsPerDay: cap },
    doneToday: { introduced: 0, aufbauIntroduced: 0, reviewed: 0 },
    now: NOW,
    seed: SEED,
  }

  let activeKey: string | null = null
  let swaps = 0
  for (let tick = 0; tick < ticks; tick++) {
    const queue = pinActive(buildQueue(input), activeKey)
    const front = queue[0]?.state.key ?? null
    if (activeKey !== null && front !== activeKey) swaps++
    activeKey = front
  }
  return swaps
}

describe('the queue across background rebuilds', () => {
  it('holds the active card when the whole pile fits inside the cap', () => {
    expect(swapsAcrossTicks(40, 200)).toBe(0)
  })

  it('holds the active card when more cards are due than the cap allows', () => {
    // The reported bug, at the numbers it was found at: 70 due against a cap of
    // 50 re-drew 20 cards on every tick, giving the card on screen a 29% chance
    // of being cut roughly every five seconds.
    expect(swapsAcrossTicks(70, 50)).toBe(0)
  })

  it('holds the active card when the cap is far below the pile', () => {
    expect(swapsAcrossTicks(200, 10)).toBe(0)
  })

  it('still draws a capped session, rather than keeping everything', () => {
    const items = Array.from({ length: 70 }, (_, i) => dueReview(`c${i}`))
    const input = {
      items,
      settings: { ...DEFAULT_APP_SETTINGS, maxReviewsPerDay: 50 },
      doneToday: { introduced: 0, aufbauIntroduced: 0, reviewed: 0 },
      now: NOW,
      seed: SEED,
    }
    expect(buildQueue(input)).toHaveLength(50)
  })

  it('draws a different session on a different day', () => {
    const items = Array.from({ length: 70 }, (_, i) => dueReview(`c${i}`))
    const base = {
      items,
      settings: { ...DEFAULT_APP_SETTINGS, maxReviewsPerDay: 50 },
      doneToday: { introduced: 0, aufbauIntroduced: 0, reviewed: 0 },
      now: NOW,
    }
    const today = buildQueue({ ...base, seed: SEED }).map((item) => item.state.key)
    const tomorrow = buildQueue({ ...base, seed: SEED + DAY }).map((item) => item.state.key)
    expect(tomorrow).not.toEqual(today)
  })
})
