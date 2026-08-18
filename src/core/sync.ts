/**
 * Automatic off-device backup to a private GitHub repository.
 *
 * A backup that depends on remembering to take it is a backup that eventually stops
 * happening, and the loss is only discovered at the worst moment. So the same JSON
 * `exportAll` produces is pushed to a file in a repository the user owns, on its own
 * without being asked. Git history there means every push is a restore point, so a
 * damaged export cannot overwrite the last good one.
 *
 * Four rules shape this module:
 *
 * - **The token never enters a backup.** Sync configuration is stored separately from
 *   `AppSettings` precisely because settings are part of the exported file — a token
 *   kept there would upload itself on the first push.
 * - **The remote is written, never read.** Nothing here can modify local progress;
 *   restoring is still the deliberate import in Settings. A sync bug can cost an
 *   upload, never history.
 * - **Silence is the failure to design against.** Every attempt records its outcome
 *   so the UI can say that sync is failing. A backup that quietly stopped months ago
 *   is worse than none, because it stops the user worrying.
 * - **Failures back off.** The throttle keys on the last *attempt*, not the last
 *   success, so a rejected token means one request an hour rather than one per tick.
 */

import type { BackupFile } from './storage'
import type { ReviewLogEntry } from './types'

/** The file written in the target repository, if the user does not choose another. */
export const DEFAULT_SYNC_PATH = 'backups/latest.json'

/** Minimum gap between push attempts, successful or not. */
export const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000

/** How long unpushed reviews may sit before the UI starts complaining. */
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

const API_ROOT = 'https://api.github.com'
const API_VERSION = '2022-11-28'

/**
 * Where and how to push, plus the outcome of the last attempt.
 *
 * Held in its own IndexedDB store rather than in `AppSettings` — see the note above
 * about tokens and exports.
 */
export interface SyncConfig {
  /** Fixed primary key — there is only ever one sync record. */
  id: 'sync'
  enabled: boolean
  owner: string
  repo: string
  /** Empty means the repository's default branch. */
  branch: string
  path: string
  /** Fine-grained PAT with Contents: read and write on this repository alone. */
  token: string
  /** Blob sha as we last wrote it, so a push needs no preceding GET. */
  sha: string | null
  /** ISO timestamp of the last push that succeeded. */
  lastSyncAt: string | null
  /** ISO timestamp of the last push attempted, successful or not. Drives the throttle. */
  lastAttemptAt: string | null
  /** Why the last attempt failed, or null if it succeeded. */
  lastError: string | null
  /** Fingerprint of the payload last pushed; identical data is never pushed twice. */
  lastFingerprint: string | null
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  id: 'sync',
  enabled: false,
  owner: '',
  repo: '',
  branch: '',
  path: DEFAULT_SYNC_PATH,
  token: '',
  sha: null,
  lastSyncAt: null,
  lastAttemptAt: null,
  lastError: null,
  lastFingerprint: null,
}

/** Fills in anything a record written by an older build is missing. */
export function withSyncDefaults(stored: Partial<SyncConfig> | null | undefined): SyncConfig {
  if (!stored) return { ...DEFAULT_SYNC_CONFIG }
  return {
    ...DEFAULT_SYNC_CONFIG,
    ...stored,
    id: 'sync',
    path: stored.path?.trim() ? stored.path.trim() : DEFAULT_SYNC_PATH,
  }
}

/* -------------------------------------------------------------------------- */
/* Pure decisions                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Accepts what a user is likely to paste: `owner/repo`, a browser URL, an SSH
 * remote. Returns null if it cannot find both halves, so the UI can refuse rather
 * than storing something that will 404 an hour later.
 */
export function parseRepoRef(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const withoutPrefix = trimmed
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const parts = withoutPrefix.split('/').filter((part) => part !== '')
  if (parts.length !== 2) return null
  const [owner, repo] = parts as [string, string]
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null
  return { owner, repo }
}

/**
 * Whether two configurations address the same file.
 *
 * A blob sha, a last-synced time and a pushed fingerprint all describe one file in
 * one repository, so they may only be carried between configurations that agree on
 * which file that is.
 */
export function sameTarget(a: SyncConfig, b: SyncConfig): boolean {
  return a.owner === b.owner && a.repo === b.repo && a.path === b.path && a.branch === b.branch
}

