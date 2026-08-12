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
import type { DependabotPr, PrAssignee, RepoFetchResult } from '../lib/types'
import { assigneesOf, hasAssigneeData } from '../lib/types'
import { MAVEN_OWNER } from '../lib/repos'
import {
  readAssigneeFilter,
  readHideEmpty,
  writeAssigneeFilter,
  writeHideEmpty,
} from '../lib/cache'
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

function countAssigned(prs: DependabotPr[]): number {
  return prs.filter((pr) => assigneesOf(pr).length > 0).length
}

/** Sentinel values for the assignee dropdown; anything else is a GitHub login. */
const ASSIGNEE_ALL = 'all'
const ASSIGNEE_ANY = '__any__'
const ASSIGNEE_NONE = '__none__'

function matchesAssignee(pr: DependabotPr, filter: string): boolean {
  if (filter === ASSIGNEE_ALL) return true
  // A PR whose entry predates the column is *unknown*, not unassigned — it
  // must not show up under "Unassigned" and claim nobody has picked it up.
  if (!hasAssigneeData(pr)) return false
  const assignees = assigneesOf(pr)
  if (filter === ASSIGNEE_ANY) return assignees.length > 0
  if (filter === ASSIGNEE_NONE) return assignees.length === 0
  return assignees.some((a) => a.login === filter)
}

function filterPrs(prs: DependabotPr[], assigneeFilter: string): DependabotPr[] {
  if (assigneeFilter === ASSIGNEE_ALL) return prs
  return prs.filter((pr) => matchesAssignee(pr, assigneeFilter))
}

