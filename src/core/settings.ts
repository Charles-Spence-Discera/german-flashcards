/**
 * App settings, kept separate from scheduler tuning so the two can evolve apart.
 */

import { DEFAULT_SETTINGS, type SchedulerSettings } from './scheduler'
import type { ItemMode } from './types'

export interface AppSettings {
  /** Fixed primary key — there is only ever one settings record. */
  id: 'settings'
  /** Cap on previously unseen items introduced per study day. */
  newPerDay: number
  /** Cap on graduated items reviewed per study day. Learning steps are never capped. */
  maxReviewsPerDay: number
  /** Which testable directions are generated. Adding one is non-destructive. */
  activeModes: ItemMode[]
  /** Deck currently being studied, or null for everything. */
  activeDeckId: string | null
  scheduler: SchedulerSettings
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  id: 'settings',
  newPerDay: 15,
  maxReviewsPerDay: 200,
  activeModes: ['de-en'],
  activeDeckId: null,
  scheduler: DEFAULT_SETTINGS,
}

/**
 * Fills in anything missing from a stored settings record.
 *
 * Settings are persisted on a device and read back by whatever version of the app
 * happens to be installed later, so a record written by an older build will be
 * missing keys that newer code expects. Merging against the defaults means adding a
 * setting never requires a storage migration.
 */
export function withDefaults(stored: Partial<AppSettings> | null | undefined): AppSettings {
  if (!stored) return { ...DEFAULT_APP_SETTINGS }
  return {
    ...DEFAULT_APP_SETTINGS,
    ...stored,
    id: 'settings',
    activeModes:
      Array.isArray(stored.activeModes) && stored.activeModes.length > 0
        ? stored.activeModes
        : DEFAULT_APP_SETTINGS.activeModes,
    scheduler: { ...DEFAULT_SETTINGS, ...(stored.scheduler ?? {}) },
  }
}
