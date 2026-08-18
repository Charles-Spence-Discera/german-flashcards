/**
 * Persistence for review progress.
 *
 * IndexedDB holds the only copy of scheduling state, which makes it the most
 * valuable data the app touches — the vocab file can always be regenerated, months
 * of review history cannot. Three consequences shape this module:
 *
 * - **Never silently lose the store.** If IndexedDB is unavailable (private
 *   browsing, a locked-down webview), the app degrades to an in-memory store and
 *   says so, rather than throwing on load.
 * - **Backups are first class.** `exportAll` produces a plain JSON file the user can
 *   keep anywhere, and `importAll` restores it, including onto a device that has
 *   since been studied on.
 * - **Writes are additive.** The only deletion path is `deleteStates`, which the
 *   merge step populates solely from completed renames.
 */

import type { AppSettings } from './settings'
import { withDefaults } from './settings'
import type { SyncConfig } from './sync'
import { withSyncDefaults } from './sync'
import type { ReviewLogEntry, ReviewState } from './types'

const DB_NAME = 'german-flashcards'
// v2 added the vocab snapshot store, v3 the sync configuration. Upgrades only ever
// add stores, so existing review history survives untouched.
const DB_VERSION = 3

const STORE_STATES = 'states'
const STORE_LOG = 'log'
const STORE_SETTINGS = 'settings'
const STORE_VOCAB = 'vocab'
// Deliberately not part of `settings`: settings are written into every backup, and
// backups are uploaded, so a token stored there would publish itself.
const STORE_SYNC = 'sync'

export const BACKUP_KIND = 'german-flashcards-backup'
export const BACKUP_VERSION = 1

export interface BackupFile {
  kind: typeof BACKUP_KIND
  backupVersion: number
  exportedAt: string
  /** Which scheduling algorithm produced these states. */
  schedulerId: string
  states: ReviewState[]
  log: ReviewLogEntry[]
  settings: AppSettings | null
}

export interface ImportSummary {
  added: number
  updated: number
  /** Incoming states skipped because the local copy was reviewed more recently. */
  keptLocal: number
  logEntries: number
  settingsRestored: boolean
}

export type ImportMode = 'merge' | 'replace'

/** The last vocabulary file successfully fetched, kept so the app works offline. */
export interface VocabSnapshot {
  /** Unparsed JSON exactly as fetched, so a future build's parser can reinterpret it. */
  raw: unknown
  /** ISO timestamp of the fetch. */
  at: string
}

export interface Store {
  /** True when backed by IndexedDB; false means progress lasts only this session. */
  readonly durable: boolean
  loadStates(): Promise<Map<string, ReviewState>>
  putStates(states: ReviewState[]): Promise<void>
  deleteStates(keys: string[]): Promise<void>
  appendLog(entries: ReviewLogEntry[]): Promise<void>
  loadLog(): Promise<ReviewLogEntry[]>
  loadSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<void>
  loadSyncConfig(): Promise<SyncConfig>
  saveSyncConfig(config: SyncConfig): Promise<void>
  saveVocabSnapshot(raw: unknown): Promise<void>
  loadVocabSnapshot(): Promise<VocabSnapshot | null>
  exportAll(schedulerId: string): Promise<BackupFile>
  importAll(backup: unknown, mode: ImportMode): Promise<ImportSummary>
  close(): void
}

/* -------------------------------------------------------------------------- */
/* IndexedDB plumbing                                                          */
/* -------------------------------------------------------------------------- */

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function promisifyTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_STATES)) {
        db.createObjectStore(STORE_STATES, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(STORE_LOG)) {
        // Out-of-line auto-incrementing keys: log entries are append-only and are
        // never addressed individually, so they carry no id of their own.
        db.createObjectStore(STORE_LOG, { autoIncrement: true })
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_VOCAB)) {
        db.createObjectStore(STORE_VOCAB, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_SYNC)) {
        db.createObjectStore(STORE_SYNC, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab.'))
  })
}

/* -------------------------------------------------------------------------- */
/* Backup validation and merge policy                                          */
/* -------------------------------------------------------------------------- */

/** Structural check on an imported file, before any of it reaches the database. */
export function parseBackup(input: unknown): { backup: BackupFile } | { error: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'That file is not a backup: expected a JSON object.' }
  }
  const raw = input as Record<string, unknown>
  if (raw.kind !== BACKUP_KIND) {
    return { error: 'That file is not a German Flashcards backup.' }
  }
  if (typeof raw.backupVersion !== 'number' || raw.backupVersion > BACKUP_VERSION) {
    return {
      error: `Backup version ${String(raw.backupVersion)} is newer than this app understands.`,
    }
  }
  if (!Array.isArray(raw.states)) {
    return { error: 'Backup is missing its "states" list.' }
  }

  const states = raw.states.filter(
    (state): state is ReviewState =>
      state !== null &&
      typeof state === 'object' &&
      typeof (state as ReviewState).key === 'string' &&
      typeof (state as ReviewState).cardId === 'string' &&
      typeof (state as ReviewState).due === 'string',
  )

  const log = Array.isArray(raw.log)
    ? raw.log.filter(
        (entry): entry is ReviewLogEntry =>
          entry !== null && typeof entry === 'object' && typeof (entry as ReviewLogEntry).key === 'string',
      )
    : []

  return {
    backup: {
      kind: BACKUP_KIND,
      backupVersion: raw.backupVersion,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
      schedulerId: typeof raw.schedulerId === 'string' ? raw.schedulerId : 'unknown',
      states,
      log,
      settings:
        raw.settings !== null && typeof raw.settings === 'object'
          ? withDefaults(raw.settings as Partial<AppSettings>)
          : null,
    },
  }
}

