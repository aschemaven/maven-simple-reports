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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAllCache,
  migrateLegacyCache,
  readAllResults,
  readArchived,
  readAssigneeFilter,
  readCache,
  readFilter,
  readHideEmpty,
  readToken,
  readTokenPersist,
  writeArchived,
  writeAssigneeFilter,
  writeCache,
  writeFilter,
  writeHideEmpty,
  writeResult,
  writeToken,
  writeTokenPersist,
} from './cache'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('ETag cache', () => {
  it('round-trips an entry through sessionStorage', () => {
    writeCache('https://api.github.com/x', { etag: 'W/"abc"', body: { a: 1 }, fetchedAt: 1 })
    expect(readCache<{ a: number }>('https://api.github.com/x')?.body).toEqual({ a: 1 })
  })

  it('returns null for an unknown key', () => {
    expect(readCache('nope')).toBeNull()
  })

  it('survives a malformed entry instead of throwing', () => {
    sessionStorage.setItem('gh-cache:v1:broken', '{not json')
    expect(readCache('broken')).toBeNull()
  })

  it('keeps bodies out of localStorage, which is reserved for results', () => {
    writeCache('k', { etag: null, body: 'big', fetchedAt: 1 })
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(1)
  })
})

describe('migrateLegacyCache', () => {
  it('evicts leftover ETag entries from localStorage and reports the count', () => {
    localStorage.setItem('gh-cache:v1:one', '{}')
    localStorage.setItem('gh-cache:v1:two', '{}')
    localStorage.setItem('gh-result:v1:maven-site', '{}')

    expect(migrateLegacyCache()).toBe(2)
    expect(localStorage.getItem('gh-cache:v1:one')).toBeNull()
    // Persisted results must survive — they are what paints the page on load.
    expect(localStorage.getItem('gh-result:v1:maven-site')).not.toBeNull()
  })

  it('is idempotent', () => {
    localStorage.setItem('gh-cache:v1:one', '{}')
    migrateLegacyCache()
    expect(migrateLegacyCache()).toBe(0)
  })
})

describe('persisted results', () => {
  it('round-trips results and keys them by repo', () => {
    writeResult('maven-site', { repo: 'maven-site', prs: [] })
    writeResult('maven-wrapper', { repo: 'maven-wrapper', prs: [] })
    expect(Object.keys(readAllResults()).sort()).toEqual(['maven-site', 'maven-wrapper'])
  })

  it('skips malformed entries rather than losing the whole set', () => {
    writeResult('good', { repo: 'good' })
    localStorage.setItem('gh-result:v1:bad', '{not json')
    expect(Object.keys(readAllResults())).toEqual(['good'])
  })
})

describe('archived-repo cache', () => {
  it('remembers an archived verdict', () => {
    writeArchived('maven-ant-tasks', true)
    expect(readArchived('maven-ant-tasks')?.archived).toBe(true)
  })

  it('expires after the 7-day TTL so a revived repo is picked up again', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    writeArchived('maven-site', false)

    vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60_000)
    expect(readArchived('maven-site')).toBeNull()
  })
})

describe('token storage', () => {
  it('puts a remembered token in localStorage and clears the session copy', () => {
    writeToken('tok', false)
    writeToken('tok', true)
    expect(localStorage.getItem('gh-token:v1')).toBe('tok')
    expect(sessionStorage.getItem('gh-token:v1')).toBeNull()
  })

  it('puts a non-remembered token in sessionStorage and clears the persisted copy', () => {
    writeToken('tok', true)
    writeToken('tok', false)
    expect(sessionStorage.getItem('gh-token:v1')).toBe('tok')
    expect(localStorage.getItem('gh-token:v1')).toBeNull()
  })

  it('clears both storages for an empty token', () => {
    writeToken('tok', true)
    writeToken('', false)
    expect(readToken()).toBe('')
    expect(localStorage.getItem('gh-token:v1')).toBeNull()
    expect(sessionStorage.getItem('gh-token:v1')).toBeNull()
  })

  it('prefers the persisted token when both storages somehow hold one', () => {
    localStorage.setItem('gh-token:v1', 'persisted')
    sessionStorage.setItem('gh-token:v1', 'session')
    expect(readToken()).toBe('persisted')
  })

  it('defaults "remember me" to off so persistence is opt-in', () => {
    expect(readTokenPersist()).toBe(false)
  })

  it('infers "remember me" from a leftover persisted token', () => {
    localStorage.setItem('gh-token:v1', 'tok')
    expect(readTokenPersist()).toBe(true)
  })

  it('lets an explicit preference win over the inference', () => {
    localStorage.setItem('gh-token:v1', 'tok')
    writeTokenPersist(false)
    expect(readTokenPersist()).toBe(false)
  })
})

describe('UI preferences', () => {
  it('round-trips the repo filter and drops the key when emptied', () => {
    writeFilter('mvnd|surefire')
    expect(readFilter()).toBe('mvnd|surefire')
    writeFilter('')
    expect(readFilter()).toBe('')
    expect(localStorage.getItem('gh-filter:v1')).toBeNull()
  })

  it('round-trips the hide-empty toggle', () => {
    expect(readHideEmpty()).toBe(false)
    writeHideEmpty(true)
    expect(readHideEmpty()).toBe(true)
    writeHideEmpty(false)
    expect(readHideEmpty()).toBe(false)
  })

  it('defaults the assignee filter to "all" and stores a chosen login', () => {
    expect(readAssigneeFilter()).toBe('all')
    writeAssigneeFilter('some-login')
    expect(readAssigneeFilter()).toBe('some-login')
  })

  it('removes the assignee key when reset to "all"', () => {
    writeAssigneeFilter('some-login')
    writeAssigneeFilter('all')
    expect(readAssigneeFilter()).toBe('all')
    expect(localStorage.getItem('gh-assignee-filter:v1')).toBeNull()
  })
})

describe('clearAllCache', () => {
  it('drops results and archived flags but keeps the token and preferences', () => {
    writeResult('maven-site', {})
    writeArchived('maven-site', false)
    writeCache('k', { etag: null, body: 1, fetchedAt: 1 })
    writeToken('tok', true)
    writeFilter('mvnd')

    const removed = clearAllCache()

    expect(removed).toBe(3)
    expect(readAllResults()).toEqual({})
    expect(readArchived('maven-site')).toBeNull()
    expect(readCache('k')).toBeNull()
    // Wiping the cache must not log the user out or reset their filter.
    expect(readToken()).toBe('tok')
    expect(readFilter()).toBe('mvnd')
  })
})
