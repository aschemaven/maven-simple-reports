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
          const wait = this.backoffUntil - Date.now()
          if (wait > 0) {
            await sleep(wait)
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
      const until = computeBackoff(res)
      queue.setBackoff(until)
      const message = `GitHub API ${res.status} (backoff until ${new Date(until).toLocaleTimeString()})`
      throw new GhRateLimitError(message, until, res.status)
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
