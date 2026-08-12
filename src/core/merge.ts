/**
 * Joining vocab content to review progress.
 *
 * Two sources of truth meet here, and the split between them is the whole design:
 *
 * - `public/data/vocab.json` owns **content**. It is edited freely, by hand or by a
 *   Claude session, and is replaced wholesale on every app load.
 * - IndexedDB owns **progress**. It is written only by reviewing, and is never
 *   derived from the vocab file.
 *
 * They are joined on `Card.id` and nothing else. That is what lets a translation be
 * corrected, an example rewritten, a deck renamed or a tag added without touching
 * scheduling. The inverse is also enforced: content edits never write progress, and
 * a card disappearing from the file never deletes progress — it is retained as an
 * orphan, so removing a card by accident and restoring it later costs nothing.
 *
 * The one case where progress does move is a declared rename: a card listing an old
 * id in `prevIds` inherits that id's scheduling state.
 */

import { itemKey, type Scheduler } from './scheduler'
import type { Card, ItemMode, ReviewItem, ReviewState } from './types'

export interface MergeInput {
  /** Cards from the vocab file, already normalised. */
  cards: Card[]
  /** Everything currently in storage, keyed by `ReviewState.key`. */
  stored: Map<string, ReviewState>
  /** Modes to generate items for. Adding one here creates items; it destroys none. */
  modes: ItemMode[]
  scheduler: Scheduler
  now?: Date
}

export interface MergeStats {
  cards: number
  /** Cards excluded from review by `suspended`, whose progress is left untouched. */
  suspended: number
  /** Items whose stored progress was found and reused unchanged. */
  itemsExisting: number
  /** Items seen for the first time, given fresh scheduling state. */
  itemsCreated: number
  /** Items whose progress was carried across a declared id rename. */
  itemsRenamed: number
  /** Stored states whose card is no longer in the vocab file. Retained, never deleted. */
  orphaned: number
  /** Stored states for a live card in a mode not currently active. Retained. */
  inactiveMode: number
}

export interface MergeResult {
  /** Live cards joined to their scheduling state, ready for the queue. */
  items: ReviewItem[]
  /** States that must be written back: newly created ones and renamed ones. */
  toPersist: ReviewState[]
  /** Keys safe to delete — only ever the old side of a completed rename. */
  toDelete: string[]
  /** Progress for cards absent from the vocab file. Kept so a removal is reversible. */
  orphaned: ReviewState[]
  stats: MergeStats
}

/**
 * Produces the working set of review items.
 *
 * Deliberately pure: it reads a snapshot of storage and returns what *should* be
 * written, rather than writing anything itself. That keeps the risky part — deciding
 * what happens to existing progress — fully testable without a database.
 */
export function mergeProgress(input: MergeInput): MergeResult {
  const { cards, stored, modes, scheduler } = input
  const now = input.now ?? new Date()

  const liveCardIds = new Set(cards.map((card) => card.id))

  /**
   * Every key owned by a card currently in the vocab file, suspended or not. A
   * rename may never inherit one of these: if the old id is still present, the card
   * was not renamed and its history is not going anywhere. Computed up front so the
   * protection does not depend on the order cards happen to appear in the file.
   */
  const liveKeys = new Set<string>()
  for (const card of cards) {
    for (const mode of modes) liveKeys.add(itemKey(card.id, mode))
  }

  const items: ReviewItem[] = []
  const toPersist: ReviewState[] = []
  const toDelete: string[] = []

  /**
   * Stored keys that a live card has taken responsibility for, either by owning them
   * or by inheriting them through a rename. Anything left unclaimed at the end is
   * examined for orphanhood. Tracking this also stops two cards inheriting the same
   * history when a vocab file slips through with conflicting `prevIds`.
   */
  const claimedKeys = new Set<string>()

  let suspended = 0
  let itemsExisting = 0
  let itemsCreated = 0
  let itemsRenamed = 0

  for (const card of cards) {
    if (card.suspended) {
      suspended++
      // A suspended card produces no items but keeps its place. Claiming its keys
      // keeps them out of the orphan report; `liveKeys` is what stops a rename
      // inheriting them.
      for (const mode of modes) claimedKeys.add(itemKey(card.id, mode))
      continue
    }

    for (const mode of modes) {
      const key = itemKey(card.id, mode)

      const existing = stored.get(key)
      if (existing !== undefined) {
        claimedKeys.add(key)
        // The card object is fresh from the file while the state is untouched from
        // storage — this pairing *is* the content/progress split.
        items.push({ card, state: existing })
        itemsExisting++
        continue
      }

      // No progress under the current id. Before treating the item as new, honour a
      // declared rename. First matching previous id wins, so listing several is a
      // safe way to describe a chain of renames.
      let inherited: ReviewState | undefined
      for (const previousId of card.prevIds ?? []) {
        const previousKey = itemKey(previousId, mode)
        if (liveKeys.has(previousKey) || claimedKeys.has(previousKey)) continue
        const previousState = stored.get(previousKey)
        if (previousState === undefined) continue
        inherited = { ...previousState, key, cardId: card.id }
        claimedKeys.add(previousKey)
        toDelete.push(previousKey)
        break
      }

      const state = inherited ?? scheduler.newState(card.id, mode, now)
      claimedKeys.add(key)
      toPersist.push(state)
      items.push({ card, state })
      if (inherited !== undefined) itemsRenamed++
      else itemsCreated++
    }
  }

  const orphaned: ReviewState[] = []
  let inactiveMode = 0
  for (const state of stored.values()) {
    if (claimedKeys.has(state.key)) continue
    if (liveCardIds.has(state.cardId)) {
      // The card is present but this mode is not currently generated — for example
      // English→German progress from a build where that mode was enabled. Leave it
      // alone; turning the mode back on must restore it intact.
      inactiveMode++
      continue
    }
    orphaned.push(state)
  }

  return {
    items,
    toPersist,
    toDelete,
    orphaned,
    stats: {
      cards: cards.length,
      suspended,
      itemsExisting,
      itemsCreated,
      itemsRenamed,
      orphaned: orphaned.length,
      inactiveMode,
    },
  }
}
