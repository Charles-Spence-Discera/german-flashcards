/**
 * Application state: loading, reviewing, and persisting.
 *
 * All the decision-making lives in `src/core` as pure functions. This module is the
 * shell around them — it owns the effects (fetching, storing) and the React-ish
 * state, and nothing more. Anything worth testing should be pushed down into core
 * rather than added here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { mergeProgress } from './core/merge'
import { buildQueue, dailyCounts, queueCounts, type QueueCounts } from './core/queue'
import { createSm2Scheduler, type Scheduler } from './core/scheduler'
import { parseVocabFile, type Problem } from './core/schema'
import { withDefaults, type AppSettings } from './core/settings'
import { backupFilename, openStore, type ImportMode, type ImportSummary, type Store } from './core/storage'
import type { Grade, ReviewItem, ReviewLogEntry, VocabFile } from './core/types'

export type Screen = 'home' | 'review' | 'stats' | 'settings'

export interface LoadedState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  /** False when IndexedDB was unavailable and progress will not survive the session. */
  durable: boolean
  file: VocabFile | null
  /** Issues found in the vocab file, surfaced so bad data is visible rather than silent. */
  problems: Problem[]
  items: ReviewItem[]
  log: ReviewLogEntry[]
  settings: AppSettings
}

const VOCAB_URL = `${import.meta.env.BASE_URL}data/vocab.json`

/** How often the clock is re-read, so learning steps become due without a reload. */
const TICK_MS = 5_000

export function useApp() {
  const [state, setState] = useState<LoadedState>({
    status: 'loading',
    error: null,
    durable: true,
    file: null,
    problems: [],
    items: [],
    log: [],
    settings: withDefaults(null),
  })
  const [screen, setScreen] = useState<Screen>('home')
  const [tick, setTick] = useState(0)
  const storeRef = useRef<Store | null>(null)

  const scheduler: Scheduler = useMemo(
    () => createSm2Scheduler(state.settings.scheduler),
    [state.settings.scheduler],
  )

  /** Re-read on every tick so that `isDue` advances during a session. */
  const now = useMemo(() => new Date(), [tick])

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const load = useCallback(async () => {
    setState((previous) => ({ ...previous, status: 'loading', error: null }))
    try {
      const store = storeRef.current ?? (await openStore())
      storeRef.current = store

      const settings = await store.loadSettings()

      const response = await fetch(VOCAB_URL)
      if (!response.ok) {
        throw new Error(`Could not load the vocabulary file (HTTP ${response.status}).`)
      }
      const { file, problems } = parseVocabFile(await response.json())

      const stored = await store.loadStates()
      const activeScheduler = createSm2Scheduler(settings.scheduler)
      const merged = mergeProgress({
        cards: file.cards,
        stored,
        modes: settings.activeModes,
        scheduler: activeScheduler,
      })

      // Persist only what the merge decided is genuinely new or renamed. Existing
      // progress is never rewritten, so a load can never damage it.
      await store.putStates(merged.toPersist)
      await store.deleteStates(merged.toDelete)

      const log = await store.loadLog()

      setState({
        status: 'ready',
        error: null,
        durable: store.durable,
        file,
        problems,
        items: merged.items,
        log,
        settings,
      })
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'Something went wrong loading the vocabulary file.',
      }))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const doneToday = useMemo(
    () => dailyCounts(state.log, now, state.settings.scheduler.dayStartHour),
    [state.log, now, state.settings.scheduler.dayStartHour],
  )

  const activeDeck = useMemo(() => {
    if (!state.file || state.settings.activeDeckId === null) return null
    return state.file.decks.find((deck) => deck.id === state.settings.activeDeckId) ?? null
  }, [state.file, state.settings.activeDeckId])

  const queueInput = useMemo(
    () => ({
      items: state.items,
      settings: state.settings,
      doneToday,
      now,
      deck: activeDeck,
    }),
    [state.items, state.settings, doneToday, now, activeDeck],
  )

  const queue = useMemo(() => buildQueue(queueInput), [queueInput])
  const counts: QueueCounts = useMemo(() => queueCounts(queueInput), [queueInput])

  /**
   * Records an answer.
   *
   * Local state updates first so the next card appears immediately; the write is
   * awaited afterwards. On a phone, a synchronous-feeling answer matters more than
   * knowing the write landed before painting — and a lost write costs one review,
   * not the history.
   */
  const answer = useCallback(
    (item: ReviewItem, grade: Grade, elapsedMs?: number) => {
      const at = new Date()
      const next = scheduler.review(item.state, grade, at)
      const entry: ReviewLogEntry = {
        key: next.key,
        at: at.toISOString(),
        grade,
        phaseBefore: item.state.phase,
        prevIntervalDays: item.state.intervalDays,
        nextIntervalDays: next.intervalDays,
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      }

      setState((previous) => ({
        ...previous,
        items: previous.items.map((candidate) =>
          candidate.state.key === next.key ? { card: candidate.card, state: next } : candidate,
        ),
        log: [...previous.log, entry],
      }))

      const store = storeRef.current
      if (store) {
        void store.putStates([next])
        void store.appendLog([entry])
      }
    },
    [scheduler],
  )

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setState((previous) => {
      const settings = withDefaults({ ...previous.settings, ...patch })
      const store = storeRef.current
      if (store) void store.saveSettings(settings)
      return { ...previous, settings }
    })
  }, [])

  /** Serialises all progress to a file the user keeps. The only real backup. */
  const exportBackup = useCallback(async () => {
    const store = storeRef.current
    if (!store) return
    const backup = await store.exportAll(scheduler.id)
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = backupFilename()
    link.click()
    URL.revokeObjectURL(url)
  }, [scheduler.id])

  const importBackup = useCallback(
    async (fileContents: string, mode: ImportMode): Promise<ImportSummary> => {
      const store = storeRef.current
      if (!store) throw new Error('Storage is not ready yet.')
      const summary = await store.importAll(JSON.parse(fileContents), mode)
      await load()
      return summary
    },
    [load],
  )

  return {
    ...state,
    screen,
    setScreen,
    scheduler,
    now,
    queue,
    counts,
    doneToday,
    activeDeck,
    answer,
    updateSettings,
    exportBackup,
    importBackup,
    reload: load,
  }
}

export type App = ReturnType<typeof useApp>