/** True once there is somewhere to push and something to push with. */
export function syncReady(config: SyncConfig): boolean {
  return (
    config.enabled &&
    config.token.trim() !== '' &&
    config.owner !== '' &&
    config.repo !== '' &&
    config.path.trim() !== ''
  )
}

/**
 * Cheap stand-in for "has anything happened since the last push".
 *
 * Comparing whole exports would mean serialising one on every tick; the review log
 * grows by exactly one entry per answer, so its length and newest timestamp track new
 * history for nothing. ISO-8601 UTC strings compare correctly as text.
 *
 * It reads the log rather than the states deliberately: the log is identical whether
 * taken from memory or from an export, while the in-memory item list omits retained
 * orphans and would disagree with the file every time, leaving the app convinced it
 * was permanently behind.
 */
export function backupFingerprint(log: readonly ReviewLogEntry[]): string {
  let latest = ''
  for (const entry of log) {
    if (entry.at > latest) latest = entry.at
  }
  return `${log.length}:${latest === '' ? '-' : latest}`
}

/** True while the previous attempt is too recent to try again. */
export function isThrottled(config: SyncConfig, now: Date): boolean {
  if (config.lastAttemptAt === null) return false
  const last = Date.parse(config.lastAttemptAt)
  if (!Number.isFinite(last)) return false
  return now.getTime() - last < MIN_SYNC_INTERVAL_MS
}

/** The full automatic-push decision: configured, not throttled, and actually dirty. */
export function shouldPush(config: SyncConfig, fingerprint: string, now: Date): boolean {
  if (!syncReady(config)) return false
  if (isThrottled(config, now)) return false
  return config.lastFingerprint !== fingerprint
}

/**
 * - `off` — not configured; the user opted out and is not nagged.
 * - `never` — configured but nothing has ever landed, so it is unproven.
 * - `failing` — the last attempt returned an error.
 * - `pending` — reviews have gone unpushed for longer than `STALE_AFTER_MS`.
 * - `ok` — everything reviewed is on the remote, or nearly so.
 *
 * Staleness is measured against *unpushed work*, not against the clock: a fortnight
 * away from the app leaves nothing to push, and warning then would train the user to
 * ignore the warning that matters.
 */
export type SyncHealth = 'off' | 'never' | 'ok' | 'pending' | 'failing'

export function syncHealth(config: SyncConfig, fingerprint: string, now: Date): SyncHealth {
  if (!syncReady(config)) return 'off'
  if (config.lastError !== null) return 'failing'
  if (config.lastFingerprint === null || config.lastSyncAt === null) return 'never'
  if (config.lastFingerprint === fingerprint) return 'ok'
  const since = Date.parse(config.lastSyncAt)
  if (!Number.isFinite(since)) return 'pending'
  return now.getTime() - since > STALE_AFTER_MS ? 'pending' : 'ok'
}

/* -------------------------------------------------------------------------- */
/* GitHub contents API                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Base64 for the contents API, via UTF-8.
 *
 * `btoa` takes bytes, not characters, and card ids carry umlauts — passing the string
 * straight in throws on the first `ä`. Chunked so a large log does not blow the
 * argument limit of `String.fromCharCode`.
 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

/** Each segment escaped, but the slashes kept: the API treats the path as a path. */
export function encodeContentPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map(encodeURIComponent)
    .join('/')
}

/**
 * Turns a failed response into something worth reading at 07:00 on a phone.
 *
 * These are the messages the user acts on, so they name the fix rather than the
 * status code, and they are in German like the rest of the interface.
 */
export function describeHttpError(status: number, body: string): string {
  switch (status) {
    case 401:
      return 'Token abgelehnt (401). Wahrscheinlich abgelaufen — ein neues Token erstellen.'
    case 403:
      return 'Zugriff verweigert (403). Das Token braucht „Contents: read and write“ für dieses Repository.'
    case 404:
      return 'Repository nicht gefunden (404). Name falsch, oder das Token hat keinen Zugriff darauf.'
    case 409:
      return 'Konflikt (409). Die Datei wurde anderswo geändert; der nächste Versuch löst das auf.'
    case 422:
      return 'Von GitHub abgelehnt (422). Meist ein veralteter Datei-Stand oder ein falscher Branch.'
    default: {
      const detail = body.trim().slice(0, 200)
      return `Sicherung fehlgeschlagen (HTTP ${status})${detail === '' ? '' : `: ${detail}`}`
    }
  }
}