/** Distinct logins across everything fetched so far, for the dropdown. */
function collectAssignees(results: Record<string, RepoFetchResult>): string[] {
  const logins = new Set<string>()
  for (const result of Object.values(results)) {
    for (const pr of result.prs) {
      for (const a of assigneesOf(pr)) logins.add(a.login)
    }
  }
  return [...logins].sort((a, b) => a.localeCompare(b))
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
  const [assigneeFilter, setAssigneeFilter] = useState<string>(() => readAssigneeFilter())

  const knownAssignees = collectAssignees(results)
  const filtering = assigneeFilter !== ASSIGNEE_ALL

  const prsFor = (repo: string): DependabotPr[] =>
    filterPrs(results[repo]?.prs ?? [], assigneeFilter)

  const isCollapsed = (repo: string): boolean => {
    if (repo in collapsed) return collapsed[repo]
    // While filtering, a matching repo is worth showing open — the whole point
    // of the filter is to see the matches without clicking through 99 repos.
    if (filtering) return prsFor(repo).length === 0
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

  const updateAssigneeFilter = (value: string) => {
    setAssigneeFilter(value)
    writeAssigneeFilter(value)
    // Drop manual collapse overrides so the new filter decides what is open.
    setCollapsed({})
  }

  // An active assignee filter hides non-matching repos outright — otherwise
  // the answer to "what is this person working on?" is buried in 90+ headers.
  // Without it, hide only fully-fetched repos with zero PRs, keeping pending
  // and errored entries visible so fetch state stays observable.
  const visible = filtering
    ? sorted.filter((repo) => prsFor(repo).length > 0)
    : hideEmpty
      ? sorted.filter((repo) => {
          const r = results[repo]
          if (!r) return true
          if (r.error) return true
          return r.prs.length > 0
        })
      : sorted

  const hiddenCount = sorted.length - visible.length
  const matchCount = filtering
    ? visible.reduce((n, repo) => n + prsFor(repo).length, 0)
    : 0

  return (
    <div className="pr-table-wrap">
      <div className="pr-table-controls">
        <label className="hide-empty">
          <input
            type="checkbox"
            checked={hideEmpty}
            disabled={filtering}
            onChange={(e) => updateHideEmpty(e.target.checked)}
          />
          Hide repos without PRs
          {!filtering && hideEmpty && hiddenCount > 0 && (
            <span className="muted"> ({hiddenCount} hidden)</span>
          )}
        </label>
        <label className="assignee-filter">
          Assignee{' '}
          <select
            value={assigneeFilter}
            onChange={(e) => updateAssigneeFilter(e.target.value)}
          >
            <option value={ASSIGNEE_ALL}>All</option>
            <option value={ASSIGNEE_ANY}>Assigned (anyone)</option>
            <option value={ASSIGNEE_NONE}>Unassigned</option>
            {knownAssignees.length > 0 && (
              <optgroup label="Assigned to">
                {knownAssignees.map((login) => (
                  <option key={login} value={login}>
                    {login}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {filtering && (
            <span className="muted">
              {' '}
              ({matchCount} PR{matchCount === 1 ? '' : 's'} in {visible.length} repo
              {visible.length === 1 ? '' : 's'})
            </span>
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
            <th>Assignee</th>
            <th>Build status</th>
            <th>PR</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((repo) => (
            <RepoRows
              key={repo}
              repo={repo}
              prs={prsFor(repo)}
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
  /** Already narrowed by the assignee filter; may be a subset of result.prs. */
  prs: DependabotPr[]
  result: RepoFetchResult | undefined
  isInFlight: boolean
  collapsed: boolean
  onToggle: () => void
}

function RepoRows({ repo, prs: input, result, isInFlight, collapsed, onToggle }: RepoRowsProps) {
  const repoUrl = `https://github.com/${MAVEN_OWNER}/${repo}/pulls`
  const prs = [...input].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const counts = countBuildStates(prs)
  const empty = prs.length === 0
  const className = `repo-header${empty ? ' repo-header-empty' : ''}${
    isInFlight ? ' repo-header-active' : ''
  }`
  const canToggle = !empty

  return (
    <>
      <tr className={className}>
        <td colSpan={5}>
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
          <RepoMeta
            result={result}
            isInFlight={isInFlight}
            counts={counts}
            prCount={prs.length}
            assignedCount={countAssigned(prs)}
          />
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
  assignedCount: number
}

function RepoMeta({ result, isInFlight, counts, prCount, assignedCount }: RepoMetaProps) {
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
      {assignedCount > 0 && (
        <span
          className="count count-assigned"
          title={`${assignedCount} of ${prCount} already assigned`}
        >
          {' '}
          · 👤 {assignedCount}
        </span>
      )}
      <span className="muted"> · {fetched}</span>
    </>
  )
}

const AVATAR_PX = 18

/**
 * GitHub avatar URLs already carry a `?v=4` query, so the size hint has to be
 * appended rather than set. Request 2× for crisp rendering on HiDPI displays.
 */
function avatarSrc(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}s=${AVATAR_PX * 2}`
}

function AssigneeCell({ pr }: { pr: DependabotPr }) {
  if (!hasAssigneeData(pr)) {
    return (
      <span
        className="muted"
        title="Not known yet — this entry was cached before the column existed. It fills in on the next refresh of this repo."
      >
        ?
      </span>
    )
  }
  const assignees: PrAssignee[] = assigneesOf(pr)
  if (assignees.length === 0) {
    return (
      <span className="muted" title="Nobody has claimed this PR yet">
        —
      </span>
    )
  }
  return (
    <span className="assignee-list">
      {assignees.map((a) => (
        <a
          key={a.login}
          className="assignee"
          href={a.htmlUrl}
          target="_blank"
          rel="noreferrer"
          title={`Assigned to ${a.login}`}
        >
          <img
            className="assignee-avatar"
            src={avatarSrc(a.avatarUrl)}
            alt=""
            width={AVATAR_PX}
            height={AVATAR_PX}
            loading="lazy"
          />
          {a.login}
        </a>
      ))}
    </span>
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
      <td className="nowrap">
        <AssigneeCell pr={pr} />
      </td>
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
