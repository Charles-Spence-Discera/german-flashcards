/**
 * Reading the batch files off disk and assembling them.
 *
 * Shared by `build-vocab.ts` (which writes the result) and `validate-vocab.ts`
 * (which checks it). They must never disagree about what the build would produce,
 * so both go through this one path and the validator assembles in memory rather
 * than inspecting a previously generated file.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVocabDocument, mergeBatches, type BatchInput } from '../src/core/batches'
import { CURRENT_SCHEMA_VERSION } from '../src/core/schema'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = join(ROOT, 'public', 'data')
export const CARDS_DIR = join(DATA_DIR, 'cards')
export const DECKS_PATH = join(DATA_DIR, 'decks.json')
export const VOCAB_PATH = join(DATA_DIR, 'vocab.json')
export const SCHEMA_PATH = join(DATA_DIR, 'schema.json')

export interface FileProblem {
  file: string
  message: string
}

export interface LoadedSources {
  batches: BatchInput[]
  decks: unknown
  /** Files that could not be read or parsed at all. */
  fatal: FileProblem[]
}

function parseJsonFile(path: string, label: string, fatal: FileProblem[]): unknown | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    fatal.push({ file: label, message: 'Cannot read file.' })
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    // Almost always a trailing or missing comma; the parser's position finds it
    // far faster than reading the file does.
    fatal.push({
      file: label,
      message: `Not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    })
    return undefined
  }
}

/**
 * Loads every batch under `cards/` plus the decks document.
 *
 * Batches are read in filename order, which is why the naming convention is
 * date-prefixed: cards end up in the order they were captured, and new cards are
 * introduced in reading order rather than at random.
 */
export function loadVocabSources(): LoadedSources {
  const fatal: FileProblem[] = []

  let names: string[] = []
  try {
    names = readdirSync(CARDS_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    fatal.push({ file: 'public/data/cards/', message: 'Directory is missing.' })
  }

  const batches: BatchInput[] = []
  for (const name of names) {
    const content = parseJsonFile(join(CARDS_DIR, name), `cards/${name}`, fatal)
    if (content !== undefined) batches.push({ name: `cards/${name}`, content })
  }

  const decks = parseJsonFile(DECKS_PATH, 'decks.json', fatal)

  return { batches, decks: decks ?? {}, fatal }
}

export interface AssembledVocab {
  /** The document that will be written to vocab.json. */
  document: Record<string, unknown>
  cards: unknown[]
  /** `origins[i]` names the batch file that produced `cards[i]`. */
  origins: string[]
  problems: FileProblem[]
}

/** Assembles the sources exactly as the build would, without writing anything. */
export function assembleVocab(sources: LoadedSources): AssembledVocab {
  const merged = mergeBatches(sources.batches)
  return {
    document: buildVocabDocument(merged.cards, sources.decks, CURRENT_SCHEMA_VERSION),
    cards: merged.cards,
    origins: merged.origins,
    problems: merged.problems,
  }
}
