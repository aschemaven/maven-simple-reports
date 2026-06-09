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

import { useState } from 'react'
import type { DependabotPr, RepoFetchResult } from '../lib/types'
import { MAVEN_OWNER } from '../lib/repos'
import { readHideEmpty, writeHideEmpty } from '../lib/cache'
import { StatusBadge } from './StatusBadge'

const STALE_THRESHOLD_MS = 60 * 60_000

function formatPrDate(iso: string): string {
  return iso.slice(0, 10)
}

function formatFetchedAt(ms: number): string {
  const d = new Date(ms)
  const ageMs = Date.now() - ms
  if (ageMs < STALE_THRESHOLD_MS) {
    return d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    })
  }
  return d.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

interface BuildCounts {
  success: number
  failure: number
  pending: number
  unknown: number
}

function countBuildStates(prs: DependabotPr[]): BuildCounts {
  const c: BuildCounts = { success: 0, failure: 0, pending: 0, unknown: 0 }
  for (const pr of prs) {
    switch (pr.buildState) {
      case 'SUCCESS':
        c.success++
        break
      case 'FAILURE':
      case 'CONFLICT':
        c.failure++
        break
      case 'PENDING':
        c.pending++
        break
      default:
        c.unknown++
        break
    }
  }
  return c
}

interface Props {
  allRepos: readonly string[]
  results: Record<string, RepoFetchResult>
  inFlight: string | null
}

export function PrTable({ allRepos, results, inFlight }: Props) {
  const sorted = [...allRepos].sort((a, b) => a.localeCompare(b))
  // Explicit per-repo overrides. Missing key → default: expanded iff the repo
  // has at least one PR.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [hideEmpty, setHideEmpty] = useState<boolean>(() => readHideEmpty())

  const isCollapsed = (repo: string): boolean => {
    if (repo in collapsed) return collapsed[repo]
    const result = results[repo]
    return !result || result.prs.length === 0
  }

  const toggle = (repo: string) => {
    setCollapsed((c) => ({ ...c, [repo]: !isCollapsed(repo) }))
  }

  const setAll = (value: boolean) => {
    const next: Record<string, boolean> = {}
    for (const r of sorted) next[r] = value
    setCollapsed(next)
  }

  const updateHideEmpty = (value: boolean) => {
    setHideEmpty(value)
    writeHideEmpty(value)
  }

  // Hide only fully-fetched repos with zero PRs. Keep pending and errored
  // entries visible so the user can still see fetch state.
  const visible = hideEmpty
    ? sorted.filter((repo) => {
        const r = results[repo]
        if (!r) return true
        if (r.error) return true
        return r.prs.length > 0
      })
    : sorted

  const hiddenCount = sorted.length - visible.length

  return (
    <div className="pr-table-wrap">
      <div className="pr-table-controls">
        <label className="hide-empty">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => updateHideEmpty(e.target.checked)}
          />
          Hide repos without PRs
          {hideEmpty && hiddenCount > 0 && (
            <span className="muted"> ({hiddenCount} hidden)</span>
          )}
        </label>
        <span className="pr-table-controls-spacer" />
        <button type="button" onClick={() => setAll(false)}>
          Expand all
        </button>
        <button type="button" onClick={() => setAll(true)}>
          Collapse all
        </button>
      </div>
      <table className="pr-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Date</th>
            <th>Build status</th>
            <th>PR</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((repo) => (
            <RepoRows
              key={repo}
              repo={repo}
              result={results[repo]}
              isInFlight={inFlight === repo}
              collapsed={isCollapsed(repo)}
              onToggle={() => toggle(repo)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface RepoRowsProps {
  repo: string
  result: RepoFetchResult | undefined
  isInFlight: boolean
  collapsed: boolean
  onToggle: () => void
}

function RepoRows({ repo, result, isInFlight, collapsed, onToggle }: RepoRowsProps) {
  const repoUrl = `https://github.com/${MAVEN_OWNER}/${repo}/pulls`
  const prs = result ? [...result.prs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []
  const counts = countBuildStates(prs)
  const empty = prs.length === 0
  const className = `repo-header${empty ? ' repo-header-empty' : ''}${
    isInFlight ? ' repo-header-active' : ''
  }`
  const canToggle = !empty

  return (
    <>
      <tr className={className}>
        <td colSpan={4}>
          <button
            type="button"
            className="repo-toggle"
            onClick={onToggle}
            disabled={!canToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${repo}` : `Collapse ${repo}`}
            title={canToggle ? (collapsed ? 'Expand' : 'Collapse') : 'Nothing to expand'}
          >
            {collapsed ? '▶' : '▼'}
          </button>
          <a href={repoUrl} target="_blank" rel="noreferrer">
            {repo}
          </a>
          <RepoMeta result={result} isInFlight={isInFlight} counts={counts} prCount={prs.length} />
        </td>
      </tr>
      {!collapsed && prs.map((pr) => <PrRow key={pr.number} pr={pr} />)}
    </>
  )
}

interface RepoMetaProps {
  result: RepoFetchResult | undefined
  isInFlight: boolean
  counts: BuildCounts
  prCount: number
}

function RepoMeta({ result, isInFlight, counts, prCount }: RepoMetaProps) {
  if (isInFlight) return <span className="muted"> · fetching…</span>
  if (!result) return <span className="muted"> · pending</span>
  if (result.error) return <span className="muted"> · error: {result.error}</span>

  const fetched = formatFetchedAt(result.fetchedAt)
  if (prCount === 0) {
    return <span className="muted"> · no Dependabot PRs · {fetched}</span>
  }
  return (
    <>
      <span className="muted">
        {' '}
        · {prCount} PR{prCount === 1 ? '' : 's'}
      </span>
      {counts.success > 0 && (
        <span className="count count-success">
          {' '}
          · ✓ {counts.success}
        </span>
      )}
      {counts.failure > 0 && (
        <span className="count count-failure">
          {' '}
          · ✗ {counts.failure}
        </span>
      )}
      {counts.pending > 0 && (
        <span className="count count-pending">
          {' '}
          · ⏳ {counts.pending}
        </span>
      )}
      <span className="muted"> · {fetched}</span>
    </>
  )
}

function PrRow({ pr }: { pr: DependabotPr }) {
  return (
    <tr className="pr-row">
      <td className="pr-indent">
        {pr.isDraft && <span className="pr-chip pr-chip-draft">Draft</span>}
        {pr.baseRef && <span className="pr-chip pr-chip-base">→ {pr.baseRef}</span>}
        {pr.title}
      </td>
      <td className="nowrap">{formatPrDate(pr.createdAt)}</td>
      <td>
        <a href={pr.checksUrl} target="_blank" rel="noreferrer">
          <StatusBadge state={pr.buildState} />
        </a>
      </td>
      <td>
        <a href={pr.url} target="_blank" rel="noreferrer">
          #{pr.number}
        </a>
      </td>
    </tr>
  )
}
