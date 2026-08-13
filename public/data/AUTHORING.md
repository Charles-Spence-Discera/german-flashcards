# Adding and editing cards

This file is the instruction sheet for anyone — a person or a Claude session —
adding vocabulary. It sits next to the data and is served at the live site, so it
can be fetched directly instead of relying on a pasted spec that goes stale:

```
https://charles-spence-discera.github.io/german-flashcards/data/AUTHORING.md
https://charles-spence-discera.github.io/german-flashcards/data/schema.json
```

`schema.json` is the machine-readable contract. If the two disagree, the schema
wins and this file is out of date.

---

## Where things live

```
public/data/
  cards/                       ← all vocabulary, one file per capture session
    2026-08-12-kraehen-kap1.json
    2026-08-20-zeit-artikel.json
  decks.json                   ← deck definitions
  schema.json                  ← the format contract
  AUTHORING.md                 ← this file
  vocab.json                   ← GENERATED. Never edit.
```

**`vocab.json` is built by merging `cards/*.json`.** It is git-ignored and
regenerated on every build, so hand edits are silently discarded. Always edit the
batch files.

---

## Adding vocabulary: create a new file

**Never append to an existing batch file.** Create a new one.

This is the single most important rule for how this repository is used. Cards are
usually added by a Claude session working from photographs, on a phone. Reading and
rewriting a growing corpus would mean pulling every card into context and re-emitting
it in full each time — slow, expensive, and a truncated response would silently drop
words that were already there. Writing a fresh file cannot damage anything that
already exists.

Name it `YYYY-MM-DD-source-chapter.json`. Files are merged in filename order, so the
date prefix keeps cards in the order they were captured.

```json
{
  "defaults": {
    "source": "Das Lied der Krähen",
    "chapter": "5",
    "added": "2026-08-20",
    "tags": ["b2"]
  },
  "cards": [
    {
      "id": "die-gasse",
      "de": "die Gasse",
      "pos": "noun",
      "forms": "die Gasse, die Gassen",
      "en": "alley, narrow lane",
      "syn": ["die Seitenstraße"],
      "ex1": "Sie verschwanden in einer engen Gasse. [They disappeared into a narrow alley.]",
      "ex2": "Hinter dem Markt gibt es eine kleine Gasse.",
      "notiz": "Enger als eine Straße.",
      "tags": ["noun", "ort"]
    }
  ]
}
```

### `defaults`

Applies to every card in that batch, so `source` and `chapter` are written once
rather than repeated on every entry.

- `source`, `chapter`, `added` — a value on the card always wins; defaults only fill gaps.
- `tags` — **merged** with the card's own tags rather than replacing them, since a
  batch tag (`b2`) and a card tag (`verb`) describe different things.

A batch with nothing to declare can be a bare array of cards.

---

## Card fields

Only `id`, `de` and `en` are required. A bare three-field card is valid and
reviewable; everything else makes it a better card.

| Field | Notes |
| --- | --- |
| `id` | Lowercase slug, `a-z0-9` and hyphens only, **unique across every batch file**. For nouns include the article: `die-gasse`. Immutable — see below. |
| `de` | Headword as a dictionary would list it. Nouns **with** article: `die Gasse`. |
| `en` | Translation. Several senses separated by commas or semicolons. |
| `pos` | One of `noun`, `verb`, `adj`, `adv`, `phrase`, `other`. |
| `forms` | Nouns: article + plural. Verbs: Präteritum + Partizip II (`ging, ist gegangen`). Adjectives: comparative + superlative. |
| `syn` | German synonyms, as an array. |
| `ex1` | Contextual sentence **in your own words**, English gloss in `[square brackets]`. |
| `ex2` | Plain everyday sentence. No translation — it should be understood from context. |
| `notiz` | Register, false friends, case and preposition patterns, irregularities. |
| `tags` | Free-form labels. The cheapest way to introduce a new grouping. |
| `suspended` | `true` removes the card from review while keeping its history. |
| `prevIds` | See *Renaming*. |

`source`, `chapter` and `added` are normally set in `defaults`, but may be written on
an individual card to override.

### On `ex1` and copyright

Do not copy sentences out of a book. Write a sentence that fits the scene the word
appeared in, in your own words. The point is a memorable context, not a quotation.

---

## The one rule that matters

**`id` is immutable. Everything else is not.**

Review history — how well a word is known, when it is next due, months of scheduling
— lives on the device and is keyed on `id` alone. Nothing else is looked at.

So these are all completely safe:

- fixing a translation or a typo
- rewriting example sentences
- adding, removing or renaming tags
- reorganising or renaming decks
- moving a card between batch files
- reordering anything

And this is the one dangerous operation:

- **changing an `id`** — which orphans that card's history and starts it from zero

---

## Renaming a card

Only rename if the id is genuinely wrong. If you must, declare it:

```json
{ "id": "die-gasse", "prevIds": ["gasse"], "de": "die Gasse", "en": "alley" }
```

The app finds the history under `gasse`, moves it to `die-gasse`, and removes the old
entry. Ease, interval, due date and review count all carry across.

Two rules the validator enforces:

- an id in `prevIds` must **not** also exist as a live card
- two cards must not claim the same `prevIds` entry

Chained renames go oldest-last: `"prevIds": ["gasse-v2", "gasse"]`.

---

## Deleting cards

Deleting a card from a batch file hides it from the app but **does not** delete its
review history, which is retained on the device as an orphan. Put the card back and
its history returns intact.

To stop reviewing a word without removing it, prefer `"suspended": true` — explicit,
reversible, and it keeps the card visible in the file.

---

## Decks (`decks.json`)

A deck is a saved filter, not a folder. Cards are never "inside" a deck.

```json
{
  "id": "kraehen-kap-1",
  "name": "Krähen · Kapitel 1",
  "filter": { "sources": ["Das Lied der Krähen"], "chapters": ["1"] }
}
```

Fields within a filter are ANDed; values within a field are ORed. The above reads
"from *Das Lied der Krähen*, chapter 1". An empty filter `{}` matches everything.

Because decks are data, reorganising never requires a code change. No review history
is attached to them, so add, rename, split or delete freely.

`source` spellings must match **exactly** between cards and filters. The validator
warns when a deck matches zero cards, which is almost always a spelling drift.

---

## Before committing

```bash
npm run validate:vocab
```

This runs automatically on every push and a failure blocks the deploy. It parses each
batch file, checks it against `schema.json`, then runs the app's own parser to catch
duplicate ids across files, contested renames and empty decks. Errors name the file
that contains the mistake.

Warnings are safe to ignore; errors will stop the site updating.

---

## Schema changes

`schemaVersion` is set by the build, not by hand. To add a field, add it to
`schema.json` and to `Card` in `src/core/types.ts` — unknown fields are rejected
specifically so typos cannot pass silently.

Old files never stop working: the app carries a migration chain in
`src/core/schema.ts` and upgrades any older version on load.
