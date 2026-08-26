/**
 * App settings, kept separate from scheduler tuning so the two can evolve apart.
 */

import { DEFAULT_SETTINGS, type SchedulerSettings } from './scheduler'

/**
 * How a session treats several modes of the same word.
 *
 * `breadth` sends a word's later modes to the back of the queue, so a session covers
 * as many distinct words as possible. `depth` leaves them where they fall, so a word
 * can be met three ways in one sitting. Neither is better — it depends on whether the
 * day is about keeping up with the book or about drilling what is already there.
 */
export type SessionMode = 'breadth' | 'depth'

export interface AppSettings {
  /** Fixed primary key — there is only ever one settings record. */
  id: 'settings'
  /** Cap on previously unseen vocabulary introduced per study day. */
  newPerDay: number
  /** Cap on graduated items reviewed per study day. Learning steps are never capped. */
  maxReviewsPerDay: number
  /**
   * Cap on *newly unlocked* Aufbau items introduced per study day, budgeted apart
   * from `newPerDay` so that level-ups and fresh vocabulary never crowd each other
   * out. 0 pauses unlocking without losing any progress already made.
   *
   * This limits intake, not load: once introduced, an Aufbau item returns on its own
   * schedule like anything else and counts against `maxReviewsPerDay`.
   */
  aufbauPerDay: number
  /**
   * How stable a card's `de-en` interval must be, in days, before its productive
   * modes unlock. Lower means the collection deepens sooner and harder.
   */
  aufbauThresholdDays: number
  /** Whether a session favours covering ground or drilling the same word. */
  sessionMode: SessionMode
  /** Deck currently being studied, or null for everything. */
  activeDeckId: string | null
  scheduler: SchedulerSettings
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  id: 'settings',
  newPerDay: 15,
  maxReviewsPerDay: 200,
  aufbauPerDay: 5,
  aufbauThresholdDays: 5,
  sessionMode: 'breadth',
  activeDeckId: null,
  scheduler: DEFAULT_SETTINGS,
}

/** Keeps a stored or hand-edited count inside a range the queue can act on. */
function clampCount(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(0, Math.round(value)))
}

/**
 * Fills in anything missing from a stored settings record.
 *
 * Settings are persisted on a device and read back by whatever version of the app
 * happens to be installed later, so a record written by an older build will be
 * missing keys that newer code expects. Merging against the defaults means adding a
 * setting never requires a storage migration.
 *
 * Note that which modes exist is deliberately *not* a setting. It is derived per
 * card from review history (see `isModeUnlocked`), so an old stored record cannot
 * pin the collection to the single mode that existed when it was written.
 */
export function withDefaults(stored: Partial<AppSettings> | null | undefined): AppSettings {
  if (!stored) return { ...DEFAULT_APP_SETTINGS }
  return {
    ...DEFAULT_APP_SETTINGS,
    ...stored,
    id: 'settings',
    newPerDay: clampCount(stored.newPerDay, DEFAULT_APP_SETTINGS.newPerDay, 500),
    maxReviewsPerDay: clampCount(
      stored.maxReviewsPerDay,
      DEFAULT_APP_SETTINGS.maxReviewsPerDay,
      2000,
    ),
    aufbauPerDay: clampCount(stored.aufbauPerDay, DEFAULT_APP_SETTINGS.aufbauPerDay, 500),
    aufbauThresholdDays: Math.max(
      1,
      clampCount(stored.aufbauThresholdDays, DEFAULT_APP_SETTINGS.aufbauThresholdDays, 365),
    ),
    sessionMode: stored.sessionMode === 'depth' ? 'depth' : 'breadth',
    scheduler: { ...DEFAULT_SETTINGS, ...(stored.scheduler ?? {}) },
  }
}
