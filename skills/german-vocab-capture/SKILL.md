---
name: german-vocab-capture
description: >
  Turn photographs of a German book page into flashcards in the
  Charles-Spence-Discera/german-flashcards repo. Use whenever Charlie sends photos of
  German text, or asks to add vocabulary / words / cards from a chapter, article or
  page — typically named as a source and chapter ("Das Lied der Krähen, Kapitel 6").
  Also use for fixing a card that CI rejected, or adding a deck for new material.
---

# Capturing German vocabulary from photos

The repo is `Charles-Spence-Discera/german-flashcards`. Vocabulary lives in
`public/data/cards/`, one JSON file per capture session.

## Step 1 — fetch the spec, every time

```
https://charles-spence-discera.github.io/german-flashcards/data/AUTHORING.md
```

That file is authoritative for the format and it can change without this skill being
updated. Fetch it and follow it exactly. `data/schema.json` at the same host is the
machine-readable contract; if the two disagree, the schema wins.

Do not work from memory of the format. Fetch it.

## Step 2 — establish the source

You need `source` and `chapter` before writing anything. Charlie usually gives them
("Krähen Kapitel 6"). If he hasn't, ask — one short question, then continue. `source`
must match existing cards **character for character** (`Das Lied der Krähen`), because
decks filter on that exact string.

Check what's already there:

```
public/data/cards/
```

Existing filenames tell you the slug convention in use (`kraehen-kap5`) and let you
confirm the chapter isn't already captured.

## Step 3 — extract

From the photos, pull vocabulary worth learning at **B2–C1**. Aim for **8–15 cards**.

- Skip words Charlie would already know at B2.
- Skip proper nouns — character and place names are not vocabulary.
- Prefer words that recur, carry the scene, or have a non-obvious sense in context.
- A useful fixed phrase or separable verb beats a fourth synonym for "dark".

If the photos are blurry or a word is genuinely unreadable, leave it out and say so
afterwards. Do not guess at a headword.

Fill the optional fields — `pos`, `forms`, `syn`, `notiz` make a card worth reviewing.
`forms` in particular: nouns get article + plural, verbs get Präteritum + Partizip II.

### Example sentences

- `ex1` — **your own sentence**, fitting the scene the word appeared in, with an
  English gloss in `[square brackets]`. Never copy a sentence out of the book.
- `ex2` — a plain everyday sentence. No translation.

### Ids

Lowercase slug, `a-z0-9` and hyphens. Nouns include the article: `die-gasse`.

**Before choosing ids, check they don't already exist** anywhere in
`public/data/cards/`. Duplicates fail CI and cost a round trip. Ids are immutable
once shipped — review history on Charlie's phone is keyed on the id alone, so a
changed id silently orphans months of scheduling.

## Step 4 — write a new file

`public/data/cards/YYYY-MM-DD-<source>-<chapter>.json`, using **today's date**.

**Never append to an existing batch file, and never modify one.** Never touch
`vocab.json` — it is generated at build time and hand edits are discarded. Creating a
fresh file cannot damage anything that already exists; rewriting a growing corpus can.

Put `source`, `chapter` and `added` in `defaults` rather than repeating them per card.

## Step 5 — show the list, then commit

Show Charlie the cards — German, English, and the `ex1` gloss is enough — **before**
committing. That's the cheap moment to catch a bad translation.

Then commit directly to `main`, message like `Add Krähen chapter 6 vocabulary`.

- Working from a checkout: run `npm run validate:vocab` first, then commit and push.
- Working through the GitHub connector: create the file in a single commit. CI runs
  the same validation.

## After the push

The build validates, then deploys in about a minute. If validation fails the site
does not update — the previous version stays live, so nothing is broken. New words
appear on the app's **second** launch; the first serves cache and fetches in the
background.

## If CI fails

The log names the file and the problem, e.g.
`card "die-gasse" [id]: Duplicate id "die-gasse"`. Fix it by editing the file you
just added — or delete that file if it's easier. Either way the site is already
serving the last good build.

## Adding a deck

Decks are saved filters in `public/data/decks.json`, not folders. Add one when a new
source appears:

```json
{ "id": "zeit-artikel", "name": "ZEIT-Artikel", "filter": { "sources": ["Die Zeit"] } }
```

`sources` must match the cards' `source` exactly, or the deck silently matches
nothing. The validator warns on a zero-match deck — check the build output.
