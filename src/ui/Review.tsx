import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { modeLabel } from '../core/modes'
import { isSpellingCorrect } from '../core/spelling'
import type { Grade, ReviewItem } from '../core/types'
import type { App } from '../state'

const GRADES: { grade: Grade; label: string; key: string }[] = [
  { grade: 'again', label: 'Nochmal', key: '1' },
  { grade: 'hard', label: 'Schwer', key: '2' },
  { grade: 'good', label: 'Gut', key: '3' },
  { grade: 'easy', label: 'Leicht', key: '4' },
]

/** Characters a phone keyboard buries two taps deep, offered inline instead. */
const UMLAUTS = ['ä', 'ö', 'ü', 'ß']

/**
 * What the front of the card shows. Both productive modes prompt with the English
 * and expect the German back; they differ only in whether the answer is typed.
 */
function prompt(item: ReviewItem): string {
  return item.state.mode === 'de-en' ? item.card.de : item.card.en
}

function answer(item: ReviewItem): string {
  return item.state.mode === 'de-en' ? item.card.en : item.card.de
}

const POS_LABELS: Record<string, string> = {
  noun: 'Substantiv',
  verb: 'Verb',
  adj: 'Adjektiv',
  adv: 'Adverb',
  phrase: 'Redewendung',
  other: '',
}

export function Review({ app }: { app: App }) {
  const item = app.queue[0]
  const [revealed, setRevealed] = useState(false)
  const [entry, setEntry] = useState('')
  const shownAt = useRef(Date.now())
  const inputRef = useRef<HTMLInputElement | null>(null)

  const total = app.counts.learning + app.counts.review + app.counts.fresh + app.counts.aufbau
  const remaining = app.queue.length
  const done = Math.max(0, total - remaining)

  const typing = item?.state.mode === 'typed-de'

  // Reset the reveal whenever a different card comes up, so a fast tap on the
  // grade buttons can never reveal and grade the next card in one gesture.
  const key = item?.state.key
  useEffect(() => {
    setRevealed(false)
    setEntry('')
    shownAt.current = Date.now()
  }, [key])

  // A typing exercise wants the keyboard up; the platform decides whether it opens.
  useEffect(() => {
    if (typing && !revealed) inputRef.current?.focus()
  }, [key, typing, revealed])

  const intervals = useMemo(
    () => (item ? app.scheduler.preview(item.state, app.now) : null),
    [item, app.scheduler, app.now],
  )

  /**
   * Whether the typed answer matched — computed only once revealed, so nothing is
   * given away while the field is still being filled in.
   *
   * There is deliberately no "wrong" state. A missing tick is the whole of the
   * negative signal, and the grade buttons remain the only thing that decides what
   * happens to the card.
   */
  const tick = useMemo(() => {
    if (!item || !typing || !revealed) return false
    return isSpellingCorrect(entry, item.card)
  }, [item, typing, revealed, entry])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!item) return

      /*
       * The listener is on the window, so without this every keystroke aimed at the
       * input would also be read as a command: space would reveal the card and 1–4
       * would grade it mid-word. While the field has focus it owns the keyboard,
       * and only Enter — meaning "I am done typing" — is borrowed back.
       */
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') {
        if (event.key === 'Enter') {
          event.preventDefault()
          setRevealed(true)
        }
        return
      }

      // `event.code` covers layouts and synthetic events where `key` is not ' '.
      if (!revealed && (event.key === ' ' || event.code === 'Space' || event.key === 'Enter')) {
        event.preventDefault()
        setRevealed(true)
        return
      }
      if (!revealed) return
      const match = GRADES.find((entry) => entry.key === event.key)
      if (match) {
        event.preventDefault()
        app.answer(item, match.grade, Date.now() - shownAt.current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [item, revealed, app])

  if (!item) {
    const soonest = app.items
      .filter((candidate) => candidate.state.phase === 'learning' || candidate.state.phase === 'relearning')
      .map((candidate) => Date.parse(candidate.state.due))
      .filter((due) => due > app.now.getTime())
      .sort((a, b) => a - b)[0]

    return (
      <div class="centered">
        <strong>Fertig für jetzt.</strong>
        {soonest !== undefined ? (
          <p>
            Nächste Wiederholung in{' '}
            {Math.max(1, Math.round((soonest - app.now.getTime()) / 60000))} min.
          </p>
        ) : (
          <p>Keine Karten mehr fällig. Komm später wieder.</p>
        )}
        <button class="button button-quiet" onClick={() => app.setScreen('home')}>
          Zurück zur Übersicht
        </button>
      </div>
    )
  }

  const { card } = item
  const posLabel = card.pos ? POS_LABELS[card.pos] : undefined

  return (
    <div class="review">
      <div class="progress" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
        <div class="progress-bar" style={{ width: total > 0 ? `${(done / total) * 100}%` : '0%' }} />
      </div>

      <div class="card">
        <div>
          <div class="card-prompt">{prompt(item)}</div>
          <div class="card-meta">
            {modeLabel(item.state.mode)}
            {posLabel ? ` · ${posLabel}` : ''}
          </div>
        </div>

        {typing ? (
          <div class="card-typed">
            <input
              ref={inputRef}
              class="typed-input"
              type="text"
              value={entry}
              readOnly={revealed}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              placeholder="auf Deutsch tippen"
              aria-label="Deutsche Antwort"
              onInput={(event) => setEntry((event.target as HTMLInputElement).value)}
            />
            {revealed ? null : (
              <div class="umlauts">
                {UMLAUTS.map((character) => (
                  <button
                    key={character}
                    type="button"
                    class="umlaut"
                    onClick={() => {
                      setEntry((current) => current + character)
                      inputRef.current?.focus()
                    }}
                  >
                    {character}
                  </button>
                ))}
              </div>
            )}
            {revealed && tick ? <div class="tick">Richtig!</div> : null}
          </div>
        ) : null}

        {revealed ? (
          <>
            <div class="card-divider" />
            <div class="card-answer">{answer(item)}</div>
            {card.forms ? <div class="card-forms">{card.forms}</div> : null}
            {card.syn?.length ? <div class="card-syn">≈ {card.syn.join(', ')}</div> : null}

            {card.ex1 || card.ex2 ? (
              <div class="card-examples">
                {card.ex1 ? <div class="card-example">{card.ex1}</div> : null}
                {card.ex2 ? <div class="card-example">{card.ex2}</div> : null}
              </div>
            ) : null}

            {card.notiz ? <div class="card-note">{card.notiz}</div> : null}

            {card.source ? (
              <div class="card-meta">
                {card.source}
                {card.chapter ? ` · ${card.chapter}` : ''}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div class="controls">
        {revealed ? (
          <div class="grades">
            {GRADES.map(({ grade, label }) => (
              <button
                key={grade}
                class={`grade grade-${grade}`}
                aria-label={`${label}, nächste Wiederholung in ${intervals?.[grade] ?? ''}`}
                onClick={() => app.answer(item, grade, Date.now() - shownAt.current)}
              >
                <span class="grade-label">{label}</span>
                <span class="grade-interval">{intervals?.[grade]}</span>
              </button>
            ))}
          </div>
        ) : (
          <button class="button button-primary" onClick={() => setRevealed(true)}>
            Antwort zeigen
          </button>
        )}
      </div>
    </div>
  )
}
