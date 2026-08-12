import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  backupFilename,
  createMemoryStore,
  openStore,
  parseBackup,
  preferNewer,
  type Store,
} from './storage'
import { DEFAULT_APP_SETTINGS } from './settings'
import type { ReviewLogEntry, ReviewState } from './types'

function state(key: string, overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    key,
    cardId: key.split('::')[0] ?? key,
    mode: 'de-en',
    phase: 'review',
    ease: 2.5,
    intervalDays: 10,
    learningStep: -1,
    due: '2026-09-01T04:00:00.000Z',
    lastReviewed: '2026-08-01T10:00:00.000Z',
    reps: 4,
    lapses: 0,
    ...overrides,
  }
}

function logEntry(key: string): ReviewLogEntry {
  return {
    key,
    at: '2026-08-01T10:00:00.000Z',
    grade: 'good',
    phaseBefore: 'review',
    prevIntervalDays: 4,
    nextIntervalDays: 10,
  }
}

function resetDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('german-flashcards')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

// Both implementations must behave identically, so the whole suite runs twice.
const implementations: [string, () => Promise<Store>][] = [
  ['indexeddb', () => openStore()],
  ['memory', async () => createMemoryStore()],
]

describe.each(implementations)('store: %s', (name, create) => {
  let store: Store

  beforeEach(async () => {
    if (name === 'indexeddb') await resetDatabase()
    store = await create()
  })

  // An open connection blocks deleteDatabase indefinitely, so the next test's
  // reset would hang rather than fail.
  afterEach(() => {
    store.close()
  })

  it('round-trips review states', async () => {
    await store.putStates([state('a::de-en'), state('b::de-en')])
    const loaded = await store.loadStates()
    expect(loaded.size).toBe(2)
    expect(loaded.get('a::de-en')).toMatchObject({ cardId: 'a', reps: 4 })
  })

  it('starts empty', async () => {
    expect((await store.loadStates()).size).toBe(0)
  })

  it('overwrites a state with the same key', async () => {
    await store.putStates([state('a::de-en', { reps: 1 })])
    await store.putStates([state('a::de-en', { reps: 7 })])
    const loaded = await store.loadStates()
    expect(loaded.size).toBe(1)
    expect(loaded.get('a::de-en')?.reps).toBe(7)
  })

  it('deletes only the keys it is given', async () => {
    await store.putStates([state('a::de-en'), state('b::de-en')])
    await store.deleteStates(['a::de-en'])
    const loaded = await store.loadStates()
    expect([...loaded.keys()]).toEqual(['b::de-en'])
  })

  it('treats empty writes and deletes as no-ops', async () => {
    await store.putStates([])
    await store.deleteStates([])
    expect((await store.loadStates()).size).toBe(0)
  })

  it('appends to the review log', async () => {
    await store.appendLog([logEntry('a::de-en')])
    await store.appendLog([logEntry('b::de-en'), logEntry('c::de-en')])
    expect(await store.loadLog()).toHaveLength(3)
  })

  it('returns default settings before anything is saved', async () => {
    expect(await store.loadSettings()).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('round-trips settings', async () => {
    await store.saveSettings({ ...DEFAULT_APP_SETTINGS, newPerDay: 42 })
    expect((await store.loadSettings()).newPerDay).toBe(42)
  })

  it('backfills settings added since the record was written', async () => {
    // A record from an older build, missing keys this build expects.
    await store.saveSettings({ id: 'settings', newPerDay: 5 } as never)
    const loaded = await store.loadSettings()
    expect(loaded.newPerDay).toBe(5)
    expect(loaded.maxReviewsPerDay).toBe(DEFAULT_APP_SETTINGS.maxReviewsPerDay)
    expect(loaded.scheduler.startingEase).toBe(2.5)
  })

  describe('export', () => {
    it('produces a complete, self-describing backup', async () => {
      await store.putStates([state('a::de-en')])
      await store.appendLog([logEntry('a::de-en')])
      const backup = await store.exportAll('sm2-v1')

      expect(backup.kind).toBe(BACKUP_KIND)
      expect(backup.backupVersion).toBe(BACKUP_VERSION)
      expect(backup.schedulerId).toBe('sm2-v1')
      expect(backup.states).toHaveLength(1)
      expect(backup.log).toHaveLength(1)
      expect(backup.settings).not.toBeNull()
      expect(() => JSON.parse(JSON.stringify(backup))).not.toThrow()
    })
  })

  describe('import', () => {
    async function backupOf(states: ReviewState[], log: ReviewLogEntry[] = []) {
      const source = createMemoryStore()
      await source.putStates(states)
      await source.appendLog(log)
      return source.exportAll('sm2-v1')
    }

    it('adds states that are not present locally', async () => {
      const summary = await store.importAll(await backupOf([state('a::de-en')]), 'merge')
      expect(summary.added).toBe(1)
      expect((await store.loadStates()).size).toBe(1)
    })

    it('keeps local progress when the local copy was reviewed more recently', async () => {
      await store.putStates([state('a::de-en', { lastReviewed: '2026-08-10T10:00:00.000Z', reps: 9 })])
      const summary = await store.importAll(
        await backupOf([state('a::de-en', { lastReviewed: '2026-08-01T10:00:00.000Z', reps: 4 })]),
        'merge',
      )

      expect(summary.keptLocal).toBe(1)
      expect(summary.updated).toBe(0)
      expect((await store.loadStates()).get('a::de-en')?.reps).toBe(9)
    })

    it('takes the backup copy when it is the more recent one', async () => {
      await store.putStates([state('a::de-en', { lastReviewed: '2026-08-01T10:00:00.000Z', reps: 4 })])
      const summary = await store.importAll(
        await backupOf([state('a::de-en', { lastReviewed: '2026-08-10T10:00:00.000Z', reps: 9 })]),
        'merge',
      )

      expect(summary.updated).toBe(1)
      expect((await store.loadStates()).get('a::de-en')?.reps).toBe(9)
    })

    it('does not import log entries when merging, to avoid double-counting', async () => {
      await store.appendLog([logEntry('a::de-en')])
      await store.importAll(await backupOf([state('a::de-en')], [logEntry('a::de-en')]), 'merge')
      expect(await store.loadLog()).toHaveLength(1)
    })

    it('replaces everything in replace mode', async () => {
      await store.putStates([state('local-only::de-en'), state('a::de-en', { reps: 99 })])
      await store.appendLog([logEntry('local-only::de-en')])

      const summary = await store.importAll(
        await backupOf([state('a::de-en', { reps: 4 })], [logEntry('a::de-en')]),
        'replace',
      )

      const loaded = await store.loadStates()
      expect([...loaded.keys()]).toEqual(['a::de-en'])
      expect(loaded.get('a::de-en')?.reps).toBe(4)
      expect(summary.added).toBe(1)
      expect(await store.loadLog()).toHaveLength(1)
    })

    it('restores settings from the backup', async () => {
      const source = createMemoryStore()
      await source.saveSettings({ ...DEFAULT_APP_SETTINGS, newPerDay: 3 })
      const summary = await store.importAll(await source.exportAll('sm2-v1'), 'merge')

      expect(summary.settingsRestored).toBe(true)
      expect((await store.loadSettings()).newPerDay).toBe(3)
    })

    it('rejects a file that is not a backup, leaving storage untouched', async () => {
      await store.putStates([state('a::de-en')])
      await expect(store.importAll({ some: 'json' }, 'replace')).rejects.toThrow(
        /not a German Flashcards backup/,
      )
      expect((await store.loadStates()).size).toBe(1)
    })

    it('survives a round trip through JSON', async () => {
      await store.putStates([state('a::de-en'), state('b::de-en', { phase: 'learning' })])
      const serialised = JSON.parse(JSON.stringify(await store.exportAll('sm2-v1')))

      const target = createMemoryStore()
      await target.importAll(serialised, 'replace')
      expect((await target.loadStates()).size).toBe(2)
    })
  })
})

describe('openStore', () => {
  it('reports IndexedDB-backed storage as durable', async () => {
    await resetDatabase()
    const store = await openStore()
    expect(store.durable).toBe(true)
    store.close()
  })

  it('flags the in-memory fallback as non-durable', () => {
    expect(createMemoryStore().durable).toBe(false)
  })
})

describe('preferNewer', () => {
  const older = state('a::de-en', { lastReviewed: '2026-08-01T00:00:00.000Z', reps: 2 })
  const newer = state('a::de-en', { lastReviewed: '2026-08-09T00:00:00.000Z', reps: 3 })

  it('prefers the more recently reviewed copy in both directions', () => {
    expect(preferNewer(older, newer)).toBe(newer)
    expect(preferNewer(newer, older)).toBe(newer)
  })

  it('prefers a reviewed copy over one that has never been reviewed', () => {
    const unseen = state('a::de-en', { lastReviewed: null, reps: 0 })
    expect(preferNewer(unseen, older)).toBe(older)
    expect(preferNewer(older, unseen)).toBe(older)
  })

  it('breaks ties on review count', () => {
    const same = '2026-08-01T00:00:00.000Z'
    const few = state('a::de-en', { lastReviewed: same, reps: 2 })
    const many = state('a::de-en', { lastReviewed: same, reps: 8 })
    expect(preferNewer(few, many)).toBe(many)
    expect(preferNewer(many, few)).toBe(many)
  })
})

describe('parseBackup', () => {
  const valid = {
    kind: BACKUP_KIND,
    backupVersion: 1,
    exportedAt: '2026-08-12T10:00:00.000Z',
    schedulerId: 'sm2-v1',
    states: [state('a::de-en')],
    log: [],
    settings: null,
  }

  it('accepts a well-formed backup', () => {
    const result = parseBackup(valid)
    expect('backup' in result && result.backup.states).toHaveLength(1)
  })

  it.each([
    [null, 'not a backup'],
    ['a string', 'not a backup'],
    [{ kind: 'something-else' }, 'not a German Flashcards backup'],
    [{ kind: BACKUP_KIND, backupVersion: 99 }, 'newer than this app'],
    [{ kind: BACKUP_KIND, backupVersion: 1 }, 'missing its "states" list'],
  ])('rejects %j', (input, expected) => {
    const result = parseBackup(input)
    expect('error' in result && result.error).toContain(expected)
  })

  it('drops malformed state entries rather than failing the whole import', () => {
    const result = parseBackup({ ...valid, states: [state('a::de-en'), { nonsense: true }, null] })
    expect('backup' in result && result.backup.states).toHaveLength(1)
  })
})

describe('backupFilename', () => {
  it('includes the date so successive exports do not collide', () => {
    expect(backupFilename(new Date('2026-08-12T10:00:00Z'))).toBe(
      'german-flashcards-backup-2026-08-12.json',
    )
  })
})
