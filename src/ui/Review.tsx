import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Grade, ReviewItem } from '../core/types'
import type { App } from '../state'

const GRADES: { grade: Grade; label: string; key: string }[] = [
  { grade: 'again', label: 'Nochmal', key: '1' },
  { grade: 'hard', label: 'Schwer', key: '2' },
  { grade: 'good', label: 'Gut', key: '3' },
  { grade: 'easy', label: 'Leicht', key: '4' },
]

/**
 * What the front of the card shows. Switching on mode here is what will let
 * English→German and cloze modes reuse this whole screen unchanged.
 */
function prompt(item: ReviewItem): string {
  return item.state.mode === 'en-de' ? item.card.en : item.card.de
}

function answer(item: ReviewItem): string {
  return item.state.mode === 'en-de' ? item.card.de : item.card.en
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
  const shownAt = useRef(Date.now())

  const total = app.counts.learning + app.counts.review + app.counts.fresh
  const remaining = app.queue.length
  const done = Math.max(0, total - remaining)

  // Reset the reveal whenever a different card comes up, so a fast tap on the
  // grade buttons can never reveal and grade the next card in one gesture.
  const key = item?.state.key
  useEffect(() => {
    setRevealed(false)
    shownAt.current = Date.now()
  }, [key])

  const intervals = useMemo(
    () => (item ? app.scheduler.preview(item.state, app.now) : null),
    [item, app.scheduler, app.now],
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!item) return
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
          {posLabel ? <div class="card-meta">{posLabel}</div> : null}
        </div>

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
