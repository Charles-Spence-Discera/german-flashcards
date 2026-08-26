/**
 * The mode ladder: which testable directions a card has earned.
 *
 * A card does not arrive with all of its modes. It starts as recognition only —
 * German shown, English recalled — and earns the harder, productive directions once
 * that recognition is demonstrably stable. This is what makes the collection deepen
 * on its own instead of being either uniformly shallow or overwhelming from day one.
 *
 * The rule is **unlock, never promote**. A matured `de-en` item does not become an
 * `en-de` item; it causes a *second*, independent item to be born. That matters
 * because recognising a word is not evidence of being able to produce it: promoting
 * would hand a ten-day interval to a task that has never been attempted, and the
 * inevitable lapse would take the recognition history down with it. Unlocking keeps
 * the two schedules entirely separate, so failing to spell a word costs nothing that
 * was already earned.
 *
 * Unlocking is also **latched**. Once an item exists it is generated forever, even
 * if the parent later lapses back below the threshold. A bad week should not make
 * work disappear, and re-locking would strand stored progress outside the queue.
 */

import type { Card, ItemMode, ReviewState } from './types'

/** The direction every card is born with. Never gated. */
export const BASE_MODE: ItemMode = 'de-en'

/**
 * Modes earned through maturity rather than granted at the start. Both unlock
 * together: they share a prompt (the English) and differ only in whether the answer
 * is typed, so there is no reason to stagger them.
 */
export const AUFBAU_MODES: readonly ItemMode[] = ['en-de', 'typed-de']

/** Every mode this build can generate, in the order a card acquires them. */
export const ALL_MODES: readonly ItemMode[] = [BASE_MODE, ...AUFBAU_MODES]

export function isAufbauMode(mode: ItemMode): boolean {
  return AUFBAU_MODES.includes(mode)
}

/**
 * User-facing names. Direction-based where the direction is the whole point, and
 * action-based where it is not, so they stay self-explanatory without a legend.
 */
const MODE_LABELS: Record<ItemMode, string> = {
  'de-en': 'Deutsch → Englisch',
  'en-de': 'Englisch → Deutsch',
  'typed-de': 'Schreiben',
  cloze1: 'Lücke',
  cloze2: 'Lücke 2',
}

export function modeLabel(mode: ItemMode): string {
  return MODE_LABELS[mode] ?? mode
}

/** Looks up whatever progress a card already has in a given mode. */
export type StateLookup = (mode: ItemMode) => ReviewState | undefined

/**
 * Whether `mode` should exist for this card yet.
 *
 * Reads only stored progress, never the vocabulary content, so the answer cannot
 * change because a translation was edited.
 */
export function isModeUnlocked(
  _card: Card,
  mode: ItemMode,
  stateFor: StateLookup,
  thresholdDays: number,
): boolean {
  if (!isAufbauMode(mode)) return true

  // Latched: an item that already exists keeps existing.
  if (stateFor(mode) !== undefined) return true

  const base = stateFor(BASE_MODE)
  if (base === undefined) return false

  // Interval rather than reps: what matters is that the word survived a real gap,
  // not that it was answered often in one sitting.
  return base.phase === 'review' && base.intervalDays >= thresholdDays
}
