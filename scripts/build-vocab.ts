/**
 * Merges public/data/cards/*.json into the single vocab.json the app fetches.
 *
 * vocab.json is generated and git-ignored — never edit it by hand, the next build
 * overwrites it. Cards are authored in the batch files; see data/AUTHORING.md.
 *
 *   npm run build:vocab
 *
 * Runs automatically before `npm run dev` and `npm run build`.
 */

import { writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { assembleVocab, loadVocabSources, ROOT, VOCAB_PATH } from './vocab-io'

const sources = loadVocabSources()

if (sources.fatal.length > 0) {
  for (const problem of sources.fatal) {
    console.error(`\x1b[31mERROR\x1b[0m  ${problem.file}: ${problem.message}`)
  }
  console.error('\nCould not build the vocabulary file.')
  process.exit(1)
}

const assembled = assembleVocab(sources)

// Structural problems are warnings here and errors in the validator: a broken batch
// should not block a developer from running the app, but must block a deploy.
for (const problem of assembled.problems) {
  console.warn(`\x1b[33mwarn \x1b[0m  ${problem.file}: ${problem.message}`)
}

writeFileSync(VOCAB_PATH, `${JSON.stringify(assembled.document, null, 2)}\n`, 'utf8')

console.log(
  `Wrote ${relative(ROOT, VOCAB_PATH)} — ${assembled.cards.length} cards from ` +
    `${sources.batches.length} batch file(s).`,
)
