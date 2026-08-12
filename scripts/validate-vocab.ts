/**
 * Validates the vocabulary file.
 *
 * This runs in CI before every deploy, and it is the reason a bad edit cannot reach
 * the phone. The vocab file is written by hand and by Claude sessions with no type
 * checking in between; without this gate, a missing comma or a duplicated id would
 * deploy cleanly and then break the app offline, where it is least debuggable.
 *
 * Two layers, because they catch different things:
 *   1. JSON Schema (data/schema.json) — structure, types, unknown fields, id format.
 *   2. The app's own parser — duplicate ids, contested renames, everything that
 *      needs to compare cards against each other.
 *
 * Layer 2 uses exactly the code the app runs, so the two can never disagree about
 * what is loadable.
 *
 *   npm run validate:vocab
 */

import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// `ajv` proper is draft-07; the schema declares draft 2020-12, which lives here.
import AjvModule from 'ajv/dist/2020'
import { formatProblem, hasErrors, parseVocabFile } from '../src/core/schema'

// ajv ships as CommonJS; under ESM the constructor arrives on `.default`.
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VOCAB_PATH = join(ROOT, 'public', 'data', 'vocab.json')
const SCHEMA_PATH = join(ROOT, 'public', 'data', 'schema.json')

const red = (text: string) => `[31m${text}[0m`
const yellow = (text: string) => `[33m${text}[0m`
const green = (text: string) => `[32m${text}[0m`
const dim = (text: string) => `[2m${text}[0m`

function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(red(`Cannot read ${relative(ROOT, path)}.`))
    process.exit(1)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    // Nearly every failure here is a trailing or missing comma, and the parser's
    // position is the fastest way to find it.
    console.error(red(`${relative(ROOT, path)} is not valid JSON.`))
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

/** Turns an ajv instance path into something that names the offending card. */
function describeLocation(instancePath: string, data: unknown): string {
  const match = /^\/cards\/(\d+)/.exec(instancePath)
  if (!match) return instancePath === '' ? 'file root' : instancePath
  const index = Number(match[1])
  const cards = (data as { cards?: unknown[] })?.cards
  const card = Array.isArray(cards) ? (cards[index] as { id?: string; de?: string }) : undefined
  const name = card?.id ?? card?.de ?? `entry ${index}`
  const field = instancePath.slice(match[0].length).replace(/^\//, '')
  return field ? `card "${name}" [${field}]` : `card "${name}"`
}

const vocab = readJson(VOCAB_PATH)
const schema = readJson(SCHEMA_PATH)

let errorCount = 0
let warningCount = 0

/* Layer 1: structure. ------------------------------------------------------ */

const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(schema as object)

if (!validate(vocab)) {
  for (const error of validate.errors ?? []) {
    const where = describeLocation(error.instancePath, vocab)
    const extra =
      error.keyword === 'additionalProperties'
        ? ` ("${(error.params as { additionalProperty: string }).additionalProperty}")`
        : ''
    console.error(`${red('ERROR')}  ${where}: ${error.message}${extra}`)
    errorCount++
  }
}

/* Layer 2: semantics, using the app's own parser. -------------------------- */

const { file, problems, sourceVersion } = parseVocabFile(vocab)

for (const problem of problems) {
  const line = formatProblem(problem)
  if (problem.level === 'error') {
    console.error(red(line))
    errorCount++
  } else {
    console.warn(yellow(line))
    warningCount++
  }
}

/* Summary. ----------------------------------------------------------------- */

console.log('')
console.log(
  dim(
    `${file.cards.length} cards, ${file.decks.length} decks, schema v${sourceVersion}` +
      (sourceVersion !== file.schemaVersion ? ` (migrated to v${file.schemaVersion})` : ''),
  ),
)

// Deck filters that select nothing are almost always a spelling drift between a
// filter and the `source` or `tags` on the cards, which is invisible in the app —
// the deck simply appears empty.
for (const deck of file.decks) {
  const { matchesFilter } = await import('../src/core/queue')
  const matched = file.cards.filter((card) => matchesFilter(card, deck.filter)).length
  if (matched === 0) {
    console.warn(yellow(`warn   deck "${deck.name}" matches no cards — check its filter.`))
    warningCount++
  } else {
    console.log(dim(`  deck "${deck.name}": ${matched} cards`))
  }
}

console.log('')

if (errorCount > 0 || hasErrors(problems)) {
  console.error(red(`Failed: ${errorCount} error(s), ${warningCount} warning(s).`))
  process.exit(1)
}

console.log(green(`Passed${warningCount > 0 ? ` with ${warningCount} warning(s)` : ''}.`))
