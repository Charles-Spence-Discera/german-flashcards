import { useRef, useState } from 'preact/hooks'
import type { ImportMode } from '../core/storage'
import { parseRepoRef, type SyncHealth } from '../core/sync'
import type { App } from '../state'

const HEALTH_LABEL: Record<SyncHealth, string> = {
  off: 'aus',
  never: 'noch nie gelaufen',
  ok: 'aktuell',
  pending: 'im Rückstand',
  failing: 'fehlgeschlagen',
}

function formatWhen(iso: string | null): string {
  if (iso === null) return 'nie'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'nie'
  return at.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Setting up and watching the automatic backup.
 *
 * The status rows matter as much as the fields: an automatic backup that has quietly
 * stopped is the failure this whole feature exists to prevent, so what it did last and
 * when is always on screen rather than hidden behind a successful-looking checkbox.
 */
function SyncPanel({ app }: { app: App }) {
  const config = app.sync
  const [repoInput, setRepoInput] = useState(
    config.owner === '' ? '' : `${config.owner}/${config.repo}`,
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function commitRepo(raw: string) {
    setRepoInput(raw)
    if (raw.trim() === '') {
      app.updateSync({ owner: '', repo: '' })
      return
    }
    const parsed = parseRepoRef(raw)
    if (parsed === null) {
      setMessage('Repository muss die Form „benutzername/repo“ haben.')
      return
    }
    setMessage(null)
    app.updateSync(parsed)
  }

  async function runTest() {
    setBusy(true)
    setMessage('Wird geprüft…')
    try {
      const result = await app.testSync()
      if (!result.ok) {
        setMessage(result.error)
      } else if (!result.private) {
        setMessage(
          'Verbindung steht — aber das Repository ist öffentlich. Der Lernverlauf wäre für ' +
            'jeden lesbar. Besser ein privates Repository verwenden.',
        )
      } else {
        setMessage(`Verbindung steht. Privates Repository, Branch „${result.defaultBranch}“.`)
      }
    } finally {
      setBusy(false)
    }
  }

  async function runSyncNow() {
    setBusy(true)
    setMessage('Wird hochgeladen…')
    try {
      const result = await app.syncNow()
      if (result === null) {
        setMessage('Noch nicht vollständig eingerichtet.')
      } else if (result.lastError !== null) {
        // The stored error is already on screen below; repeating it here would show
        // the same sentence twice.
        setMessage(null)
      } else {
        setMessage(`Hochgeladen: ${formatWhen(result.lastSyncAt)}.`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="panel">
      <h2>Automatische Sicherung</h2>
      <p class="field-hint">
        Lädt den Lernfortschritt von selbst in ein privates GitHub-Repository, höchstens einmal
        pro Stunde und nur wenn seither gelernt wurde. Jeder Upload ist ein Commit, also bleibt
        auch jede frühere Fassung erhalten.
      </p>

      <div class="row">
        <span class="row-label">Status</span>
        <span
          class={`row-value ${app.syncHealth === 'failing' || app.syncHealth === 'pending' ? 'row-value-warn' : ''}`}
        >
          {HEALTH_LABEL[app.syncHealth]}
        </span>
      </div>
      <div class="row">
        <span class="row-label">Letzte Sicherung</span>
        <span class="row-value">{formatWhen(config.lastSyncAt)}</span>
      </div>

      <div class="field">
        <label for="sync-repo">Repository</label>
        <input
          id="sync-repo"
          type="text"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          placeholder="benutzername/german-flashcards-backup"
          value={repoInput}
          onChange={(event) => commitRepo((event.target as HTMLInputElement).value)}
        />
        <span class="field-hint">
          Ein eigenes, privates Repository — nicht das mit den Vokabeln, sonst löst jede Sicherung
          einen Deploy aus.
        </span>
      </div>

      <div class="field">
        <label for="sync-path">Datei im Repository</label>
        <input
          id="sync-path"
          type="text"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          value={config.path}
          onChange={(event) => app.updateSync({ path: (event.target as HTMLInputElement).value })}
        />
      </div>

      <div class="field">
        <label for="sync-token">Zugriffstoken</label>
        <input
          id="sync-token"
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder="github_pat_…"
          value={config.token}
          onChange={(event) => app.updateSync({ token: (event.target as HTMLInputElement).value })}
        />
        <span class="field-hint">
          Fine-grained Token, nur für dieses eine Repository, Berechtigung „Contents: read and
          write“. Es bleibt auf diesem Gerät und steht in keiner heruntergeladenen Sicherung.
        </span>
      </div>

      <div class="field">
        <label class="field-check">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) =>
              app.updateSync({ enabled: (event.target as HTMLInputElement).checked })
            }
          />
          Automatisch sichern
        </label>
      </div>

      <div class="field">
        <div class="button-row">
          <button class="button" disabled={busy} onClick={() => void runTest()}>
            Verbindung testen
          </button>
          <button class="button" disabled={busy} onClick={() => void runSyncNow()}>
            Jetzt sichern
          </button>
        </div>
      </div>

      {config.lastError !== null ? (
        <div class="notice notice-warn">{config.lastError}</div>
      ) : null}
      {message !== null ? <div class="notice">{message}</div> : null}
    </div>
  )
}

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

      <SyncPanel app={app} />

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
