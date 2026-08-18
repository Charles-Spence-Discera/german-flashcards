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
import { buildQueue, dailyCounts, pinActive, queueCounts, type QueueCounts } from './core/queue'
import { createSm2Scheduler, type Scheduler } from './core/scheduler'
import { parseVocabFile, type Problem } from './core/schema'
import { withDefaults, type AppSettings } from './core/settings'
import { backupFilename, openStore, type ImportMode, type ImportSummary, type Store } from './core/storage'
import {
  applyPushResult,
  backupFingerprint,
  isThrottled,
  pushBackup,
  sameTarget,
  syncHealth,
  syncReady,
  testConnection,
  withSyncDefaults,
  type SyncConfig,
  type SyncHealth,
} from './core/sync'
import type { Grade, ReviewItem, ReviewLogEntry, VocabFile } from './core/types'

export type Screen = 'home' | 'review' | 'stats' | 'settings'

export interface LoadedState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  /** False when IndexedDB was unavailable and progress will not survive the session. */
  durable: boolean
  /** When the vocabulary could not be fetched, the timestamp of the copy in use. */
  offlineSince: string | null
  file: VocabFile | null
  /** Issues found in the vocab file, surfaced so bad data is visible rather than silent. */
  problems: Problem[]
  items: ReviewItem[]
  log: ReviewLogEntry[]
  settings: AppSettings
  /** Where automatic backups go, and how the last one went. */
  sync: SyncConfig
}

const VOCAB_URL = `${import.meta.env.BASE_URL}data/vocab.json`

/** How often the clock is re-read, so learning steps become due without a reload. */
const TICK_MS = 5_000

/**
 * Asks the browser to exempt this origin from storage eviction.
 *
 * Without it, IndexedDB is "best effort" — Chrome may discard the whole database
 * under storage pressure, taking every review with it and asking nobody. Installed
 * PWAs are usually granted this silently; a refusal is not worth reporting, since
 * the app cannot do anything about it and automatic backup covers the same risk.
 */
async function requestPersistence(): Promise<void> {
  try {
    if (!navigator.storage?.persist) return
    if (await navigator.storage.persisted()) return
    await navigator.storage.persist()
  } catch {
    /* not supported, or refused — either way there is nothing to do */
  }
}

