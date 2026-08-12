import { Home } from './ui/Home'
import { Review } from './ui/Review'
import { Settings } from './ui/Settings'
import { Stats } from './ui/Stats'
import { useApp, type Screen } from './state'

const NAV: { screen: Screen; label: string; title: string }[] = [
  { screen: 'home', label: '☰', title: 'Übersicht' },
  { screen: 'stats', label: '◔', title: 'Statistik' },
  { screen: 'settings', label: '⚙', title: 'Einstellungen' },
]

const TITLES: Record<Screen, string> = {
  home: 'German Flashcards',
  review: 'Wiederholen',
  stats: 'Statistik',
  settings: 'Einstellungen',
}

export function App() {
  const app = useApp()

  return (
    <div class="app">
      <header class="header">
        <h1>{TITLES[app.screen]}</h1>
        <nav class="header-actions">
          {app.screen === 'review' ? (
            <button class="icon-button" onClick={() => app.setScreen('home')} title="Beenden">
              ✕
            </button>
          ) : (
            NAV.map(({ screen, label, title }) => (
              <button
                key={screen}
                class="icon-button"
                aria-current={app.screen === screen}
                title={title}
                onClick={() => app.setScreen(screen)}
              >
                {label}
              </button>
            ))
          )}
        </nav>
      </header>

      <main class="main">
        {app.status === 'loading' ? (
          <div class="centered">
            <p>Wird geladen…</p>
          </div>
        ) : app.status === 'error' ? (
          <div class="centered">
            <strong>Vokabeln konnten nicht geladen werden.</strong>
            <p>{app.error}</p>
            <button class="button button-primary" onClick={() => void app.reload()}>
              Erneut versuchen
            </button>
          </div>
        ) : app.screen === 'review' ? (
          <Review app={app} />
        ) : app.screen === 'stats' ? (
          <Stats app={app} />
        ) : app.screen === 'settings' ? (
          <Settings app={app} />
        ) : (
          <Home app={app} />
        )}
      </main>
    </div>
  )
}
