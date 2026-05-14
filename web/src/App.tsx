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

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchRepoPrs } from './lib/dependabot'
import { GhRateLimitError, clearQueueBackoff, subscribeRateLimit } from './lib/githubFetch'
import { clearAllCache, readAllResults, readFilter, writeFilter } from './lib/cache'
import { MAVEN_REPOS } from './lib/repos'
import type { RateLimitInfo as RL, RepoFetchResult } from './lib/types'
import { PrTable } from './components/PrTable'
import { RateLimitInfo } from './components/RateLimitInfo'
import { FilterInput } from './components/FilterInput'

const CYCLE_INTERVAL_MS = 30 * 60_000 // 30 min between full cycles
const PER_REPO_SPACING_MS = 800
const RATE_LIMIT_PAUSE_BUFFER_MS = 5_000

interface CycleState {
  startedAt: number | null
  completedAt: number | null
  inFlight: string | null
  nextCycleAt: number | null
  pausedUntil: number | null
}

const initialCycle: CycleState = {
  startedAt: null,
  completedAt: null,
  inFlight: null,
  nextCycleAt: null,
  pausedUntil: null,
}

function applyFilter(pattern: string): { repos: string[]; invalid: boolean } {
  const trimmed = pattern.trim()
  if (!trimmed) return { repos: [...MAVEN_REPOS], invalid: false }
  try {
    const re = new RegExp(trimmed)
    return { repos: MAVEN_REPOS.filter((r) => re.test(r)), invalid: false }
  } catch {
    return { repos: [...MAVEN_REPOS], invalid: true }
  }
}

