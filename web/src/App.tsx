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

import { useEffect, useMemo, useState } from 'react'
import { fetchRepoPrs } from './lib/dependabot'
import { GhRateLimitError, subscribeRateLimit } from './lib/githubFetch'
import { MAVEN_REPOS } from './lib/repos'
import type { RateLimitInfo as RL, RepoFetchResult } from './lib/types'
import { PrTable } from './components/PrTable'
import { RateLimitInfo } from './components/RateLimitInfo'

const CYCLE_INTERVAL_MS = 30 * 60_000 // 30 min between full cycles
const PER_REPO_SPACING_MS = 800 // small gap between repos so we don't hammer
const RATE_LIMIT_PAUSE_BUFFER_MS = 5_000

export function App() {
  const [repos, setRepos] = useState<Record<string, RepoFetchResult>>({})
  const [rl, setRl] = useState<RL | null>(null)
  const [cycle, setCycle] = useState<{
    startedAt: number | null
    completedAt: number | null
    inFlight: string | null
    nextAt: number | null
    paused: { reason: string; until: number } | null
  }>({ startedAt: null, completedAt: null, inFlight: null, nextAt: null, paused: null })

  useEffect(() => subscribeRateLimit(setRl), [])

  useEffect(() => {
    let cancelled = false

    const runCycle = async () => {
      if (cancelled) return
      const started = Date.now()
      setCycle((c) => ({ ...c, startedAt: started, completedAt: null, paused: null }))

      for (const repo of MAVEN_REPOS) {
        if (cancelled) return
        setCycle((c) => ({ ...c, inFlight: repo }))
        try {
          const result = await fetchRepoPrs(repo, { spaceBeforeMs: PER_REPO_SPACING_MS })
          if (cancelled) return
          setRepos((prev) => ({ ...prev, [repo]: result }))
        } catch (err) {
          if (err instanceof GhRateLimitError) {
            const until = err.until + RATE_LIMIT_PAUSE_BUFFER_MS
            setCycle((c) => ({
              ...c,
              inFlight: null,
              paused: { reason: err.message, until },
            }))
            const wait = until - Date.now()
            if (wait > 0) await sleep(wait)
            if (cancelled) return
            // Re-attempt this repo on next iteration
            continue
          }
          // Unknown failure — record and move on
          setRepos((prev) => ({
            ...prev,
            [repo]: {
              repo,
              prs: [],
              fetchedAt: Date.now(),
              fromCache: false,
              error: err instanceof Error ? err.message : String(err),
            },
          }))
        }
      }

      if (cancelled) return
      const completed = Date.now()
      const nextAt = completed + CYCLE_INTERVAL_MS
      setCycle((c) => ({ ...c, inFlight: null, completedAt: completed, nextAt }))
    }

    const loop = async () => {
      while (!cancelled) {
        await runCycle()
        if (cancelled) return
        await sleep(CYCLE_INTERVAL_MS)
      }
    }

    void loop()
    return () => {
      cancelled = true
    }
  }, [])

  const repoList = useMemo(() => Object.values(repos), [repos])
  const totalPrs = useMemo(() => repoList.reduce((n, r) => n + r.prs.length, 0), [repoList])

  return (
    <div className="app">
      <header>
        <h1>Open Maven Dependabot PRs</h1>
        <p className="subtitle">
          Live view across {MAVEN_REPOS.length} <code>apache/maven-*</code> repositories.
        </p>
      </header>

      <section className="meta">
        <RateLimitInfo rl={rl} />
        <span className="meta-sep">·</span>
        <CycleStatus cycle={cycle} />
        <span className="meta-sep">·</span>
        <span className="muted">
          {totalPrs} open Dependabot PR{totalPrs === 1 ? '' : 's'} across{' '}
          {repoList.filter((r) => r.prs.length > 0).length} repos
        </span>
      </section>

      <main>
        <PrTable repos={repoList} />
      </main>

      <footer className="muted">
        <p>
          Static SPA · GitHub REST API · ETag-cached, serial polling. Rate limits are shared per IP
          for unauthenticated visitors.
        </p>
      </footer>
    </div>
  )
}

function CycleStatus({
  cycle,
}: {
  cycle: {
    startedAt: number | null
    completedAt: number | null
    inFlight: string | null
    nextAt: number | null
    paused: { reason: string; until: number } | null
  }
}) {
  if (cycle.paused) {
    const mins = Math.ceil((cycle.paused.until - Date.now()) / 60_000)
    return (
      <span className="cycle warn">
        Paused (rate-limited) · resumes in {mins} min
      </span>
    )
  }
  if (cycle.inFlight) {
    return <span className="cycle">Fetching {cycle.inFlight}…</span>
  }
  if (cycle.completedAt) {
    return (
      <span className="cycle">
        Updated {new Date(cycle.completedAt).toLocaleTimeString()}
      </span>
    )
  }
  if (cycle.startedAt) {
    return <span className="cycle">Loading…</span>
  }
  return <span className="cycle muted">Idle</span>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
