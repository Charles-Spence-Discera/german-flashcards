/**
 * Validates the vocabulary batch files.
 *
 * This runs in CI before every deploy and is the reason a bad edit cannot reach the
 * phone. Cards are written by hand and by Claude sessions with no type checking in
 * between; without this gate a missing comma or a duplicated id would deploy
 * cleanly and then break the app offline, where it is least debuggable.
 *
 * Three layers, each catching what the previous cannot:
 *   1. JSON parsing, per batch file.
 *   2. JSON Schema (data/schema.json) — structure, types, unknown fields, id format.
 *   3. The app's own parser — duplicate ids, contested renames, anything needing
 *      cards to be compared against each other.
 *
 * Layer 3 uses exactly the code the app runs, so the two can never disagree about
 * what is loadable. Everything is assembled in memory rather than read from a
 * previously generated vocab.json, so validation cannot pass against stale output.
 *
 *   npm run validate:vocab
 */

import { readFileSync } from 'node:fs'
// `ajv` proper is draft-07; the schema declares draft 2020-12, which lives here.
import AjvModule from 'ajv/dist/2020'
import { cardIdsByFile } from '../src/core/batches'
import { matchesFilter } from '../src/core/queue'
import { formatProblem, hasErrors, parseVocabFile } from '../src/core/schema'
import { assembleVocab, loadVocabSources, SCHEMA_PATH } from './vocab-io'

// ajv ships as CommonJS; under ESM the constructor arrives on `.default`.
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule

const red = (text: string) => `\x1b[31m${text}\x1b[0m`
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`
const green = (text: string) => `\x1b[32m${text}\x1b[0m`
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`

let errorCount = 0
let warningCount = 0

function reportError(where: string, message: string) {
  console.error(`${red('ERROR')}  ${where}: ${message}`)
  errorCount++
}

function reportWarning(where: string, message: string) {
  console.warn(`${yellow('warn ')}  ${where}: ${message}`)
  warningCount++
}

/* Layer 1: parse every batch file. ---------------------------------------- */

const sources = loadVocabSources()

for (const problem of sources.fatal) {
  reportError(problem.file, problem.message)
}

if (errorCount > 0) {
  console.error(red(`\nFailed: ${errorCount} file(s) could not be read.`))
  process.exit(1)
}

const assembled = assembleVocab(sources)

for (const problem of assembled.problems) {
  reportError(problem.file, problem.message)
}

/* Layer 2: structure, against the JSON Schema. ---------------------------- */

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object
const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(schema)

/** Names the batch file and card behind an ajv instance path like `/cards/7/en`. */
function locate(instancePath: string): string {
  const match = /^\/cards\/(\d+)/.exec(instancePath)
  if (!match) return instancePath === '' ? 'vocab document' : instancePath

  const index = Number(match[1])
  const card = assembled.cards[index] as { id?: string; de?: string } | undefined
  const origin = assembled.origins[index] ?? 'unknown file'
  const name = card?.id ?? card?.de ?? `entry ${index}`
  const field = instancePath.slice(match[0].length).replace(/^\//, '')

  return `${origin} → card "${name}"${field ? ` [${field}]` : ''}`
}

if (!validate(assembled.document)) {
  for (const error of validate.errors ?? []) {
    const extra =
      error.keyword === 'additionalProperties'
        ? ` ("${(error.params as { additionalProperty: string }).additionalProperty}")`
        : ''
    reportError(locate(error.instancePath), `${error.message}${extra}`)
  }
}

/* Layer 3: semantics, using the app's own parser. ------------------------- */

const { file, problems } = parseVocabFile(assembled.document)
const originOf = cardIdsByFile(assembled.cards, assembled.origins)

for (const problem of problems) {
  // Problem.index refers to the entry as written, so it names the file that
  // actually contains the mistake — for a duplicate id that is the second file,
  // not the innocent one that used the id first.
  const origin =
    (problem.index >= 0 ? assembled.origins[problem.index] : undefined) ??
    (problem.cardId !== undefined ? originOf.get(problem.cardId) : undefined)
  const line = `${origin ? `${origin} → ` : ''}${formatProblem(problem)}`
  if (problem.level === 'error') {
    console.error(red(line))
    errorCount++
  } else {
    console.warn(yellow(line))
    warningCount++
  }
}

/* Summary. ---------------------------------------------------------------- */

console.log('')
console.log(
  dim(
    `${file.cards.length} cards from ${sources.batches.length} batch file(s), ` +
      `${file.decks.length} decks, schema v${file.schemaVersion}`,
  ),
)

for (const batch of sources.batches) {
  const count = assembled.origins.filter((origin) => origin === batch.name).length
  console.log(dim(`  ${batch.name}: ${count} cards`))
}

// A deck matching nothing is almost always a spelling drift between the filter and
// the cards' `source` or `tags`. It is invisible in the app — the deck just looks
// empty — so it has to be caught here.
for (const deck of file.decks) {
  const matched = file.cards.filter((card) => matchesFilter(card, deck.filter)).length
  if (matched === 0) {
    reportWarning('decks.json', `deck "${deck.name}" matches no cards — check its filter.`)
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
