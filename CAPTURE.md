# Capturing vocabulary from your phone

Photograph a page, tell Claude to add the words, done. This is the setup and the
prompt to use.

---

## One-time setup: connect GitHub to Claude

GitHub publishes an official remote MCP server that you add to Claude as a custom
connector. It needs a paid Claude plan.

1. Open Claude (app or web) → **Settings → Connectors**.
2. **Add custom connector**, using GitHub's remote MCP server URL:
   `https://api.githubcopilot.com/mcp/`
3. Authorise it against the **Charles-Spence-Discera** account, and grant access to
   the `german-flashcards` repository.
4. Confirm it works by asking Claude in a new chat:
   *"List the files in public/data/cards/ in Charles-Spence-Discera/german-flashcards."*

If your plan doesn't offer custom connectors, skip to [the manual
fallback](#manual-fallback-no-connector-needed) — it still works fine.

---

## The capture prompt

Save this somewhere you can paste it from your phone. Attach photos of the page, then
send it. Change the source and chapter line each time.

> Add vocabulary to my German flashcards repo, `Charles-Spence-Discera/german-flashcards`.
>
> **Source: Das Lied der Krähen — Kapitel 5**
>
> First, fetch and follow
> `https://charles-spence-discera.github.io/german-flashcards/data/AUTHORING.md`.
> It is the authoritative format spec. Follow it exactly.
>
> From the attached photos, extract vocabulary worth learning at B2–C1. Skip words I
> would already know at B2 and skip proper nouns. Aim for 8–15 cards.
>
> Then **create a new file** at `public/data/cards/YYYY-MM-DD-kraehen-kap5.json`
> using today's date. Put `source`, `chapter` and `added` in `defaults`.
>
> Rules:
> - Never modify any existing file. Never touch `vocab.json` — it is generated.
> - Before choosing ids, list the existing files in `public/data/cards/` and check
>   your new ids don't already exist. Ids are lowercase slugs; nouns include the
>   article (`die-gasse`).
> - `ex1` must be your own sentence fitting the scene, not copied from the book,
>   with an English gloss in square brackets. `ex2` is a plain everyday sentence
>   with no translation.
> - Commit directly to `main` with a message like `Add Krähen chapter 5 vocabulary`.
>
> Show me the card list before you commit.

### Why it's shaped like that

- **Fetching `AUTHORING.md`** means the spec can change without this prompt going
  stale. Update the repo, and every future session picks it up.
- **"Create a new file"** is the important constraint. Appending to an existing file
  would mean reading and rewriting the whole corpus.
- **"Check ids don't already exist"** catches duplicates before the commit. CI would
  catch them anyway, but that costs you a failed build and a round trip.
- **"Show me before you commit"** is your chance to catch a bad translation while
  it's still cheap.

---

## What happens next

1. The push triggers the build. Vocabulary is validated first.
2. If validation fails, **the site does not update** — the old version stays live and
   working. GitHub emails you.
3. On success the site redeploys in about a minute.
4. Open the app. **New words appear on the second launch** — the first one serves the
   cached version and fetches the update in the background. Pull to refresh or just
   close and reopen.

Your review progress is never affected by any of this. It lives on your phone, keyed
on card id, and adding cards only ever adds to the queue.

---

## If CI fails

The email links to the failed run; the log names the file and the problem, e.g.:

```
cards/2026-08-20-kraehen-kap5.json → ERROR  card "die-gasse" [id]: Duplicate id "die-gasse"
```

Easiest fix from a phone: reply in the same Claude chat with the error text and ask
it to fix and re-commit. Or delete the offending file from GitHub's mobile site — the
site reverts to the last good build either way, so nothing is broken while you sort
it out.

---

## Manual fallback (no connector needed)

Works on any plan, takes about 30 seconds.

1. Photograph the page in the Claude app. Use the prompt above, but replace the last
   two paragraphs with:
   *"Output the complete file contents as a single JSON code block. Don't commit
   anything — I'll paste it myself."*
2. Copy the JSON block.
3. Go to
   `github.com/Charles-Spence-Discera/german-flashcards/new/main/public/data/cards`
4. Name the file `2026-08-20-kraehen-kap5.json`, paste, **Commit changes**.

Creating a new file is genuinely easy on mobile. Editing a large existing one is not
— which is the whole reason cards are split into batches.

---

## Adding a deck for new material

Decks are saved filters in `public/data/decks.json`. After adding a new source:

```json
{
  "id": "zeit-artikel",
  "name": "ZEIT-Artikel",
  "filter": { "sources": ["Die Zeit"] }
}
```

The `sources` value must match the `source` on the cards exactly. If it doesn't, the
deck silently matches nothing — the validator warns about this, so check the build.
