# Adding and editing cards

This file is the instruction sheet for anyone — a person or a Claude session —
editing `vocab.json`. It sits next to the data and is served at the live site, so it
can be fetched directly instead of relying on a pasted spec that goes stale:

```
https://<username>.github.io/german-flashcards/data/AUTHORING.md
https://<username>.github.io/german-flashcards/data/schema.json
```

`schema.json` is the machine-readable contract. If the two ever disagree, the schema
wins and this file is out of date.

---

## The one rule that matters

**`id` is immutable. Everything else is not.**

Review history — how well a word is known, when it is next due, months of scheduling
— is stored on the device and keyed on `id` alone. Nothing else is looked at.

That means these are all completely safe:

- fixing a translation or a typo
- rewriting example sentences
- adding, removing or renaming tags
- adding `source`, `chapter`, `pos` or `notiz` to cards that lack them
- reorganising or renaming decks
- reordering cards in the file

And this is the one dangerous operation:

- **changing an `id`** — which orphans that card's history and starts it from zero

If an id genuinely has to change, do not just change it. See *Renaming a card* below.

---

## Card format

Only `id`, `de` and `en` are required. Everything else improves the card but is
optional — a bare three-field card is valid and reviewable.

```json
{
  "id": "die-gasse",
  "de": "die Gasse",
  "pos": "noun",
  "forms": "die Gasse, die Gassen",
  "en": "alley, narrow lane",
  "syn": ["die Seitenstraße", "der Durchgang"],
  "ex1": "Sie verschwanden in einer engen Gasse, bevor die Wachen um die Ecke kamen. [They disappeared into a narrow alley before the guards came round the corner.]",
  "ex2": "Hinter dem Markt gibt es eine kleine Gasse mit einem Café.",
  "notiz": "Enger als eine Straße. Auch übertragen: jemandem eine Gasse bahnen.",
  "source": "Das Lied der Krähen",
  "chapter": "1",
  "tags": ["b2", "noun", "ort"],
  "added": "2026-08-12"
}
```

| Field | Notes |
| --- | --- |
| `id` | Lowercase slug, `a-z0-9` and hyphens only, unique in the file. For nouns include the article: `die-gasse`. Immutable. |
| `de` | Headword as a dictionary would list it. Nouns **with** article: `die Gasse`. |
| `en` | Translation. Several senses separated by commas or semicolons. |
| `pos` | One of `noun`, `verb`, `adj`, `adv`, `phrase`, `other`. |
| `forms` | Nouns: article + plural. Verbs: Präteritum + Partizip II (`ging, ist gegangen`). Adjectives: comparative + superlative. |
| `syn` | German synonyms, as an array. |
| `ex1` | Contextual sentence **in your own words**, English gloss in `[square brackets]`. |
| `ex2` | Plain everyday sentence. No translation — it is there to be understood from context. |
| `notiz` | Register, false friends, case and preposition patterns, irregularities. |
| `source` | Book, article, podcast or lesson. Spelling must match **exactly** across cards or deck filters silently miss. |
| `chapter` | Chapter, episode or page. Free text; keep the style consistent within a source. |
| `tags` | Free-form labels. Cheap to add and the easiest way to introduce a new grouping. |
| `added` | `YYYY-MM-DD`. |
| `suspended` | `true` removes the card from review while keeping its history. |
| `prevIds` | See below. |

### On `ex1` and copyright

Do not copy sentences out of a book. Write a sentence that fits the scene the word
appeared in, in your own words. The point is a memorable context, not a quotation.

---

## Adding cards

Append to the `cards` array. Do not renumber, reorder or rewrite anything else —
smaller diffs are easier to review and to undo.

Before adding, check the id is not already present. A duplicate id fails validation,
and if it somehow got through, two cards would fight over one review history.

New cards enter the queue as "new" and are introduced at the daily limit set in the
app, so adding two hundred at once will not produce a two-hundred-card session.

---

## Renaming a card

Only rename if the id is genuinely wrong. If you must:

```json
{
  "id": "die-gasse",
  "prevIds": ["gasse"],
  "de": "die Gasse",
  "en": "alley"
}
```

The app finds the history under `gasse`, moves it to `die-gasse`, and deletes the old
entry. Ease, interval, due date and review count all carry across.

Two rules the validator enforces:

- an id in `prevIds` must **not** also exist as a live card
- two cards must not claim the same `prevIds` entry

Chained renames are fine — list them oldest-last: `"prevIds": ["gasse-v2", "gasse"]`.

---

## Deleting cards

Removing a card from the file hides it from the app but **does not** delete its
review history, which is retained on the device as an orphan. Put the card back and
its history returns intact.

If you only want to stop reviewing a word, prefer `"suspended": true` — it is
explicit, reversible, and keeps the card visible in the file.

---

## Decks

A deck is a saved filter, not a folder. Cards are never "inside" a deck; a deck
describes which cards it selects.

```json
{
  "id": "kraehen-kap-1",
  "name": "Krähen · Kapitel 1",
  "filter": { "sources": ["Das Lied der Krähen"], "chapters": ["1"] }
}
```

Fields within a filter are ANDed; values within a field are ORed. So the above reads
"from *Das Lied der Krähen*, chapter 1". An empty filter `{}` matches everything.

Because decks are data, reorganising the collection never requires a code change.
Add, rename, split or delete decks freely — no review history is attached to them.

The validator warns when a deck matches zero cards, which almost always means a
`source` or tag is spelled differently on the cards than in the filter.

---

## Before committing

```bash
npm run validate:vocab
```

This also runs automatically on every push, and a failure blocks the deploy. It
checks structure against `schema.json`, then runs the app's own parser to catch
duplicate ids, contested renames and empty decks.

Warnings are safe to ignore; errors are not, and will stop the site updating.

---

## Schema changes

`schemaVersion` at the top of the file is set by the app, not by hand. To add a
field, add it to `schema.json` and to `Card` in `src/core/types.ts`; unknown fields
are rejected by the validator specifically so that typos cannot pass silently.

Old files never stop working: the app carries a migration chain in
`src/core/schema.ts` and upgrades any older version on load.
