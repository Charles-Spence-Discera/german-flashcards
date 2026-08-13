/**
 * Reading, migrating and normalising the vocab file.
 *
 * The vocab file is edited by hand and by Claude sessions over a long period, so its
 * shape is expected to drift. Two mechanisms absorb that drift:
 *
 * 1. **Versioned migrations.** The file carries a `schemaVersion`; the app carries an
 *    ordered chain of migration functions. A file written under any older version is
 *    upgraded in memory on load, so old files never stop working and retroactive
 *    restructuring is a migration function rather than a mass find-and-replace.
 * 2. **A tolerant reader.** Within a version, near-miss input is accepted and
 *    repaired — legacy field names, a comma-joined string where a list was expected,
 *    stray whitespace, unfamiliar part-of-speech spellings.
 *
 * Tolerance is deliberately asymmetric. At runtime on the phone, a single malformed
 * card must never blank the app, so bad cards are dropped and the rest load. In CI,
 * the same problems fail the build. Both policies read the same `problems` list —
 * see `scripts/validate-vocab.ts`.
 */

import type { Card, Deck, DeckFilter, PartOfSpeech, VocabFile, VocabMeta } from './types'

export interface Problem {
  /** `error` drops the card at runtime and fails the build; `warning` only reports. */
  level: 'error' | 'warning'
  /** Position in the source `cards` array, to locate the entry in the file. */
  index: number
  cardId?: string
  field?: string
  message: string
}

export interface ParseResult {
  file: VocabFile
  problems: Problem[]
  /** The version the source file was written at, before migration. */
  sourceVersion: number
}

/* -------------------------------------------------------------------------- */
/* Migrations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Migration at index `i` upgrades a file from version `i` to version `i + 1`.
 * Input and output are untyped on purpose: migrations operate on historical
 * shapes that no longer have a TypeScript type, and inventing one per version
 * costs more than it catches. `normalise` below is what enforces the current type.
 *
 * To evolve the schema: append a function here and bump nothing else — the current
 * version is derived from the length of this array, so the two cannot drift apart.
 */
type Migration = (input: any) => any

/**
 * v0 → v1. v0 is the original prototype format: either a bare array of cards or an
 * object with a `cards` array, no version marker, examples under `bookEx`, and no
 * concept of decks or tags.
 */
const v0ToV1: Migration = (input: any) => {
  const cards: any[] = Array.isArray(input)
    ? input
    : Array.isArray(input?.cards)
      ? input.cards
      : []

  return {
    schemaVersion: 1,
    cards: cards.map((card: any) => {
      if (card === null || typeof card !== 'object') return card
      const next = { ...card }
      // `bookEx` assumed every word came from a book. Sources are now books,
      // articles, podcasts and lessons alike, so the field is just "first example".
      if (next.bookEx !== undefined && next.ex1 === undefined) {
        next.ex1 = next.bookEx
      }
      delete next.bookEx
      return next
    }),
    decks: Array.isArray(input?.decks) ? input.decks : [],
    meta: input?.meta && typeof input.meta === 'object' ? input.meta : {},
  }
}

const MIGRATIONS: Migration[] = [v0ToV1]

/** The schema version this build writes and expects. Derived, never hand-maintained. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length

/**
 * A file with no version marker predates versioning entirely, so it is v0. A file
 * claiming a version newer than this build understands is left alone and reported —
 * guessing at a future shape is worse than refusing it.
 */
export function detectVersion(raw: unknown): number {
  if (Array.isArray(raw)) return 0
  if (raw !== null && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>).schemaVersion
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  }
  return 0
}

/** Runs the migration chain from the file's version up to the current one. */
export function migrate(raw: unknown): { migrated: any; sourceVersion: number } {
  const sourceVersion = detectVersion(raw)
  let current: any = raw
  for (let v = sourceVersion; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v]
    if (!step) break
    current = step(current)
  }
  return { migrated: current, sourceVersion }
}

