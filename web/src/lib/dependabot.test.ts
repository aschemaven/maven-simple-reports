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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return import('./dependabot')
}

interface RouteOptions {
  archived?: boolean
  pulls?: unknown[]
  pullsStatus?: number
  pullsBody?: unknown
}

/**
 * Answer the endpoints fetchRepoPrs walks: repo metadata, the pulls list, and
 * per-PR check-runs plus legacy commit status.
 */
function routeFetch(opts: RouteOptions = {}) {
  return vi.fn(async (url: string) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })

    if (/\/commits\/.*\/check-runs/.test(url)) return json({ total_count: 0, check_runs: [] })
    if (/\/commits\/.*\/status/.test(url)) return json({ state: 'pending', statuses: [] })
    if (/\/pulls\?/.test(url)) {
      if (opts.pullsStatus && opts.pullsStatus !== 200) {
        return json(opts.pullsBody ?? { message: 'boom' }, opts.pullsStatus)
      }
      return json(opts.pulls ?? [])
    }
    return json({ archived: opts.archived ?? false })
  })
}

function restPull(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'Bump com.example:lib from 1.0 to 1.1',
    user: { login: 'dependabot[bot]', type: 'Bot' },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    draft: false,
    html_url: 'https://github.com/apache/maven-site/pull/1',
    head: { sha: 'sha1' },
    base: { ref: 'master' },
    assignees: [],
    assignee: null,
    ...overrides,
  }
}

const user = (login: string) => ({
  login,
  avatar_url: `https://avatars.example/${login}`,
  html_url: `https://github.com/${login}`,
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchRepoPrs — author filtering', () => {
  it.each(['dependabot[bot]', 'dependabot', 'app/dependabot', 'Dependabot[bot]'])(
    'keeps PRs authored by %s',
    async (login) => {
      vi.stubGlobal(
        'fetch',
        routeFetch({ pulls: [restPull({ user: { login, type: 'Bot' } })] }),
      )
      const { fetchRepoPrs } = await freshModule()

      const result = await fetchRepoPrs('maven-site')

      expect(result.prs).toHaveLength(1)
    },
  )

  it('drops human-authored PRs', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        pulls: [
          restPull({ number: 1, user: { login: 'elharo', type: 'User' } }),
          restPull({ number: 2 }),
        ],
      }),
    )
    const { fetchRepoPrs } = await freshModule()

    const result = await fetchRepoPrs('maven-site')

    expect(result.prs.map((p) => p.number)).toEqual([2])
  })

  it('drops PRs with no author at all', async () => {
    vi.stubGlobal('fetch', routeFetch({ pulls: [restPull({ user: null })] }))
    const { fetchRepoPrs } = await freshModule()

    expect((await fetchRepoPrs('maven-site')).prs).toEqual([])
  })
})

describe('fetchRepoPrs — assignees', () => {
  it('maps the assignees list onto the PR', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ pulls: [restPull({ assignees: [user('anna'), user('ben')] })] }),
    )
    const { fetchRepoPrs } = await freshModule()

    const [pr] = (await fetchRepoPrs('maven-site')).prs

    expect(pr.assignees).toEqual([
      { login: 'anna', avatarUrl: 'https://avatars.example/anna', htmlUrl: 'https://github.com/anna' },
      { login: 'ben', avatarUrl: 'https://avatars.example/ben', htmlUrl: 'https://github.com/ben' },
    ])
  })

  it('records an empty list rather than leaving the field undefined', async () => {
    // The difference matters: undefined means "not fetched yet" downstream.
    vi.stubGlobal('fetch', routeFetch({ pulls: [restPull()] }))
    const { fetchRepoPrs } = await freshModule()

    const [pr] = (await fetchRepoPrs('maven-site')).prs

    expect(pr.assignees).toEqual([])
  })

  it('falls back to the deprecated single assignee when the list is absent', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ pulls: [restPull({ assignees: null, assignee: user('anna') })] }),
    )
    const { fetchRepoPrs } = await freshModule()

    const [pr] = (await fetchRepoPrs('maven-site')).prs

    expect(pr.assignees?.map((a) => a.login)).toEqual(['anna'])
  })
})

describe('fetchRepoPrs — archived repos', () => {
  it('skips the pulls request entirely so quota is not spent on dead repos', async () => {
    const fetchMock = routeFetch({ archived: true })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchRepoPrs } = await freshModule()

    const result = await fetchRepoPrs('maven-ant-tasks')

    expect(result.archived).toBe(true)
    expect(result.prs).toEqual([])
    expect(fetchMock.mock.calls.some(([url]) => /\/pulls\?/.test(String(url)))).toBe(false)
  })

  it('remembers the verdict so a second call makes no metadata request', async () => {
    vi.stubGlobal('fetch', routeFetch({ archived: true }))
    const { fetchRepoPrs } = await freshModule()
    await fetchRepoPrs('maven-ant-tasks')

    const second = routeFetch({ archived: true })
    vi.stubGlobal('fetch', second)
    const result = await fetchRepoPrs('maven-ant-tasks')

    expect(result.fromCache).toBe(true)
    expect(second).not.toHaveBeenCalled()
  })
})

describe('fetchRepoPrs — failures', () => {
  it('records a per-repo error instead of throwing', async () => {
    vi.stubGlobal('fetch', routeFetch({ pullsStatus: 404, pullsBody: { message: 'Not Found' } }))
    const { fetchRepoPrs } = await freshModule()

    const result = await fetchRepoPrs('maven-site')

    expect(result.error).toContain('404')
    expect(result.prs).toEqual([])
  })

  it('lets an authorization 403 through as a readable per-repo error', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        pullsStatus: 403,
        pullsBody: { message: 'Resource not accessible by integration' },
      }),
    )
    const { fetchRepoPrs } = await freshModule()

    const result = await fetchRepoPrs('maven-site')

    expect(result.error).toContain('Resource not accessible by integration')
  })

  it('propagates a rate-limit error so the caller can pause the cycle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (/\/pulls\?/.test(url)) {
          return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
            status: 403,
            headers: {
              'content-type': 'application/json',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor((Date.now() + 3_600_000) / 1000)),
            },
          })
        }
        return new Response(JSON.stringify({ archived: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const { fetchRepoPrs } = await freshModule()
    const { GhRateLimitError } = await import('./githubFetch')

    await expect(fetchRepoPrs('maven-site')).rejects.toBeInstanceOf(GhRateLimitError)
  })
})
