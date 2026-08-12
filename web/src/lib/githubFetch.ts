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

import { readCache, writeCache } from './cache'
import type { RateLimitInfo } from './types'

const API_BASE = 'https://api.github.com'

export interface FetchResult<T> {
  data: T
  status: number
  fromCache: boolean
  rateLimit: RateLimitInfo | null
}

interface QueueItem {
  run: () => Promise<void>
}

class SerialQueue {
  private chain: Promise<void> = Promise.resolve()
  private backoffUntil = 0

  setBackoff(untilMs: number): void {
    if (untilMs > this.backoffUntil) this.backoffUntil = untilMs
  }

  clearBackoff(): void {
    this.backoffUntil = 0
  }

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        run: async () => {
          // Re-read the deadline on every slice instead of sleeping it out in
          // one go: clearBackoff() (a token was added, "Refresh now" pressed)
          // must take effect immediately. Sleeping the full span would serve
          // out a backoff of up to an hour that the user has already lifted,
          // with nothing on screen explaining the wait.
          for (;;) {
            const wait = this.backoffUntil - Date.now()
            if (wait <= 0) break
            await sleep(Math.min(wait, 500))
          }
          try {
            resolve(await work())
          } catch (err) {
            reject(err)
          }
        },
      }
      this.chain = this.chain.then(item.run, item.run)
    })
  }
}

const queue = new SerialQueue()

let listeners: Array<(rl: RateLimitInfo | null) => void> = []
let lastRateLimit: RateLimitInfo | null = null

export function subscribeRateLimit(fn: (rl: RateLimitInfo | null) => void): () => void {
  listeners.push(fn)
  fn(lastRateLimit)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

function publishRateLimit(rl: RateLimitInfo | null): void {
  lastRateLimit = rl
  for (const l of listeners) l(rl)
}

/** Force the next request to fire immediately, ignoring any pending backoff. */
export function clearQueueBackoff(): void {
  queue.clearBackoff()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = headers.get('x-ratelimit-limit')
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  if (limit == null || remaining == null || reset == null) return null
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    resetAt: Number(reset) * 1000,
  }
}

/**
 * Distinguish a genuine quota/abuse throttle from an authorization 403.
 * 429 is always a throttle; for 403 we trust the rate-limit headers GitHub
 * sets on quota rejections (`x-ratelimit-remaining: 0`, `retry-after` on
 * secondary limits) and fall back to the message body. Anything else — most
 * importantly "Resource not accessible by integration" — is a permission
 * problem the user needs to see, not something to wait out.
 */
function isRateLimited(res: Response, body: string): boolean {
  if (res.status === 429) return true
  if (res.headers.get('retry-after')) return true
  if (res.headers.get('x-ratelimit-remaining') === '0') return true
  return /rate limit|abuse detection/i.test(body)
}

/** Pull GitHub's `message` field out of an error body, falling back to raw text. */
function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string }
    if (parsed.message) return parsed.message
  } catch {
    // not JSON — fall through
  }
  return body.slice(0, 200) || 'no message'
}

function computeBackoff(res: Response): number {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) {
    const n = Number(retryAfter)
    if (!Number.isNaN(n)) return Date.now() + n * 1000
  }
  const reset = res.headers.get('x-ratelimit-reset')
  if (reset) {
    const ms = Number(reset) * 1000
    if (!Number.isNaN(ms) && ms > Date.now()) return ms
  }
  return Date.now() + 60_000
}

export interface GhFetchOptions {
  token?: string | null
  /**
   * Minimum gap (ms) inserted before this request fires. Used to spread
   * unauthenticated calls across the rate-limit window.
   */
  spaceBeforeMs?: number
}

export async function ghFetch<T>(path: string, opts: GhFetchOptions = {}): Promise<FetchResult<T>> {
  return queue.enqueue(async () => {
    if (opts.spaceBeforeMs && opts.spaceBeforeMs > 0) {
      await sleep(opts.spaceBeforeMs)
    }

    const url = path.startsWith('http') ? path : API_BASE + path
    const cacheKey = url
    const cached = readCache<T>(cacheKey)

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`

    const res = await fetch(url, { headers, cache: 'no-store' })
    const rl = parseRateLimit(res.headers)
    if (rl) publishRateLimit(rl)

    if (res.status === 304 && cached) {
      return { data: cached.body, status: 304, fromCache: true, rateLimit: rl }
    }

    if (res.status === 403 || res.status === 429) {
      // GitHub overloads 403: quota exhausted *and* plain authorization
      // failures ("Resource not accessible by integration" when a GitHub App
      // token hits repos the App isn't installed on). Backing off on the
      // latter turns a permission problem into a silent multi-minute wait
      // with no error anywhere — so classify before deciding.
      const body = await res.text().catch(() => '')
      if (isRateLimited(res, body)) {
        const until = computeBackoff(res)
        queue.setBackoff(until)
        const message = `GitHub API ${res.status} (backoff until ${new Date(until).toLocaleTimeString()})`
        throw new GhRateLimitError(message, until, res.status)
      }
      throw new GhAccessError(
        `GitHub API ${res.status}: ${extractMessage(body)}`,
        res.status,
      )
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitHub API ${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
    }

    const etag = res.headers.get('etag')
    const data = (await res.json()) as T
    writeCache(cacheKey, { etag, body: data, fetchedAt: Date.now() })
    return { data, status: res.status, fromCache: false, rateLimit: rl }
  })
}

export class GhRateLimitError extends Error {
  constructor(message: string, public readonly until: number, public readonly status: number) {
    super(message)
    this.name = 'GhRateLimitError'
  }
}

/**
 * A 403 that is *not* a quota rejection: bad or insufficiently scoped
 * credentials. Deliberately not a GhRateLimitError, so the fetch loop records
 * it as a per-repo error the user can read instead of pausing on it.
 */
export class GhAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'GhAccessError'
  }
}