/* -------------------------------------------------------------------------- */
/* Tolerant coercion helpers                                                   */
/* -------------------------------------------------------------------------- */

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Accepts a real array, or a single comma-separated string — Claude sessions and
 * hand edits both produce `"laufen, rennen"` where `["laufen", "rennen"]` was meant.
 */
function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map(asString)
      .filter((item): item is string => item !== undefined)
    return items.length > 0 ? items : undefined
  }
  const single = asString(value)
  if (single === undefined) return undefined
  const parts = single
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : undefined
}

const POS_ALIASES: Record<string, PartOfSpeech> = {
  noun: 'noun',
  n: 'noun',
  nomen: 'noun',
  substantiv: 'noun',
  verb: 'verb',
  v: 'verb',
  adj: 'adj',
  adjective: 'adj',
  adjektiv: 'adj',
  adv: 'adv',
  adverb: 'adv',
  phrase: 'phrase',
  idiom: 'phrase',
  expression: 'phrase',
  redewendung: 'phrase',
  other: 'other',
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Every field the current schema recognises. Anything else earns a warning. */
const KNOWN_CARD_FIELDS = new Set([
  'id',
  'de',
  'en',
  'pos',
  'forms',
  'syn',
  'ex1',
  'ex2',
  'notiz',
  'source',
  'chapter',
  'tags',
  'added',
  'prevIds',
  'suspended',
])

/* -------------------------------------------------------------------------- */
/* Card normalisation                                                          */
/* -------------------------------------------------------------------------- */

function normaliseCard(
  input: unknown,
  index: number,
  problems: Problem[],
): Card | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    problems.push({
      level: 'error',
      index,
      message: 'Entry is not an object.',
    })
    return null
  }

  const raw = input as Record<string, unknown>
  const id = asString(raw.id)
  const de = asString(raw.de)
  const en = asString(raw.en)

  // The three fields without which a card cannot exist: nothing to key progress
  // on, nothing to show on the front, nothing to show on the back.
  if (id === undefined) {
    problems.push({
      level: 'error',
      index,
      field: 'id',
      message: `Missing "id"${de ? ` (German word: "${de}")` : ''}.`,
    })
    return null
  }
  if (de === undefined) {
    problems.push({ level: 'error', index, cardId: id, field: 'de', message: 'Missing "de".' })
    return null
  }
  if (en === undefined) {
    problems.push({ level: 'error', index, cardId: id, field: 'en', message: 'Missing "en".' })
    return null
  }

  const card: Card = { id, de, en }

  const posRaw = asString(raw.pos)
  if (posRaw !== undefined) {
    const pos = POS_ALIASES[posRaw.toLowerCase()]
    if (pos === undefined) {
      problems.push({
        level: 'warning',
        index,
        cardId: id,
        field: 'pos',
        message: `Unrecognised part of speech "${posRaw}", treated as "other".`,
      })
      card.pos = 'other'
    } else {
      card.pos = pos
    }
  }

  // `bookEx` is migrated away at v0→v1, but a Claude session working from an older
  // example may still emit it into a current-version file. Accept it, and say so.
  if (raw.bookEx !== undefined && raw.ex1 === undefined) {
    const legacy = asString(raw.bookEx)
    if (legacy !== undefined) {
      problems.push({
        level: 'warning',
        index,
        cardId: id,
        field: 'bookEx',
        message: 'Legacy field "bookEx" used; it has been read as "ex1". Prefer "ex1".',
      })
      card.ex1 = legacy
    }
  }

  const forms = asString(raw.forms)
  if (forms !== undefined) card.forms = forms
  const ex1 = asString(raw.ex1)
  if (ex1 !== undefined) card.ex1 = ex1
  const ex2 = asString(raw.ex2)
  if (ex2 !== undefined) card.ex2 = ex2
  const notiz = asString(raw.notiz)
  if (notiz !== undefined) card.notiz = notiz
  const source = asString(raw.source)
  if (source !== undefined) card.source = source

  // Chapters are free text so that "4", "Kap. 4" and "Episode 12" all work, but a
  // bare number in JSON is a natural thing to write, so coerce rather than reject.
  const chapterRaw = raw.chapter
  const chapter =
    typeof chapterRaw === 'number' ? String(chapterRaw) : asString(chapterRaw)
  if (chapter !== undefined) card.chapter = chapter

  const syn = asStringArray(raw.syn)
  if (syn !== undefined) card.syn = syn
  const tags = asStringArray(raw.tags)
  if (tags !== undefined) card.tags = tags
  const prevIds = asStringArray(raw.prevIds)
  if (prevIds !== undefined) card.prevIds = prevIds

  const added = asString(raw.added)
  if (added !== undefined) {
    if (!ISO_DATE.test(added)) {
      problems.push({
        level: 'warning',
        index,
        cardId: id,
        field: 'added',
        message: `"added" should be YYYY-MM-DD, got "${added}".`,
      })
    } else {
      card.added = added
    }
  }

  if (raw.suspended !== undefined) {
    if (typeof raw.suspended !== 'boolean') {
      problems.push({
        level: 'warning',
        index,
        cardId: id,
        field: 'suspended',
        message: '"suspended" should be true or false; ignored.',
      })
    } else if (raw.suspended) {
      card.suspended = true
    }
  }

  for (const field of Object.keys(raw)) {
    if (!KNOWN_CARD_FIELDS.has(field) && field !== 'bookEx') {
      problems.push({
        level: 'warning',
        index,
        cardId: id,
        field,
        message: `Unknown field "${field}" — kept out of the app. Add it to the schema if it is meant to be used.`,
      })
    }
  }

  return card
}

