import { describe, expect, it } from 'vitest'
import {
  applyPushResult,
  backupFingerprint,
  DEFAULT_SYNC_CONFIG,
  describeHttpError,
  encodeContentPath,
  isThrottled,
  MIN_SYNC_INTERVAL_MS,
  parseRepoRef,
  sameTarget,
  shouldPush,
  STALE_AFTER_MS,
  syncHealth,
  syncReady,
  toBase64,
  withSyncDefaults,
  type SyncConfig,
} from './sync'
import type { ReviewLogEntry } from './types'

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    ...DEFAULT_SYNC_CONFIG,
    enabled: true,
    owner: 'charlie',
    repo: 'flashcard-backups',
    token: 'github_pat_example',
    ...overrides,
  }
}

function entry(at: string): ReviewLogEntry {
  return {
    key: 'die-kraehe::de-en',
    at,
    grade: 'good',
    phaseBefore: 'review',
    prevIntervalDays: 4,
    nextIntervalDays: 10,
  }
}

const NOW = new Date('2026-08-18T09:00:00.000Z')

describe('parseRepoRef', () => {
  it('accepts owner/repo', () => {
    expect(parseRepoRef('charlie/backups')).toEqual({ owner: 'charlie', repo: 'backups' })
  })

  it('accepts what the GitHub UI puts on the clipboard', () => {
    expect(parseRepoRef('https://github.com/charlie/backups')).toEqual({
      owner: 'charlie',
      repo: 'backups',
    })
    expect(parseRepoRef('git@github.com:charlie/backups.git')).toEqual({
      owner: 'charlie',
      repo: 'backups',
    })
    expect(parseRepoRef('  charlie/backups/  ')).toEqual({ owner: 'charlie', repo: 'backups' })
  })

  it('rejects anything that would 404 later', () => {
    expect(parseRepoRef('')).toBeNull()
    expect(parseRepoRef('charlie')).toBeNull()
    expect(parseRepoRef('charlie/backups/extra')).toBeNull()
    expect(parseRepoRef('charlie/back ups')).toBeNull()
  })
})

describe('backupFingerprint', () => {
  it('changes when a review is added', () => {
    const before = backupFingerprint([entry('2026-08-18T08:00:00.000Z')])
    const after = backupFingerprint([
      entry('2026-08-18T08:00:00.000Z'),
      entry('2026-08-18T08:05:00.000Z'),
    ])
    expect(after).not.toBe(before)
  })

  it('is stable for the same log regardless of order', () => {
    const a = backupFingerprint([entry('2026-08-18T08:00:00.000Z'), entry('2026-08-18T09:00:00.000Z')])
    const b = backupFingerprint([entry('2026-08-18T09:00:00.000Z'), entry('2026-08-18T08:00:00.000Z')])
    expect(a).toBe(b)
  })

  it('handles an empty log', () => {
    expect(backupFingerprint([])).toBe('0:-')
  })
})

describe('shouldPush', () => {
  it('pushes when configured, dirty and untried', () => {
    expect(shouldPush(config(), 'fp-1', NOW)).toBe(true)
  })

  it('stays out of the way when nothing has changed', () => {
    expect(shouldPush(config({ lastFingerprint: 'fp-1' }), 'fp-1', NOW)).toBe(false)
  })

  it('needs an enabled, complete configuration', () => {
    expect(shouldPush(config({ enabled: false }), 'fp-1', NOW)).toBe(false)
    expect(shouldPush(config({ token: '  ' }), 'fp-1', NOW)).toBe(false)
    expect(shouldPush(config({ repo: '' }), 'fp-1', NOW)).toBe(false)
  })

  it('backs off after a recent attempt, successful or not', () => {
    const recent = new Date(NOW.getTime() - MIN_SYNC_INTERVAL_MS / 2).toISOString()
    // A rejected token must not mean one request per tick for the rest of the day.
    const failed = config({ lastAttemptAt: recent, lastError: 'Token abgelehnt (401).' })
    expect(isThrottled(failed, NOW)).toBe(true)
    expect(shouldPush(failed, 'fp-1', NOW)).toBe(false)

    const old = new Date(NOW.getTime() - MIN_SYNC_INTERVAL_MS - 1000).toISOString()
    expect(shouldPush(config({ lastAttemptAt: old }), 'fp-1', NOW)).toBe(true)
  })

  it('ignores an unparseable timestamp rather than blocking forever', () => {
    expect(isThrottled(config({ lastAttemptAt: 'not a date' }), NOW)).toBe(false)
  })
})

