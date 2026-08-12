import { useMemo } from 'preact/hooks'
import { computeStats } from '../core/stats'
import type { App } from '../state'

export function Stats({ app }: { app: App }) {
  const stats = useMemo(
    () => computeStats(app.items, app.log, app.now, app.settings.scheduler.dayStartHour),
    [app.items, app.log, app.now, app.settings.scheduler.dayStartHour],
  )

  const peak = Math.max(1, ...stats.reviewsPerDay)

  return (
    <>
      <div class="panel">
        <h2>Sammlung</h2>
        <div class="row">
          <span class="row-label">Neu</span>
          <span class="row-value">{stats.fresh}</span>
        </div>
        <div class="row">
          <span class="row-label">Im Lernen</span>
          <span class="row-value">{stats.learning}</span>
        </div>
        <div class="row">
          <span class="row-label">Jung (&lt; 21 Tage)</span>
          <span class="row-value">{stats.young}</span>
        </div>
        <div class="row">
          <span class="row-label">Gefestigt (≥ 21 Tage)</span>
          <span class="row-value">{stats.mature}</span>
        </div>
        <div class="row">
          <span class="row-label">Insgesamt</span>
          <span class="row-value">{stats.total}</span>
        </div>
      </div>

      <div class="panel">
        <h2>Letzte 30 Tage</h2>
        <div class="bars" aria-hidden="true">
          {stats.reviewsPerDay.map((count, index) => (
            <div
              key={index}
              class={`bar ${count === 0 ? 'bar-empty' : ''}`}
              style={{ height: `${Math.max(2, (count / peak) * 100)}%` }}
            />
          ))}
        </div>
        <div class="bars-axis">
          <span>vor 30 Tagen</span>
          <span>heute</span>
        </div>
        <p class="visually-hidden">
          {stats.reviewsPerDay.reduce((sum, count) => sum + count, 0)} Wiederholungen in den letzten
          30 Tagen.
        </p>
      </div>

      <div class="panel">
        <h2>Leistung</h2>
        <div class="row">
          <span class="row-label">Trefferquote (30 Tage)</span>
          <span class="row-value">
            {stats.retention === null ? '–' : `${Math.round(stats.retention * 100)} %`}
          </span>
        </div>
        <div class="row">
          <span class="row-label">Serie</span>
          <span class="row-value">{stats.streakDays} Tage</span>
        </div>
        <div class="row">
          <span class="row-label">Wiederholungen insgesamt</span>
          <span class="row-value">{stats.reviewsAllTime}</span>
        </div>
      </div>
    </>
  )
}