/* -------------------------------------------------------------------------- */
/* Deck normalisation                                                          */
/* -------------------------------------------------------------------------- */

function normaliseDeck(input: unknown, index: number, problems: Problem[]): Deck | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    problems.push({ level: 'warning', index, message: 'Deck entry is not an object; ignored.' })
    return null
  }
  const raw = input as Record<string, unknown>
  const id = asString(raw.id)
  const name = asString(raw.name)
  if (id === undefined || name === undefined) {
    problems.push({
      level: 'warning',
      index,
      message: 'Deck needs both "id" and "name"; ignored.',
    })
    return null
  }

  const filterRaw =
    raw.filter !== null && typeof raw.filter === 'object' && !Array.isArray(raw.filter)
      ? (raw.filter as Record<string, unknown>)
      : {}

  const filter: DeckFilter = {}
  const sources = asStringArray(filterRaw.sources)
  if (sources) filter.sources = sources
  const chapters = asStringArray(filterRaw.chapters)
  if (chapters) filter.chapters = chapters
  const tags = asStringArray(filterRaw.tags)
  if (tags) filter.tags = tags
  const ids = asStringArray(filterRaw.ids)
  if (ids) filter.ids = ids

  return { id, name, filter }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parses raw JSON into a `VocabFile`, migrating and normalising along the way.
 *
 * Always returns a usable file. Cards with `error`-level problems are omitted from
 * the result; callers that need strictness inspect `problems` themselves.
 */
