/**
 * Checking a typed German answer.
 *
 * The tick this produces is **information, not judgement**. Grading stays manual:
 * the four buttons decide what happens to the schedule, exactly as in every other
 * mode, and nothing here can mark an answer wrong. That is deliberate — an automatic
 * verdict on a language this ambiguous is wrong often enough to be discouraging, and
 * a self-graded card absorbs the ambiguity for free.
 *
 * Because there is no penalty, the comparison can afford to be generous. It folds
 * away everything that is not the point of the exercise — case, the umlaut spellings
 * a phone keyboard makes awkward, the article on a noun — so that a tick means "you
 * produced the word" rather than "you reproduced the string".
 */

import type { Card } from './types'

const ARTICLES = ['der ', 'die ', 'das ']

/**
 * Reduces an answer to what actually has to match.
 *
 * `ae`/`oe`/`ue`/`ss` are accepted for the umlauts because they are the standard
 * substitution and typing the real characters on a phone is friction that teaches
 * nothing. The correct spelling is always shown on reveal, so the distinction is
 * still put in front of you.
 */
export function normaliseAnswer(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[.,!?;:„“"'()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether a tick can meaningfully be offered for this card at all.
 *
 * Phrases carry placeholder tokens — `jdn/etw im Auge behalten` — that cannot be
 * typed literally, so any comparison would fail on a correct answer. They still get
 * the typed mode, because producing the phrase is the valuable part; they simply get
 * no tick, and self-grading carries the whole load.
 */
export function isSpellingCheckable(card: Card): boolean {
  return card.pos !== 'phrase'
}

function withoutArticle(value: string): string {
  for (const article of ARTICLES) {
    if (value.startsWith(article)) return value.slice(article.length)
  }
  return value
}

/**
 * True when the typed answer counts as the card's German.
 *
 * The article on a noun may be **omitted** — `Gasse` earns the tick for `die Gasse`,
 * since typing the bare word is a fair answer to "what is the German for alley". A
 * *wrong* article is a different matter and earns nothing: `der Gasse` is a claim
 * about gender, and a tick would be endorsing it. The full form is always shown on
 * reveal either way, so the distinction stays in front of you and the grade is still
 * yours to give.
 */
export function isSpellingCorrect(typed: string, card: Card): boolean {
  if (!isSpellingCheckable(card)) return false

  const attempt = normaliseAnswer(typed)
  if (attempt === '') return false

  const answer = normaliseAnswer(card.de)
  if (attempt === answer) return true

  return attempt === withoutArticle(answer)
}