describe('syncHealth', () => {
  it('says nothing when the user has not opted in', () => {
    expect(syncHealth(DEFAULT_SYNC_CONFIG, 'fp-1', NOW)).toBe('off')
    expect(syncHealth(config({ token: '' }), 'fp-1', NOW)).toBe('off')
  })

  it('reports a failure over anything else', () => {
    expect(syncHealth(config({ lastError: 'Token abgelehnt (401).' }), 'fp-1', NOW)).toBe('failing')
  })

  it('flags a configuration that has never landed a push', () => {
    expect(syncHealth(config(), 'fp-1', NOW)).toBe('never')
  })

  it('is content once the pushed copy matches', () => {
    const synced = config({ lastFingerprint: 'fp-1', lastSyncAt: NOW.toISOString() })
    expect(syncHealth(synced, 'fp-1', NOW)).toBe('ok')
  })

  it('tolerates a short backlog but complains about a long one', () => {
    const hourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()
    expect(syncHealth(config({ lastFingerprint: 'fp-0', lastSyncAt: hourAgo }), 'fp-1', NOW)).toBe('ok')

    const longAgo = new Date(NOW.getTime() - STALE_AFTER_MS - 1000).toISOString()
    expect(syncHealth(config({ lastFingerprint: 'fp-0', lastSyncAt: longAgo }), 'fp-1', NOW)).toBe(
      'pending',
    )
  })

  it('does not complain about a break from studying', () => {
    // Weeks away with nothing new to push is healthy, not a failure.
    const longAgo = new Date(NOW.getTime() - STALE_AFTER_MS * 5).toISOString()
    expect(syncHealth(config({ lastFingerprint: 'fp-1', lastSyncAt: longAgo }), 'fp-1', NOW)).toBe('ok')
  })
})

describe('applyPushResult', () => {
  it('records success, so the same data is not sent twice', () => {
    const next = applyPushResult(config(), { ok: true, sha: 'abc123' }, 'fp-1', NOW)
    expect(next.sha).toBe('abc123')
    expect(next.lastFingerprint).toBe('fp-1')
    expect(next.lastSyncAt).toBe(NOW.toISOString())
    expect(next.lastError).toBeNull()
  })

  it('keeps the last good state after a failure', () => {
    const before = config({
      sha: 'abc123',
      lastFingerprint: 'fp-0',
      lastSyncAt: '2026-08-17T09:00:00.000Z',
    })
    const next = applyPushResult(before, { ok: false, error: 'Repository nicht gefunden (404).' }, 'fp-1', NOW)
    expect(next.lastError).toBe('Repository nicht gefunden (404).')
    expect(next.lastAttemptAt).toBe(NOW.toISOString())
    // Untouched: a failed push has not changed what is on the remote.
    expect(next.sha).toBe('abc123')
    expect(next.lastFingerprint).toBe('fp-0')
    expect(next.lastSyncAt).toBe('2026-08-17T09:00:00.000Z')
  })
})

describe('encoding', () => {
  it('round-trips umlauts, which btoa alone cannot', () => {
    const text = '{"id":"die-krähe","note":"Größe – straße"}'
    expect(atob(toBase64(text))).not.toBe(text)
    expect(new TextDecoder().decode(Uint8Array.from(atob(toBase64(text)), (c) => c.charCodeAt(0)))).toBe(
      text,
    )
  })

  it('handles a payload larger than one chunk', () => {
    const text = 'ä'.repeat(50_000)
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(toBase64(text)), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toBe(text)
  })

  it('escapes path segments but keeps the slashes', () => {
    expect(encodeContentPath('backups/latest.json')).toBe('backups/latest.json')
    expect(encodeContentPath('/backups//mein ordner/latest.json')).toBe(
      'backups/mein%20ordner/latest.json',
    )
  })
})

describe('withSyncDefaults', () => {
  it('fills in a record written before a field existed', () => {
    const restored = withSyncDefaults({ owner: 'charlie', repo: 'backups' })
    expect(restored.path).toBe(DEFAULT_SYNC_CONFIG.path)
    expect(restored.enabled).toBe(false)
    expect(restored.id).toBe('sync')
  })

  it('refuses to leave the path empty', () => {
    expect(withSyncDefaults({ path: '   ' }).path).toBe(DEFAULT_SYNC_CONFIG.path)
  })
})

describe('describeHttpError', () => {
  it('names the fix rather than the status code', () => {
    expect(describeHttpError(401, '')).toMatch(/Token/)
    expect(describeHttpError(403, '')).toMatch(/Contents/)
    expect(describeHttpError(404, '')).toMatch(/Repository/)
    expect(describeHttpError(500, 'server exploded')).toMatch(/server exploded/)
  })
})

describe('syncReady', () => {
  it('needs every part of the target', () => {
    expect(syncReady(config())).toBe(true)
    expect(syncReady(config({ path: '' }))).toBe(false)
    expect(syncReady(config({ owner: '' }))).toBe(false)
  })
})

describe('sameTarget', () => {
  it('distinguishes the file a sha belongs to', () => {
    expect(sameTarget(config(), config())).toBe(true)
    expect(sameTarget(config(), config({ path: 'backups/other.json' }))).toBe(false)
    expect(sameTarget(config(), config({ repo: 'elsewhere' }))).toBe(false)
    expect(sameTarget(config(), config({ branch: 'archive' }))).toBe(false)
  })

  it('ignores everything that is not the address', () => {
    expect(sameTarget(config(), config({ token: 'rotated', enabled: false }))).toBe(true)
  })
})