export function App() {
  const [filter, setFilter] = useState<string>(() => readFilter())
  const initialFilter = useMemo(() => applyFilter(filter), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only computed once for init
  const initialActive = initialFilter.repos

  // Hydrate from any prior tab's persisted results so a freshly opened tab
  // shows data instantly (even before its own fetch completes).
  const [repos, setRepos] = useState<Record<string, RepoFetchResult>>(() =>
    readAllResults<RepoFetchResult>(),
  )
  const [pending, setPending] = useState<string[]>([...initialActive])
  const [rl, setRl] = useState<RL | null>(null)
  const [cycle, setCycle] = useState<CycleState>(initialCycle)

  const pendingRef = useRef<string[]>([...initialActive])
  const activeReposRef = useRef<string[]>([...initialActive])
  const restartTokenRef = useRef(0)

  const filterResult = useMemo(() => applyFilter(filter), [filter])
  const activeRepos = filterResult.repos
  const filterInvalid = filterResult.invalid

  useEffect(() => {
    activeReposRef.current = activeRepos
  }, [activeRepos])

  useEffect(() => subscribeRateLimit(setRl), [])

  const syncPending = () => setPending([...pendingRef.current])

  const restart = () => {
    const cleared = clearAllCache()
    clearQueueBackoff()
    pendingRef.current = [...activeReposRef.current]
    restartTokenRef.current += 1
    setRepos({})
    syncPending()
    setCycle({ ...initialCycle, startedAt: Date.now() })
    console.info(`Restart: cleared ${cleared} cache entries, requeued ${pendingRef.current.length} repos, reset queue backoff`)
  }

  const updateFilter = (next: string) => {
    setFilter(next)
    writeFilter(next)
    const { repos: active } = applyFilter(next)
    activeReposRef.current = active
    // Re-queue: only repos that match the new filter and aren't already fetched
    const fetched = new Set(Object.keys(repos))
    pendingRef.current = active.filter((r) => !fetched.has(r))
    syncPending()
    // Wake the loop so a paused/idle cycle doesn't wait for the next scheduled refill
    restartTokenRef.current += 1
    setCycle((c) => ({
      ...c,
      startedAt: c.startedAt ?? Date.now(),
      completedAt: pendingRef.current.length === 0 ? c.completedAt : null,
      nextCycleAt: pendingRef.current.length === 0 ? c.nextCycleAt : null,
    }))
  }

  useEffect(() => {
    let cancelled = false

    const interruptibleSleep = async (ms: number, token: number): Promise<'done' | 'restart'> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (cancelled) return 'done'
        if (restartTokenRef.current !== token) return 'restart'
        await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())))
      }
      return 'done'
    }

    const loop = async () => {
      setCycle((c) => ({ ...c, startedAt: Date.now(), completedAt: null }))
      while (!cancelled) {
        // Drain the pending queue
        while (pendingRef.current.length > 0 && !cancelled) {
          const repo = pendingRef.current[0]
          setCycle((c) => ({ ...c, inFlight: repo }))
          try {
            const result = await fetchRepoPrs(repo, { spaceBeforeMs: PER_REPO_SPACING_MS })
            if (cancelled) return
            setRepos((prev) => ({ ...prev, [repo]: result }))
            pendingRef.current = pendingRef.current.filter((r) => r !== repo)
            syncPending()
          } catch (err) {
            if (err instanceof GhRateLimitError) {
              const until = err.until + RATE_LIMIT_PAUSE_BUFFER_MS
              setCycle((c) => ({ ...c, inFlight: null, pausedUntil: until }))
              const tok = restartTokenRef.current
              const wait = until - Date.now()
              if (wait > 0) {
                const result = await interruptibleSleep(wait, tok)
                if (result === 'restart') {
                  setCycle((c) => ({ ...c, pausedUntil: null }))
                  break // back to outer while; pending was just reset
                }
              }
              if (cancelled) return
              setCycle((c) => ({ ...c, pausedUntil: null }))
              // Leave repo at front of queue so we retry it
              continue
            }
            // Unrecognized error — record and move on
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
            pendingRef.current = pendingRef.current.filter((r) => r !== repo)
            syncPending()
          }
        }
        if (cancelled) return

        // Cycle complete (or restart drained the queue) — schedule next refill
        const completed = Date.now()
        const nextAt = completed + CYCLE_INTERVAL_MS
        setCycle((c) => ({
          ...c,
          completedAt: completed,
          inFlight: null,
          nextCycleAt: nextAt,
          pausedUntil: null,
        }))
        const tok = restartTokenRef.current
        const result = await interruptibleSleep(CYCLE_INTERVAL_MS, tok)
        if (cancelled) return
        if (result === 'restart') {
          // Restart already refilled pendingRef and reset state
          continue
        }
        // Normal interval expired — refill the queue with the currently active set
        pendingRef.current = [...activeReposRef.current]
        syncPending()
        setCycle((c) => ({ ...c, startedAt: Date.now(), completedAt: null, nextCycleAt: null }))
      }
    }

    void loop()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visibleResults = useMemo(() => {
    const active = new Set(activeRepos)
    return Object.values(repos).filter((r) => active.has(r.repo))
  }, [repos, activeRepos])
  const totalPrs = useMemo(
    () => visibleResults.reduce((n, r) => n + r.prs.length, 0),
    [visibleResults],
  )
  const remaining = pending.length
  const fetched = Math.max(0, activeRepos.length - remaining)

  return (
    <div className="app">
      <header>
        <h1>Open Maven Dependabot PRs</h1>
        <p className="subtitle">
          Live view across {MAVEN_REPOS.length} <code>apache/maven-*</code> repositories.
        </p>
      </header>

      <FilterInput
        pattern={filter}
        onChange={updateFilter}
        matchCount={activeRepos.length}
        totalCount={MAVEN_REPOS.length}
        invalid={filterInvalid}
      />

      <section className="meta">
        <RateLimitInfo rl={rl} />
        <span className="meta-sep">·</span>
        <CycleStatus cycle={cycle} fetched={fetched} total={activeRepos.length} />
        <span className="meta-sep">·</span>
        <span className="muted">
          {totalPrs} open Dependabot PR{totalPrs === 1 ? '' : 's'} across{' '}
          {visibleResults.filter((r) => r.prs.length > 0).length} repos
        </span>
        <span className="meta-sep grow">·</span>
        <button className="restart" type="button" onClick={restart} title="Clear cache and restart the fetch cycle from scratch">
          Restart cycle
        </button>
      </section>

      <main>
        <PrTable allRepos={activeRepos} results={repos} inFlight={cycle.inFlight} />
      </main>

      <footer className="muted">
        <p>
          Static SPA · GitHub REST API · ETag-cached, serial polling. The unauthenticated 60 req/h limit is shared per IP.
        </p>
      </footer>
    </div>
  )
}

function CycleStatus({
  cycle,
  fetched,
  total,
}: {
  cycle: CycleState
  fetched: number
  total: number
}) {
  if (cycle.pausedUntil) {
    return (
      <span className="cycle warn">
        Paused (rate-limited) · resumes at {formatTime(cycle.pausedUntil)} ({formatRelative(cycle.pausedUntil)})
      </span>
    )
  }
  if (cycle.inFlight) {
    return (
      <span className="cycle">
        Fetching {cycle.inFlight}… ({fetched}/{total})
      </span>
    )
  }
  if (cycle.nextCycleAt) {
    return (
      <span className="cycle">
        Updated at {formatTime(cycle.completedAt ?? Date.now())} · next refresh at {formatTime(cycle.nextCycleAt)}
      </span>
    )
  }
  if (cycle.startedAt) {
    return (
      <span className="cycle">
        Loading… ({fetched}/{total})
      </span>
    )
  }
  return <span className="cycle muted">Idle</span>
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatRelative(targetMs: number): string {
  const diffMs = targetMs - Date.now()
  if (diffMs <= 0) return 'now'
  const mins = Math.ceil(diffMs / 60_000)
  if (mins < 60) return `in ${mins} min`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins ? `in ${hours} h ${remMins} min` : `in ${hours} h`
}
