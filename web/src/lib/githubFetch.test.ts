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

// githubFetch keeps module-level state (the serial queue and the last seen
// rate limit), so every test imports a fresh copy rather than inheriting
// backoff from whichever test ran before it.
async function freshModule() {
  vi.resetModules()
  return import('./githubFetch')
}

const HOUR_FROM_NOW = () => Math.floor((Date.now() + 3_600_000) / 1000)

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ghFetch — happy path', () => {
  it('returns the parsed body and reports the rate limit', async () => {
    const { ghFetch, subscribeRateLimit } = await freshModule()
    fetchMock.mockResolvedValue(
      jsonResponse([{ number: 1 }], {
        headers: {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': String(HOUR_FROM_NOW()),
        },
      }),
    )

    const seen: Array<{ limit: number; remaining: number } | null> = []
    subscribeRateLimit((rl) => seen.push(rl))

    const res = await ghFetch<Array<{ number: number }>>('/repos/apache/maven/pulls')

    expect(res.data).toEqual([{ number: 1 }])
    expect(res.fromCache).toBe(false)
    expect(seen.at(-1)).toMatchObject({ limit: 5000, remaining: 4999 })
  })

  it('prefixes a bare path with the API base', async () => {
    const { ghFetch } = await freshModule()
    fetchMock.mockResolvedValue(jsonResponse({}))

    await ghFetch('/repos/apache/maven')

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/apache/maven')
  })

  it('sends the token as a bearer credential when one is supplied', async () => {
    const { ghFetch } = await freshModule()
    fetchMock.mockResolvedValue(jsonResponse({}))

    await ghFetch('/x', { token: 'gho_secret' })

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer gho_secret')
  })

  it('sends no Authorization header when unauthenticated', async () => {
    const { ghFetch } = await freshModule()
    fetchMock.mockResolvedValue(jsonResponse({}))

    await ghFetch('/x')

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})

describe('ghFetch — ETag revalidation', () => {
  it('replays the cached body on 304 without re-downloading it', async () => {
    const { ghFetch } = await freshModule()
    fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }, { headers: { etag: 'W/"abc"' } }))
    await ghFetch('/x')

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }))
    const res = await ghFetch<{ v: number }>('/x')

    expect(res.status).toBe(304)
    expect(res.fromCache).toBe(true)
    expect(res.data).toEqual({ v: 1 })

    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>
    expect(headers['If-None-Match']).toBe('W/"abc"')
  })
})

describe('ghFetch — 403 classification', () => {
  it('treats an exhausted quota as a rate limit and backs off until the reset', async () => {
    const { ghFetch, GhRateLimitError } = await freshModule()
    const reset = HOUR_FROM_NOW()
    fetchMock.mockResolvedValue(
      jsonResponse(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        },
      ),
    )

    const err = await ghFetch('/x').catch((e) => e)

    expect(err).toBeInstanceOf(GhRateLimitError)
    expect(err.until).toBe(reset * 1000)
  })

  it('treats a secondary limit with retry-after as a rate limit', async () => {
    const { ghFetch, GhRateLimitError } = await freshModule()
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'You have exceeded a secondary rate limit' }, {
        status: 403,
        headers: { 'retry-after': '60' },
      }),
    )

    await expect(ghFetch('/x')).rejects.toBeInstanceOf(GhRateLimitError)
  })

  it('treats 429 as a rate limit regardless of headers', async () => {
    const { ghFetch, GhRateLimitError } = await freshModule()
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Too many requests' }, { status: 429 }))

    await expect(ghFetch('/x')).rejects.toBeInstanceOf(GhRateLimitError)
  })

  // The regression this suite exists for: a GitHub App token hitting repos the
  // App is not installed on returns 403 with no rate-limit headers. Treating
  // that as a throttle stalled the dashboard silently for up to an hour.
  it('surfaces an authorization 403 as an access error, not a rate limit', async () => {
    const { ghFetch, GhAccessError, GhRateLimitError } = await freshModule()
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'Resource not accessible by integration' }, { status: 403 }),
    )

    const err = await ghFetch('/x').catch((e) => e)

    expect(err).toBeInstanceOf(GhAccessError)
    expect(err).not.toBeInstanceOf(GhRateLimitError)
    expect(err.message).toContain('Resource not accessible by integration')
    expect(err.status).toBe(403)
  })

  it('does not back off after an authorization 403, so the next repo is tried at once', async () => {
    const { ghFetch, GhAccessError } = await freshModule()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Resource not accessible by integration' }, { status: 403 }),
    )
    await expect(ghFetch('/first')).rejects.toBeInstanceOf(GhAccessError)

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    // Would hang on the backoff sleep if the auth 403 had armed one.
    await expect(ghFetch('/second')).resolves.toMatchObject({ data: { ok: true } })
  })

  it('falls back to the raw body when the error is not JSON', async () => {
    const { ghFetch } = await freshModule()
    fetchMock.mockResolvedValue(new Response('<html>blocked</html>', { status: 403 }))

    const err = await ghFetch('/x').catch((e) => e)

    expect(err.message).toContain('blocked')
  })
})

describe('ghFetch — other failures', () => {
  it('reports a non-ok status as a plain error', async () => {
    const { ghFetch, GhRateLimitError, GhAccessError } = await freshModule()
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }))

    const err = await ghFetch('/x').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(GhRateLimitError)
    expect(err).not.toBeInstanceOf(GhAccessError)
    expect(err.message).toContain('404')
  })
})

describe('clearQueueBackoff', () => {
  it('wakes a request already waiting out a backoff', async () => {
    vi.useFakeTimers()
    const { ghFetch, clearQueueBackoff, GhRateLimitError } = await freshModule()

    // Arm an hour-long backoff via an exhausted-quota 403.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'API rate limit exceeded' }, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(HOUR_FROM_NOW()) },
      }),
    )
    await expect(ghFetch('/first')).rejects.toBeInstanceOf(GhRateLimitError)

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const pending = ghFetch<{ ok: boolean }>('/second')

    // Still parked: without lifting the backoff nothing should have gone out.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Lifting it must take effect within one slice, not after the full hour —
    // this is what makes "Refresh now" and adding a token work immediately.
    clearQueueBackoff()
    await vi.advanceTimersByTimeAsync(600)

    await expect(pending).resolves.toMatchObject({ data: { ok: true } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
