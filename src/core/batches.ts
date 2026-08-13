/**
 * Merging per-batch card files into one vocabulary document.
 *
 * Cards are authored in small standalone files under `public/data/cards/`, one per
 * capture session — a chapter, an article, an episode. Adding vocabulary therefore
 * means *creating a new file*, never reading and rewriting the existing corpus.
 *
 * That distinction is the whole point. The main way cards get added is a Claude
 * session on a phone, working from photographs of book pages. Asking it to
 * read-modify-write a single growing file would mean pulling the entire collection
 * into context and re-emitting it in full on every capture: slow, expensive, and a
 * truncated response would silently drop words that were already there. Writing a
 * fresh 2 kB file cannot damage anything that already exists.
 *
 * A batch may declare `defaults` that apply to all of its cards, so `source` and
 * `chapter` are stated once rather than repeated on every entry.
 */

/** Fields a batch may set once for all of its cards. */
export interface BatchDefaults {
  source?: string
  chapter?: string
  added?: string
  /** Merged into each card's own tags rather than replacing them. */
  tags?: string[]
}

export interface BatchProblem {
  file: string
  message: string
}

export interface BatchInput {
  /** File name, so problems can be attributed to the batch that caused them. */
  name: string
  content: unknown
}

export interface MergeBatchesResult {
  /** Cards in batch order, defaults applied. Still unvalidated — see parseVocabFile. */
  cards: unknown[]
  /** `origins[i]` names the batch file that produced `cards[i]`. */
  origins: string[]
  problems: BatchProblem[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readDefaults(content: Record<string, unknown>): BatchDefaults {
  const raw = isPlainObject(content.defaults) ? content.defaults : {}
  const defaults: BatchDefaults = {}
  if (typeof raw.source === 'string') defaults.source = raw.source
  if (typeof raw.chapter === 'string') defaults.chapter = raw.chapter
  else if (typeof raw.chapter === 'number') defaults.chapter = String(raw.chapter)
  if (typeof raw.added === 'string') defaults.added = raw.added
  if (Array.isArray(raw.tags)) {
    defaults.tags = raw.tags.filter((tag): tag is string => typeof tag === 'string')
  }
  return defaults
}

/**
 * Applies batch defaults to one card.
 *
 * A value written on the card always wins — defaults fill gaps, they never
 * overwrite. Tags are the exception and are unioned, since a batch tag ("kapitel-5")
 * and a card tag ("verb") describe different things and both are wanted.
 */
export function applyDefaults(card: unknown, defaults: BatchDefaults): unknown {
  if (!isPlainObject(card)) return card
  const merged: Record<string, unknown> = { ...card }

  if (merged.source === undefined && defaults.source !== undefined) {
    merged.source = defaults.source
  }
  if (merged.chapter === undefined && defaults.chapter !== undefined) {
    merged.chapter = defaults.chapter
  }
  if (merged.added === undefined && defaults.added !== undefined) {
    merged.added = defaults.added
  }

  if (defaults.tags?.length) {
    const own = Array.isArray(merged.tags)
      ? merged.tags.filter((tag): tag is string => typeof tag === 'string')
      : []
    const combined = [...defaults.tags, ...own]
    // Preserve order while removing duplicates, so tags read predictably.
    merged.tags = [...new Set(combined)]
  }

  return merged
}

/**
 * Concatenates batch files into a single card list.
 *
 * Accepts either `{ defaults?, cards: [...] }` or a bare array of cards, because a
 * batch with nothing to declare should not need a wrapper. Structural validation is
 * deliberately left to `parseVocabFile` and the JSON Schema — this step only
 * assembles, so there is exactly one place that decides what a valid card is.
 */
export function mergeBatches(batches: BatchInput[]): MergeBatchesResult {
  const cards: unknown[] = []
  const origins: string[] = []
  const problems: BatchProblem[] = []

  for (const batch of batches) {
    let list: unknown[]
    let defaults: BatchDefaults = {}

    if (Array.isArray(batch.content)) {
      list = batch.content
    } else if (isPlainObject(batch.content)) {
      if (!Array.isArray(batch.content.cards)) {
        problems.push({
          file: batch.name,
          message: 'Batch has no "cards" array. Expected { "cards": [ … ] } or a bare array.',
        })
        continue
      }
      list = batch.content.cards
      defaults = readDefaults(batch.content)
    } else {
      problems.push({ file: batch.name, message: 'Batch is not a JSON object or array.' })
      continue
    }

    if (list.length === 0) {
      problems.push({ file: batch.name, message: 'Batch contains no cards.' })
    }

    for (const card of list) {
      cards.push(applyDefaults(card, defaults))
      origins.push(batch.name)
    }
  }

  return { cards, origins, problems }
}

/** Assembles the document the app fetches. Shape must match `VocabFile`. */
export function buildVocabDocument(
  cards: unknown[],
  decksDocument: unknown,
  schemaVersion: number,
): Record<string, unknown> {
  const source = isPlainObject(decksDocument) ? decksDocument : {}
  return {
    schemaVersion,
    meta: {
      ...(isPlainObject(source.meta) ? source.meta : {}),
      // Regenerated on every build; hand edits to vocab.json would be overwritten.
      generated: new Date().toISOString(),
    },
    decks: Array.isArray(source.decks) ? source.decks : [],
    cards,
  }
}

/** Cards from a batch, keyed for reporting. Used by the validator's error output. */
export function cardIdsByFile(
  cards: unknown[],
  origins: string[],
): Map<string, string> {
  const byId = new Map<string, string>()
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index]
    const origin = origins[index]
    if (!isPlainObject(card) || origin === undefined) continue
    const id = card.id
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, origin)
  }
  return byId
}
