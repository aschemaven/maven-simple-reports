/*
 * Copyright 2026 The Apache Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const PREFIX = 'gh-cache:v1:'
const RESULT_PREFIX = 'gh-result:v1:'
const ARCHIVED_PREFIX = 'gh-archived:v1:'
const FILTER_KEY = 'gh-filter:v1'

const ARCHIVED_TTL_MS = 7 * 24 * 60 * 60_000

interface ArchivedEntry {
  archived: boolean
  checkedAt: number
}

interface Entry<T> {
  etag: string | null
  body: T
  fetchedAt: number
}

export function readCache<T>(key: string): Entry<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    return JSON.parse(raw) as Entry<T>
  } catch {
    return null
  }
}

export function writeCache<T>(key: string, entry: Entry<T>): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(entry))
  } catch {
    // Quota exceeded or storage disabled — fail open, in-memory state still works
  }
}

export function deleteCache(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    // ignore
  }
}

export function clearAllCache(): number {
  let removed = 0
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (
        k &&
        (k.startsWith(PREFIX) ||
          k.startsWith(RESULT_PREFIX) ||
          k.startsWith(ARCHIVED_PREFIX))
      ) {
        keys.push(k)
      }
    }
    for (const k of keys) {
      localStorage.removeItem(k)
      removed++
    }
  } catch {
    // ignore
  }
  return removed
}

export function readArchived(repo: string): ArchivedEntry | null {
  try {
    const raw = localStorage.getItem(ARCHIVED_PREFIX + repo)
    if (!raw) return null
    const entry = JSON.parse(raw) as ArchivedEntry
    if (Date.now() - entry.checkedAt > ARCHIVED_TTL_MS) return null
    return entry
  } catch {
    return null
  }
}

export function writeArchived(repo: string, archived: boolean): void {
  try {
    const entry: ArchivedEntry = { archived, checkedAt: Date.now() }
    localStorage.setItem(ARCHIVED_PREFIX + repo, JSON.stringify(entry))
  } catch {
    // ignore
  }
}

export function readFilter(): string {
  try {
    return localStorage.getItem(FILTER_KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeFilter(pattern: string): void {
  try {
    if (pattern) localStorage.setItem(FILTER_KEY, pattern)
    else localStorage.removeItem(FILTER_KEY)
  } catch {
    // ignore
  }
}

export function writeResult<T>(repo: string, value: T): void {
  try {
    localStorage.setItem(RESULT_PREFIX + repo, JSON.stringify(value))
  } catch {
    // ignore
  }
}

export function readAllResults<T>(): Record<string, T> {
  const out: Record<string, T> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(RESULT_PREFIX)) continue
      const raw = localStorage.getItem(k)
      if (!raw) continue
      try {
        out[k.slice(RESULT_PREFIX.length)] = JSON.parse(raw) as T
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // ignore
  }
  return out
}
