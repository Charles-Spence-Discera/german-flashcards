# Project brief: Krähen Vokabeln PWA — deploy to GitHub Pages

## Context
Personal project: a spaced-repetition flashcard web app called "Krähen Vokabeln" for German
vocabulary study (B2 level, working through German books chapter by chapter, currently *Das
Lied der Krähen*). Designed and built in a Claude.ai chat. I have the resulting files in
`kraehen-app.zip`, which I'm attaching/copying into this session's working directory.

## What already exists (in the zip)
A working PWA prototype, sanity-checked for syntax but never deployed or tested live:
- `index.html`, `style.css`, `app.js` — flashcard review app with an SM-2-style spaced
  repetition scheduler (Again/Hard/Good/Easy rating, due-date queue)
- `manifest.json`, `sw.js` — installable/offline PWA support (service worker caches assets,
  network-first fetch for `data/vocab.json` so new words sync when online)
- `data/vocab.json` — the vocab data file, currently seeded with 2 example cards
- `icon-192.png`, `icon-512.png` — placeholder icons (fine to improve if you have a moment)

## What I need help with in this session
1. Unzip the files, initialize a git repo, and push to a **private** GitHub repo on my account
   (I already have a GitHub account; walk me through creating the repo and authenticating —
   I'm not fluent in git, so spell out each command).
2. Enable GitHub Pages so it serves at a real `https://` URL.
3. GitHub Pages project sites serve from a subpath like `username.github.io/reponame/`, not the
   root. Please check `index.html`, `manifest.json`, and `sw.js` for any path assumptions that
   would break under that subpath, and fix them.
4. Once it's live, walk me through opening the URL in Chrome on my Android phone and confirming
   the "Install app" prompt actually appears and the app works offline after install. This has
   never been tested end to end — this session is the first real test, so expect to debug.
5. If you spot anything actually broken in the SM-2 scheduling logic in `app.js`, flag it, but
   don't rewrite the algorithm wholesale without telling me what changed and why.

## How future vocab updates will work
Separately, in Claude.ai chats, I upload photos of book pages and Claude extracts vocabulary
into this card format:

```json
{
  "id": "unique-slug",
  "de": "German headword",
  "forms": "Präteritum + Partizip II (verbs) or gender + plural (nouns)",
  "en": "English translation",
  "syn": ["synonym1", "synonym2"],
  "bookEx": "Scene-contextualized sentence, reworded for copyright (English in brackets)",
  "ex2": "Simple everyday sentence, no translation",
  "notiz": "optional: register notes, false friends, case patterns"
}
```

Going forward, new cards get appended to `data/vocab.json` and committed/pushed (either by me
manually, or by a Claude.ai session if I give it a GitHub token). The app fetches that file on
load and merges anything new without wiping existing review progress (matched by `id`). Please
don't change this schema without flagging it to me, since it has to stay compatible with how
Claude.ai generates cards.

## Notes on my setup
- Mac, comfortable at a desk for this session (not doing this from my phone).
- GitHub account already exists.
- Please confirm each step worked (e.g. show me the live URL, confirm Pages build succeeded)
  rather than assuming it did.