export function useApp() {
  const [state, setState] = useState<LoadedState>({
    status: 'loading',
    error: null,
    durable: true,
    offlineSince: null,
    file: null,
    problems: [],
    items: [],
    log: [],
    settings: withDefaults(null),
    sync: withSyncDefaults(null),
  })
  const [screen, setScreen] = useState<Screen>('home')
  const [tick, setTick] = useState(0)
  const storeRef = useRef<Store | null>(null)
  // The sync config is read and written outside React's render cycle, by a push that
  // may outlive the state update that triggered it. The ref is the authoritative copy.
  const syncRef = useRef<SyncConfig>(withSyncDefaults(null))
  const pushingRef = useRef(false)

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
      const sync = await store.loadSyncConfig()
      syncRef.current = sync

      /*
       * Fetch first, fall back to the last good copy.
       *
       * The service worker's network-first rule covers this too, but only from the
       * second visit onwards — on a first load the worker has not taken control yet,
       * so that fetch never reaches it. Installing the app and immediately going
       * offline would otherwise leave it with no words at all. Keeping our own
       * snapshot makes offline independent of worker lifecycle, and also survives
       * GitHub Pages being unreachable.
       */
      let raw: unknown
      let offlineSince: string | null = null
      try {
        const response = await fetch(VOCAB_URL)
        if (!response.ok) {
          throw new Error(`Could not load the vocabulary file (HTTP ${response.status}).`)
        }
        raw = await response.json()
        // Store the unparsed JSON: a future build may read it differently.
        void store.saveVocabSnapshot(raw)
      } catch (fetchError) {
        const snapshot = await store.loadVocabSnapshot()
        if (snapshot === null) throw fetchError
        raw = snapshot.raw
        offlineSince = snapshot.at
      }

      const { file, problems } = parseVocabFile(raw)

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
        offlineSince,
        file,
        problems,
        items: merged.items,
        log,
        settings,
        sync,
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
    void requestPersistence()
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

  /**
   * The card on screen, held across background queue rebuilds.
   *
   * The queue is rebuilt on every clock tick, which reshuffles reviews and can
   * promote a newly-due learning card to the front. Without this, the card being
   * read would swap itself out mid-look. The ref is updated during render so the
   * very next rebuild already knows what is on screen.
   */
  const activeKeyRef = useRef<string | null>(null)

  const rebuilt = useMemo(() => buildQueue(queueInput), [queueInput])
  const queue = useMemo(() => pinActive(rebuilt, activeKeyRef.current), [rebuilt])
  activeKeyRef.current = queue[0]?.state.key ?? null

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

  /** Identifies the history as it stands, so an unchanged corpus is not re-uploaded. */
  const fingerprint = useMemo(() => backupFingerprint(state.log), [state.log])

  const persistSync = useCallback((config: SyncConfig) => {
    syncRef.current = config
    const store = storeRef.current
    if (store) void store.saveSyncConfig(config)
    setState((previous) => ({ ...previous, sync: config }))
  }, [])

  /**
   * Uploads the backup, if there is a reason to.
   *
   * Called on a timer and after every answer, so the cheap checks come first: the
   * throttle and the configuration are consulted before anything touches IndexedDB,
   * and the export — three store reads — happens at most once an hour. `force` is the
   * button in Settings, which skips both the throttle and the unchanged check because
   * the user pressing it *is* the reason.
   *
   * Failures are recorded rather than thrown. This runs unattended; the honest place
   * for a broken token is the sync status in the UI, not an exception nobody catches.
   */
  const runSync = useCallback(
    async (force: boolean): Promise<SyncConfig | null> => {
      const store = storeRef.current
      const config = syncRef.current
      if (!store || pushingRef.current) return null
      if (!syncReady(config)) return null
      if (!force && isThrottled(config, new Date())) return null

      pushingRef.current = true
      try {
        const backup = await store.exportAll(scheduler.id)
        const pushed = backupFingerprint(backup.log)
        if (!force && config.lastFingerprint === pushed) return null

        const at = new Date()
        const result = await pushBackup(config, backup, at)

        // Settings may have been edited while the request was in flight. A new target
        // has its own history and must not inherit this one's sha or timestamp, so
        // the result is dropped and the next tick pushes to the new place instead.
        const current = syncRef.current
        if (!sameTarget(current, config)) return null

        const next = applyPushResult(current, result, pushed, at)
        persistSync(next)
        return next
      } finally {
        pushingRef.current = false
      }
    },
    [persistSync, scheduler.id],
  )

  /*
   * The tick is already running for the clock, so riding it costs one comparison every
   * five seconds and needs no scheduling of its own. `state.log.length` is in the
   * dependencies so that finishing a session pushes promptly rather than waiting out
   * the tick, subject to the same throttle.
   */
  useEffect(() => {
    if (state.status !== 'ready') return
    void runSync(false)
  }, [state.status, state.log.length, tick, runSync])

  /**
   * Applies a settings change from the UI.
   *
   * Pointing at a different repository, branch or path starts over completely: the
   * cached blob sha describes a file somewhere else, and reporting the old target's
   * timestamp as this one's last backup would be a lie of exactly the kind this
   * feature exists to prevent. Clearing the throttle too means the new target gets
   * its first push immediately rather than an hour later.
   */
  const updateSync = useCallback(
    (patch: Partial<SyncConfig>) => {
      const previous = syncRef.current
      const next = withSyncDefaults({ ...previous, ...patch })
      const retargeted =
        next.owner !== previous.owner ||
        next.repo !== previous.repo ||
        next.path !== previous.path ||
        next.branch !== previous.branch
      persistSync(
        retargeted
          ? {
              ...next,
              sha: null,
              lastFingerprint: null,
              lastAttemptAt: null,
              lastSyncAt: null,
              lastError: null,
            }
          : next,
      )
    },
    [persistSync],
  )

  const health: SyncHealth = useMemo(
    () => syncHealth(state.sync, fingerprint, now),
    [state.sync, fingerprint, now],
  )

  /** Verifies the repository before the user trusts a month of history to it. */
  const testSync = useCallback(() => testConnection(syncRef.current), [])

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
    updateSync,
    syncNow: () => runSync(true),
    syncHealth: health,
    testSync,
    reload: load,
  }
}

export type App = ReturnType<typeof useApp>