/**
 * Decides which of two copies of the same item to keep when merging a backup.
 *
 * Restoring a backup onto a device that has been studied on since the export must
 * not roll that studying back, so the more recently reviewed copy wins. Reps break
 * ties, and an unreviewed copy always loses to a reviewed one.
 */
export function preferNewer(local: ReviewState, incoming: ReviewState): ReviewState {
  const localTime = local.lastReviewed ? Date.parse(local.lastReviewed) : -Infinity
  const incomingTime = incoming.lastReviewed ? Date.parse(incoming.lastReviewed) : -Infinity
  if (incomingTime > localTime) return incoming
  if (localTime > incomingTime) return local
  return incoming.reps > local.reps ? incoming : local
}

/* -------------------------------------------------------------------------- */
/* IndexedDB-backed store                                                      */
/* -------------------------------------------------------------------------- */

function createIdbStore(db: IDBDatabase): Store {
  async function readAll<T>(storeName: string): Promise<T[]> {
    const transaction = db.transaction(storeName, 'readonly')
    const result = await promisifyRequest<T[]>(
      transaction.objectStore(storeName).getAll() as IDBRequest<T[]>,
    )
    await promisifyTransaction(transaction)
    return result
  }

  const store: Store = {
    durable: true,

    async loadStates() {
      const states = await readAll<ReviewState>(STORE_STATES)
      return new Map(states.map((state) => [state.key, state]))
    },

    async putStates(states) {
      if (states.length === 0) return
      const transaction = db.transaction(STORE_STATES, 'readwrite')
      const objectStore = transaction.objectStore(STORE_STATES)
      for (const state of states) objectStore.put(state)
      await promisifyTransaction(transaction)
    },

    async deleteStates(keys) {
      if (keys.length === 0) return
      const transaction = db.transaction(STORE_STATES, 'readwrite')
      const objectStore = transaction.objectStore(STORE_STATES)
      for (const key of keys) objectStore.delete(key)
      await promisifyTransaction(transaction)
    },

    async appendLog(entries) {
      if (entries.length === 0) return
      const transaction = db.transaction(STORE_LOG, 'readwrite')
      const objectStore = transaction.objectStore(STORE_LOG)
      for (const entry of entries) objectStore.add(entry)
      await promisifyTransaction(transaction)
    },

    loadLog() {
      return readAll<ReviewLogEntry>(STORE_LOG)
    },

    async loadSettings() {
      const transaction = db.transaction(STORE_SETTINGS, 'readonly')
      const stored = await promisifyRequest<AppSettings | undefined>(
        transaction.objectStore(STORE_SETTINGS).get('settings') as IDBRequest<AppSettings | undefined>,
      )
      await promisifyTransaction(transaction)
      return withDefaults(stored)
    },

    async saveSettings(settings) {
      const transaction = db.transaction(STORE_SETTINGS, 'readwrite')
      transaction.objectStore(STORE_SETTINGS).put(settings)
      await promisifyTransaction(transaction)
    },

    async loadSyncConfig() {
      const transaction = db.transaction(STORE_SYNC, 'readonly')
      const stored = await promisifyRequest<SyncConfig | undefined>(
        transaction.objectStore(STORE_SYNC).get('sync') as IDBRequest<SyncConfig | undefined>,
      )
      await promisifyTransaction(transaction)
      return withSyncDefaults(stored)
    },

    async saveSyncConfig(config) {
      const transaction = db.transaction(STORE_SYNC, 'readwrite')
      transaction.objectStore(STORE_SYNC).put(config)
      await promisifyTransaction(transaction)
    },

    async saveVocabSnapshot(raw) {
      const transaction = db.transaction(STORE_VOCAB, 'readwrite')
      transaction.objectStore(STORE_VOCAB).put({ id: 'vocab', raw, at: new Date().toISOString() })
      await promisifyTransaction(transaction)
    },

    async loadVocabSnapshot() {
      const transaction = db.transaction(STORE_VOCAB, 'readonly')
      const stored = await promisifyRequest<(VocabSnapshot & { id: string }) | undefined>(
        transaction.objectStore(STORE_VOCAB).get('vocab') as IDBRequest<
          (VocabSnapshot & { id: string }) | undefined
        >,
      )
      await promisifyTransaction(transaction)
      return stored ? { raw: stored.raw, at: stored.at } : null
    },

    async exportAll(schedulerId) {
      // Note what is absent: the sync configuration, which holds an access token.
      // Backups travel — by upload, by email, onto other devices — so nothing secret
      // may be in one.
      const [states, log, settings] = await Promise.all([
        store.loadStates(),
        store.loadLog(),
        store.loadSettings(),
      ])
      return {
        kind: BACKUP_KIND,
        backupVersion: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        schedulerId,
        states: [...states.values()],
        log,
        settings,
      }
    },

    async importAll(input, mode) {
      const parsed = parseBackup(input)
      if ('error' in parsed) throw new Error(parsed.error)
      const { backup } = parsed

      const summary: ImportSummary = {
        added: 0,
        updated: 0,
        keptLocal: 0,
        logEntries: 0,
        settingsRestored: false,
      }

      if (mode === 'replace') {
        const wipe = db.transaction([STORE_STATES, STORE_LOG], 'readwrite')
        wipe.objectStore(STORE_STATES).clear()
        wipe.objectStore(STORE_LOG).clear()
        await promisifyTransaction(wipe)
      }

      const local = await store.loadStates()
      const toWrite: ReviewState[] = []
      for (const incoming of backup.states) {
        const existing = local.get(incoming.key)
        if (existing === undefined) {
          toWrite.push(incoming)
          summary.added++
          continue
        }
        const winner = preferNewer(existing, incoming)
        if (winner === incoming) {
          toWrite.push(incoming)
          summary.updated++
        } else {
          summary.keptLocal++
        }
      }
      await store.putStates(toWrite)

      if (mode === 'replace' && backup.log.length > 0) {
        await store.appendLog(backup.log)
        summary.logEntries = backup.log.length
      }

      if (backup.settings) {
        await store.saveSettings(backup.settings)
        summary.settingsRestored = true
      }

      return summary
    },

    close() {
      db.close()
    },
  }

  return store
}

