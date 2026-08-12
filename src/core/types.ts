/**
 * Shared domain types.
 *
 * The central distinction in this app is between a **Card** and a **ReviewItem**:
 *
 * - A Card is a piece of vocabulary content. It lives in `public/data/vocab.json`,
 *   is authored by hand or by a Claude session, and is freely editable. Every field
 *   on it except `id` may change at any time.
 * - A ReviewItem is one *testable direction* of a card (German→English today;
 *   English→German, cloze and typed modes later), each carrying its own independent
 *   scheduling state.
 *
 * Keeping them separate is what makes new study modes additive: introducing
 * English→German generates new items rather than disturbing the German→English
 * history that already exists.
 */

/** Coarse part of speech. Drives how `forms` is labelled, and later cloze generation. */
export type PartOfSpeech = 'noun' | 'verb' | 'adj' | 'adv' | 'phrase' | 'other'

/**
 * A single vocabulary entry.
 *
 * `id` is the only immutable field and the only thing review progress is keyed on.
 * Rewriting a translation, an example, a deck name or a tag never costs review
 * history. If an id genuinely must change, list the old one in `prevIds` and the
 * merge step will carry the history across instead of resetting it.
 */
export interface Card {
  /** Stable slug. Immutable — see `prevIds` to rename safely. */
  id: string
  /** German headword, as it would appear in a dictionary. */
  de: string
  /** English translation. */
  en: string
  pos?: PartOfSpeech
  /** Gender + plural for nouns, Präteritum + Partizip II for verbs. */
  forms?: string
  syn?: string[]
  /** Contextualised example sentence, from wherever the word was encountered. */
  ex1?: string
  /** Plain everyday example sentence. */
  ex2?: string
  /** Register notes, false friends, case patterns. */
  notiz?: string
  /** Where the word came from: a book, article, podcast, lesson. */
  source?: string
  /** Subdivision of the source — chapter, episode, page. Free text. */
  chapter?: string
  /** Arbitrary labels, so new ways of organising need no schema change. */
  tags?: string[]
  /** ISO date (YYYY-MM-DD) the card was added. */
  added?: string
  /** Former ids for this card, so a rename migrates history instead of losing it. */
  prevIds?: string[]
  /** Excluded from review queues but retained, along with its history. */
  suspended?: boolean
}

/**
 * A deck is a saved filter, not a container. Cards are never "in" a deck; a deck
 * describes which cards it selects. This is stored as data so that reorganising
 * the collection is a vocab-file edit rather than a code change.
 *
 * An empty filter matches everything.
 */
export interface Deck {
  id: string
  name: string
  filter: DeckFilter
}

/** Fields within a filter are ANDed; values within a field are ORed. */
export interface DeckFilter {
  sources?: string[]
  chapters?: string[]
  tags?: string[]
  /** Explicit card ids, for hand-picked decks. */
  ids?: string[]
}

/** The on-disk vocab file, after migration to the current schema version. */
export interface VocabFile {
  schemaVersion: number
  cards: Card[]
  decks: Deck[]
  meta: VocabMeta
}

export interface VocabMeta {
  /** ISO timestamp of the last edit, informational only. */
  updated?: string
  /** Free-form note from whoever last edited the file. */
  note?: string
}

/**
 * A testable direction of a card. Only `de-en` is generated today; the rest are
 * declared now so that stored progress, export files and the scheduler are already
 * shaped to accept them without a migration when they ship.
 */
export type ItemMode = 'de-en' | 'en-de' | 'cloze1' | 'cloze2' | 'typed-de'

/** Lifecycle phase of an item, in SM-2 terms. */
export type Phase = 'new' | 'learning' | 'review' | 'relearning'

/** The four self-assessment grades. */
export type Grade = 'again' | 'hard' | 'good' | 'easy'

/**
 * Scheduling state for one review item. Persisted in IndexedDB and keyed by
 * `key` (see `itemKey`), never by array position or content hash.
 */
export interface ReviewState {
  /** `${cardId}::${mode}` — the storage key. */
  key: string
  cardId: string
  mode: ItemMode
  phase: Phase
  /** SM-2 ease factor. Floored at 1.3. */
  ease: number
  /** Current review interval in days. 0 until the item graduates. */
  intervalDays: number
  /** Position on the learning-steps ladder; -1 once graduated. */
  learningStep: number
  /** ISO timestamp when the item next becomes due. */
  due: string
  /** ISO timestamp of the most recent review, or null if never reviewed. */
  lastReviewed: string | null
  /** Total number of reviews. */
  reps: number
  /** Number of times this item was forgotten after graduating. */
  lapses: number
}

/** A card paired with the scheduling state for one of its modes, ready to review. */
export interface ReviewItem {
  card: Card
  state: ReviewState
}

/** A logged review, kept so scheduling can be rebuilt or analysed later. */
export interface ReviewLogEntry {
  key: string
  /** ISO timestamp of the review. */
  at: string
  grade: Grade
  /**
   * Phase the item was in *before* this review. Daily caps are derived from this —
   * `new` counts against the new-cards limit, `review` against the reviews limit,
   * and learning steps count against neither. Deriving the counts from the log
   * rather than storing running totals means they can never drift out of sync.
   */
  phaseBefore: Phase
  /** Interval in days *before* this review, for retention analysis. */
  prevIntervalDays: number
  /** Interval in days assigned by this review. */
  nextIntervalDays: number
  /** Milliseconds spent on the card, if measured. */
  elapsedMs?: number
}