export function parseVocabFile(raw: unknown): ParseResult {
  const problems: Problem[] = []
  const sourceVersion = detectVersion(raw)

  if (sourceVersion > CURRENT_SCHEMA_VERSION) {
    problems.push({
      level: 'error',
      index: -1,
      message:
        `File declares schemaVersion ${sourceVersion} but this build understands up to ` +
        `${CURRENT_SCHEMA_VERSION}. Update the app before editing this file.`,
    })
    return {
      file: { schemaVersion: CURRENT_SCHEMA_VERSION, cards: [], decks: [], meta: {} },
      problems,
      sourceVersion,
    }
  }

  const { migrated } = migrate(raw)

  if (migrated === null || typeof migrated !== 'object' || Array.isArray(migrated)) {
    problems.push({ level: 'error', index: -1, message: 'Vocab file is not a JSON object.' })
    return {
      file: { schemaVersion: CURRENT_SCHEMA_VERSION, cards: [], decks: [], meta: {} },
      problems,
      sourceVersion,
    }
  }

  const rawCards = Array.isArray(migrated.cards) ? migrated.cards : []
  if (!Array.isArray(migrated.cards)) {
    problems.push({ level: 'error', index: -1, message: 'Missing "cards" array.' })
  }

  const cards: Card[] = []
  // Source position of each accepted card, so every Problem.index refers to the
  // entry as written rather than to a position in the filtered result. Callers use
  // it to attribute problems back to a file and line.
  const sourceIndexOf: number[] = []
  const seenIds = new Map<string, number>()

  for (let index = 0; index < rawCards.length; index++) {
    const card = normaliseCard(rawCards[index], index, problems)
    if (card === null) continue

    const firstSeenAt = seenIds.get(card.id)
    if (firstSeenAt !== undefined) {
      // Two cards sharing an id would share review history and overwrite each
      // other unpredictably. Keep the first, reject the duplicate.
      problems.push({
        level: 'error',
        index,
        cardId: card.id,
        field: 'id',
        message: `Duplicate id "${card.id}" (first used at entry ${firstSeenAt}).`,
      })
      continue
    }
    seenIds.set(card.id, index)
    cards.push(card)
    sourceIndexOf.push(index)
  }

  // Two ways a `prevIds` entry can be ambiguous about who inherits review history,
  // both of which would silently hand months of scheduling to the wrong card.
  const claimedBy = new Map<string, string>()
  for (let position = 0; position < cards.length; position++) {
    const card = cards[position]
    const index = sourceIndexOf[position] ?? position
    if (!card?.prevIds) continue
    for (const prev of card.prevIds) {
      // (1) The old id is still a live card, so it is not clear the card was renamed.
      if (seenIds.has(prev)) {
        problems.push({
          level: 'error',
          index,
          cardId: card.id,
          field: 'prevIds',
          message: `"${prev}" is listed as a previous id but is also a live card id.`,
        })
      }
      // (2) Two different cards both claim to be the renamed version of it.
      const other = claimedBy.get(prev)
      if (other !== undefined) {
        problems.push({
          level: 'error',
          index,
          cardId: card.id,
          field: 'prevIds',
          message: `Previous id "${prev}" is also claimed by card "${other}".`,
        })
      } else {
        claimedBy.set(prev, card.id)
      }
    }
  }

  const rawDecks = Array.isArray(migrated.decks) ? migrated.decks : []
  const decks: Deck[] = []
  const seenDeckIds = new Set<string>()
  for (let index = 0; index < rawDecks.length; index++) {
    const deck = normaliseDeck(rawDecks[index], index, problems)
    if (deck === null) continue
    if (seenDeckIds.has(deck.id)) {
      problems.push({
        level: 'warning',
        index,
        message: `Duplicate deck id "${deck.id}"; ignored.`,
      })
      continue
    }
    seenDeckIds.add(deck.id)
    decks.push(deck)
  }

  const meta: VocabMeta =
    migrated.meta !== null && typeof migrated.meta === 'object' && !Array.isArray(migrated.meta)
      ? (migrated.meta as VocabMeta)
      : {}

  return {
    file: { schemaVersion: CURRENT_SCHEMA_VERSION, cards, decks, meta },
    problems,
    sourceVersion,
  }
}

/** True if any problem would drop a card or block a build. */
export function hasErrors(problems: Problem[]): boolean {
  return problems.some((problem) => problem.level === 'error')
}

/** Renders a problem as a single readable line for CI output or the console. */
export function formatProblem(problem: Problem): string {
  const where =
    problem.cardId !== undefined
      ? `card "${problem.cardId}"`
      : problem.index >= 0
        ? `entry ${problem.index}`
        : 'file'
  const field = problem.field !== undefined ? ` [${problem.field}]` : ''
  return `${problem.level === 'error' ? 'ERROR' : 'warn '}  ${where}${field}: ${problem.message}`
}
