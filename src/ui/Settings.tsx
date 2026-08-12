import { useRef, useState } from 'preact/hooks'
import type { ImportMode } from '../core/storage'
import type { App } from '../state'

export function Settings({ app }: { app: App }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingMode = useRef<ImportMode>('merge')
  const [message, setMessage] = useState<string | null>(null)

  function pickFile(mode: ImportMode) {
    if (
      mode === 'replace' &&
      !window.confirm(
        'Ersetzen löscht den gesamten aktuellen Fortschritt auf diesem Gerät und stellt die ' +
          'Sicherung an seiner Stelle wieder her. Fortfahren?',
      )
    ) {
      return
    }
    pendingMode.current = mode
    fileInput.current?.click()
  }

  async function onFileChosen(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = '' // allow re-picking the same file
    if (!file) return

    try {
      const summary = await app.importBackup(await file.text(), pendingMode.current)
      setMessage(
        `Wiederhergestellt: ${summary.added} neu, ${summary.updated} aktualisiert, ` +
          `${summary.keptLocal} lokal behalten.`,
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Import fehlgeschlagen.')
    }
  }

  function setNumber(key: 'newPerDay' | 'maxReviewsPerDay', raw: string) {
    const value = Number.parseInt(raw, 10)
    if (Number.isFinite(value) && value >= 0) app.updateSettings({ [key]: value })
  }

  return (
    <>
      <div class="panel">
        <h2>Tageslimits</h2>
        <div class="field">
          <label for="new-per-day">Neue Karten pro Tag</label>
          <input
            id="new-per-day"
            type="number"
            min={0}
            max={999}
            value={app.settings.newPerDay}
            onChange={(event) => setNumber('newPerDay', (event.target as HTMLInputElement).value)}
          />
          <span class="field-hint">
            Wie viele unbekannte Wörter höchstens neu dazukommen. Jedes neue Wort erzeugt für Monate
            Wiederholungen — 10 bis 20 ist nachhaltig.
          </span>
        </div>
        <div class="field">
          <label for="max-reviews">Wiederholungen pro Tag</label>
          <input
            id="max-reviews"
            type="number"
            min={0}
            max={9999}
            value={app.settings.maxReviewsPerDay}
            onChange={(event) =>
              setNumber('maxReviewsPerDay', (event.target as HTMLInputElement).value)
            }
          />
          <span class="field-hint">
            Obergrenze für fällige Karten. Lernschritte zählen nicht mit und werden nie begrenzt.
          </span>
        </div>
        <div class="field">
          <label for="day-start">Tagesbeginn</label>
          <select
            id="day-start"
            value={String(app.settings.scheduler.dayStartHour)}
            onChange={(event) =>
              app.updateSettings({
                scheduler: {
                  ...app.settings.scheduler,
                  dayStartHour: Number.parseInt((event.target as HTMLSelectElement).value, 10),
                },
              })
            }
          >
            {[0, 1, 2, 3, 4, 5, 6].map((hour) => (
              <option key={hour} value={String(hour)}>
                {String(hour).padStart(2, '0')}:00
              </option>
            ))}
          </select>
          <span class="field-hint">
            Wann ein neuer Lerntag beginnt. Eine Wiederholung um 01:00 zählt noch zum Vortag.
          </span>
        </div>
      </div>

      <div class="panel">
        <h2>Sicherung</h2>
        <p class="field-hint">
          Der Lernfortschritt liegt nur in diesem Browser. Wird er gelöscht, ist er ohne Sicherung
          weg. Die Vokabeln selbst sind davon nicht betroffen — die stehen auf GitHub.
        </p>
        <div class="field">
          <button class="button" onClick={() => void app.exportBackup()}>
            Sicherung herunterladen
          </button>
        </div>
        <div class="field">
          <div class="button-row">
            <button class="button" onClick={() => pickFile('merge')}>
              Zusammenführen
            </button>
            <button class="button" onClick={() => pickFile('replace')}>
              Ersetzen
            </button>
          </div>
          <span class="field-hint">
            Zusammenführen behält bei jeder Karte den zuletzt gelernten Stand — sicher, wenn du seit
            der Sicherung weitergelernt hast. Ersetzen verwirft den lokalen Fortschritt.
          </span>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(event) => void onFileChosen(event)}
        />
        {message ? <div class="notice">{message}</div> : null}
      </div>

      <div class="panel">
        <h2>Vokabeln</h2>
        <div class="row">
          <span class="row-label">Karten geladen</span>
          <span class="row-value">{app.file?.cards.length ?? 0}</span>
        </div>
        <div class="row">
          <span class="row-label">Schema-Version</span>
          <span class="row-value">{app.file?.schemaVersion ?? '–'}</span>
        </div>
        <div class="row">
          <span class="row-label">Speicher</span>
          <span class="row-value">{app.durable ? 'dauerhaft' : 'nur Sitzung'}</span>
        </div>
        <div class="field">
          <button class="button" onClick={() => void app.reload()}>
            Vokabeln neu laden
          </button>
          <span class="field-hint">
            Holt neue Karten von GitHub. Der Lernfortschritt bleibt dabei unberührt.
          </span>
        </div>
      </div>
    </>
  )
}