/* -------------------------------------------------------------------------- */
/* In-memory fallback                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Used when IndexedDB cannot be opened. Reviewing still works for the session; the
 * UI is responsible for warning that nothing will be saved.
 */
export function createMemoryStore(): Store {
  const states = new Map<string, ReviewState>()
  let log: ReviewLogEntry[] = []
  let settings: AppSettings | null = null
  let syncConfig: SyncConfig | null = null
  let snapshot: VocabSnapshot | null = null

  const store: Store = {
    durable: false,
    async loadStates() {
      return new Map(states)
    },
    async putStates(incoming) {
      for (const state of incoming) states.set(state.key, state)
    },
    async deleteStates(keys) {
      for (const key of keys) states.delete(key)
    },
    async appendLog(entries) {
      log = log.concat(entries)
    },
    async loadLog() {
      return [...log]
    },
    async loadSettings() {
      return withDefaults(settings)
    },
    async saveSettings(next) {
      settings = next
    },
    async loadSyncConfig() {
      return withSyncDefaults(syncConfig)
    },
    async saveSyncConfig(next) {
      syncConfig = next
    },
    async saveVocabSnapshot(raw) {
      snapshot = { raw, at: new Date().toISOString() }
    },
    async loadVocabSnapshot() {
      return snapshot
    },
    async exportAll(schedulerId) {
      return {
        kind: BACKUP_KIND,
        backupVersion: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        schedulerId,
        states: [...states.values()],
        log: [...log],
        settings: withDefaults(settings),
      }
    },
    async importAll(input, mode) {
      const parsed = parseBackup(input)
      if ('error' in parsed) throw new Error(parsed.error)
      const { backup } = parsed
      const summary: ImportSummary = {
        added: 0,
        updated: 0,
        keptLocal: 0,
        logEntries: 0,
        settingsRestored: false,
      }
      if (mode === 'replace') {
        states.clear()
        log = []
      }
      for (const incoming of backup.states) {
        const existing = states.get(incoming.key)
        if (existing === undefined) {
          states.set(incoming.key, incoming)
          summary.added++
          continue
        }
        const winner = preferNewer(existing, incoming)
        if (winner === incoming) {
          states.set(incoming.key, incoming)
          summary.updated++
        } else {
          summary.keptLocal++
        }
      }
      if (mode === 'replace' && backup.log.length > 0) {
        log = log.concat(backup.log)
        summary.logEntries = backup.log.length
      }
      if (backup.settings) {
        settings = backup.settings
        summary.settingsRestored = true
      }
      return summary
    },
    close() {
      /* nothing to release */
    },
  }

  return store
}

/**
 * Opens the durable store, falling back to memory if IndexedDB is unusable.
 * Never rejects — losing persistence must not stop the app from starting.
 */
export async function openStore(): Promise<Store> {
  if (typeof indexedDB === 'undefined') return createMemoryStore()
  try {
    return createIdbStore(await openDatabase())
  } catch {
    return createMemoryStore()
  }
}

/** Filename for a downloaded backup, dated so successive exports do not collide. */
export function backupFilename(at: Date = new Date()): string {
  const date = at.toISOString().slice(0, 10)
  return `german-flashcards-backup-${date}.json`
}