interface GitHubRequest {
  token: string
  method: 'GET' | 'PUT'
  url: string
  body?: unknown
}

async function callGitHub({ token, method, url, body }: GitHubRequest): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function contentsUrl(config: SyncConfig): string {
  return `${API_ROOT}/repos/${config.owner}/${config.repo}/contents/${encodeContentPath(config.path)}`
}

export type PushResult = { ok: true; sha: string } | { ok: false; error: string }

export type TestResult =
  | { ok: true; private: boolean; defaultBranch: string }
  | { ok: false; error: string }

/**
 * Checks the repository is reachable before the user trusts it with anything.
 *
 * Reports whether it is private too: pushing a review history to a public repository
 * is legal, cheap and almost certainly not what was intended, so the UI says so.
 */
export async function testConnection(config: SyncConfig): Promise<TestResult> {
  if (config.token.trim() === '' || config.owner === '' || config.repo === '') {
    return { ok: false, error: 'Repository und Token fehlen noch.' }
  }
  try {
    const response = await callGitHub({
      token: config.token,
      method: 'GET',
      url: `${API_ROOT}/repos/${config.owner}/${config.repo}`,
    })
    if (!response.ok) return { ok: false, error: describeHttpError(response.status, await response.text()) }
    const repository = (await response.json()) as { private?: boolean; default_branch?: string }
    return {
      ok: true,
      private: repository.private === true,
      defaultBranch: repository.default_branch ?? 'main',
    }
  } catch {
    return { ok: false, error: 'Keine Verbindung zu GitHub.' }
  }
}

/** Reads the current blob sha, so a push can recover from a stale one. */
async function fetchRemoteSha(config: SyncConfig): Promise<string | null> {
  const query = config.branch === '' ? '' : `?ref=${encodeURIComponent(config.branch)}`
  const response = await callGitHub({
    token: config.token,
    method: 'GET',
    url: `${contentsUrl(config)}${query}`,
  })
  if (!response.ok) return null
  const file = (await response.json()) as { sha?: string }
  return typeof file.sha === 'string' ? file.sha : null
}

/**
 * Writes the backup to the repository, creating the file on the first run.
 *
 * The contents API needs the sha of the blob being replaced. We cache it from the
 * previous push to save a round trip, which goes stale if the file was written from
 * another device — so a rejection re-reads the sha and retries exactly once. More
 * retries would just be a slower way to fail.
 */
export async function pushBackup(
  config: SyncConfig,
  backup: BackupFile,
  now: Date = new Date(),
): Promise<PushResult> {
  const content = toBase64(JSON.stringify(backup, null, 2))
  const message = `Sicherung ${now.toISOString()}`

  async function attempt(sha: string | null): Promise<Response> {
    return callGitHub({
      token: config.token,
      method: 'PUT',
      url: contentsUrl(config),
      body: {
        message,
        content,
        ...(sha === null ? {} : { sha }),
        ...(config.branch === '' ? {} : { branch: config.branch }),
      },
    })
  }

  try {
    let response = await attempt(config.sha)

    if (response.status === 409 || response.status === 422) {
      const remoteSha = await fetchRemoteSha(config)
      if (remoteSha !== null && remoteSha !== config.sha) response = await attempt(remoteSha)
    }

    if (!response.ok) return { ok: false, error: describeHttpError(response.status, await response.text()) }

    const written = (await response.json()) as { content?: { sha?: string } }
    return { ok: true, sha: written.content?.sha ?? '' }
  } catch {
    // Offline is the ordinary case here, not an error worth alarming about — the
    // next attempt an hour later usually succeeds.
    return { ok: false, error: 'Keine Verbindung zu GitHub. Nächster Versuch später.' }
  }
}

/** Folds the outcome of an attempt back into the stored configuration. */
export function applyPushResult(
  config: SyncConfig,
  result: PushResult,
  fingerprint: string,
  now: Date,
): SyncConfig {
  const at = now.toISOString()
  if (!result.ok) return { ...config, lastAttemptAt: at, lastError: result.error }
  return {
    ...config,
    sha: result.sha === '' ? null : result.sha,
    lastAttemptAt: at,
    lastSyncAt: at,
    lastError: null,
    lastFingerprint: fingerprint,
  }
}
