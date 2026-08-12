# German Flashcards

A spaced-repetition vocabulary app for German, built as an installable PWA and
deployed to GitHub Pages. Vocabulary lives in a JSON file in this repository;
review progress lives on the device.

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:5173/german-flashcards/> — note the subpath, which
matches how GitHub Pages serves the site.

```bash
npm test              # unit tests
npm run check         # typecheck + tests + vocabulary validation
npm run validate:vocab
npm run build
```

## Adding vocabulary

Cards go in [`public/data/vocab.json`](public/data/vocab.json). The format and the
rules for editing it are in [`public/data/AUTHORING.md`](public/data/AUTHORING.md),
with a machine-readable [`schema.json`](public/data/schema.json) alongside it. Both
are served by the live site, so a Claude session can read the current spec directly:

```
https://<username>.github.io/german-flashcards/data/AUTHORING.md
```

Run `npm run validate:vocab` before committing. It also runs in CI, and a failure
blocks the deploy — a malformed vocab file cannot reach the installed app.

## How it fits together

The design question this app is built around is that vocabulary content changes
constantly while review history must never be disturbed. So the two are kept
strictly apart:

| | Owned by | Changes | Rebuildable |
| --- | --- | --- | --- |
| **Content** — words, examples, decks | `vocab.json` in git | Freely, by hand or by Claude | Yes |
| **Progress** — ease, intervals, due dates | IndexedDB on the device | Only by reviewing | **No** |

They are joined on `Card.id` and nothing else, which is why editing a translation,
rewriting an example or reorganising decks costs no review history. The merge step
(`src/core/merge.ts`) never deletes progress: a card removed from the file becomes a
retained orphan rather than a deletion, and the only history that ever moves is a
rename explicitly declared via `prevIds`.

```
src/core/
  types.ts      Card vs ReviewItem — the content/progress split
  schema.ts     Parsing, versioned migrations, tolerant reading
  scheduler.ts  SM-2 behind a swappable interface
  merge.ts      Joining content to progress without losing any
  queue.ts      Daily caps, deck filters, session ordering
  storage.ts    IndexedDB, plus JSON backup export/import
  stats.ts      Derived statistics — nothing accumulated
```

A **card** is a vocabulary entry; a **review item** is one testable direction of it
(German→English today). Adding English→German or cloze modes later generates
additional items rather than altering existing ones, so no history is at risk.

Scheduling is SM-2 with Anki-style learning steps, reached through a `Scheduler`
interface so it can be replaced with FSRS without touching the UI.

## Backups

Review history exists only in the browser's storage on each device. Clearing site
data destroys it. **Settings → Sicherung → herunterladen** writes it to a JSON file;
importing offers *merge* (keeps whichever copy of each card was reviewed more
recently — safe after studying since the backup) or *replace*.

## Deployment

Pushing to `main` runs vocabulary validation, typecheck, tests and build, then
deploys to GitHub Pages. Pull requests run the same checks without publishing.

The repository name and the `BASE` constant in `vite.config.ts` must match, since
GitHub Pages serves project sites from `/<repo>/`.
