import { hasErrors, formatProblem } from '../core/schema'
import type { App } from '../state'

/**
 * What to say when the automatic backup is not doing its job.
 *
 * Only reached when sync is switched on: a user who never set it up is not nagged
 * here, and one who did is told on the first screen rather than in a settings tab
 * nobody opens. A silent backup failure is the one failure this app cannot recover
 * from, so it earns space on the home screen.
 */
const SYNC_WARNING: Partial<Record<App['syncHealth'], string>> = {
  failing: 'Die automatische Sicherung schlägt fehl. Der Fortschritt liegt gerade nur auf diesem Gerät.',
  pending: 'Seit Tagen nichts gesichert. Der neue Lernfortschritt liegt nur auf diesem Gerät.',
  never: 'Die automatische Sicherung ist eingerichtet, aber noch nie gelaufen.',
}

export function Home({ app }: { app: App }) {
  const { counts, file } = app
  const total = counts.learning + counts.review + counts.fresh
  const decks = file?.decks ?? []
  const cardCount = file?.cards.length ?? 0

  return (
    <>
      {app.offlineSince ? (
        <div class="notice notice-warn">
          Offline — gespeicherte Vokabeln vom{' '}
          {new Date(app.offlineSince).toLocaleDateString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          })}
          . Der Lernfortschritt wird ganz normal gespeichert; neue Karten kommen dazu, sobald du
          wieder online bist.
        </div>
      ) : null}

      {!app.durable ? (
        <div class="notice notice-warn">
          Dieses Gerät erlaubt keinen dauerhaften Speicher. Der Fortschritt geht verloren, wenn du
          die App schließt.
        </div>
      ) : null}

      {SYNC_WARNING[app.syncHealth] ? (
        <div class="notice notice-warn">
          {SYNC_WARNING[app.syncHealth]}{' '}
          <button class="link-button" onClick={() => app.setScreen('settings')}>
            Einstellungen öffnen
          </button>
        </div>
      ) : null}

      {app.problems.length > 0 ? (
        <div class={`notice ${hasErrors(app.problems) ? 'notice-error' : 'notice-warn'}`}>
          {hasErrors(app.problems)
            ? 'Einige Karten konnten nicht geladen werden.'
            : 'Die Vokabeldatei hat kleine Auffälligkeiten.'}
          <details>
            <summary>{app.problems.length} Meldungen</summary>
            <ul>
              {app.problems.slice(0, 25).map((problem, index) => (
                <li key={index}>{formatProblem(problem)}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}

      <div class="counts">
        <div class="count count-learning">
          <span class="count-value">{counts.learning}</span>
          <span class="count-label">Lernen</span>
        </div>
        <div class="count count-review">
          <span class="count-value">{counts.review}</span>
          <span class="count-label">Fällig</span>
        </div>
        <div class="count count-new">
          <span class="count-value">{counts.fresh}</span>
          <span class="count-label">Neu</span>
        </div>
      </div>

      <button
        class="button button-primary"
        disabled={total === 0}
        onClick={() => app.setScreen('review')}
      >
        {total > 0 ? `${total} Karten lernen` : 'Nichts fällig'}
      </button>

      {decks.length > 0 ? (
        <div class="panel">
          <h2>Stapel</h2>
          <div class="field">
            <select
              value={app.settings.activeDeckId ?? ''}
              onChange={(event) =>
                app.updateSettings({
                  activeDeckId: (event.target as HTMLSelectElement).value || null,
                })
              }
            >
              <option value="">Alle Karten ({cardCount})</option>
              {decks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <div class="panel">
        <h2>Heute</h2>
        <div class="row">
          <span class="row-label">Neue Karten gelernt</span>
          <span class="row-value">
            {app.doneToday.introduced} / {app.settings.newPerDay}
          </span>
        </div>
        <div class="row">
          <span class="row-label">Wiederholungen</span>
          <span class="row-value">
            {app.doneToday.reviewed} / {app.settings.maxReviewsPerDay}
          </span>
        </div>
        <div class="row">
          <span class="row-label">Noch nicht fällig</span>
          <span class="row-value">{counts.waiting}</span>
        </div>
        <div class="row">
          <span class="row-label">Karten insgesamt</span>
          <span class="row-value">{cardCount}</span>
        </div>
      </div>
    </>
  )
}
