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

import type { DependabotPr, RepoFetchResult } from '../lib/types'
import { MAVEN_OWNER } from '../lib/repos'
import { StatusBadge } from './StatusBadge'

const STALE_THRESHOLD_MS = 60 * 60_000

function formatPrDate(iso: string): string {
  return iso.slice(0, 10)
}

function formatFetchedAt(ms: number): string {
  const d = new Date(ms)
  const ageMs = Date.now() - ms
  if (ageMs < STALE_THRESHOLD_MS) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface Props {
  allRepos: readonly string[]
  results: Record<string, RepoFetchResult>
  inFlight: string | null
}

export function PrTable({ allRepos, results, inFlight }: Props) {
  const sorted = [...allRepos].sort((a, b) => a.localeCompare(b))

  return (
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
        {sorted.map((repo) => (
          <RepoRows
            key={repo}
            repo={repo}
            result={results[repo]}
            isInFlight={inFlight === repo}
          />
        ))}
      </tbody>
    </table>
  )
}

interface RepoRowsProps {
  repo: string
  result: RepoFetchResult | undefined
  isInFlight: boolean
}

function RepoRows({ repo, result, isInFlight }: RepoRowsProps) {
  const repoUrl = `https://github.com/${MAVEN_OWNER}/${repo}/pulls`
  const prs = result ? [...result.prs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []
  const status = computeStatus(result, isInFlight)
  const empty = prs.length === 0
  const className = `repo-header${empty ? ' repo-header-empty' : ''}${isInFlight ? ' repo-header-active' : ''}`
  return (
    <>
      <tr className={className}>
        <td colSpan={4}>
          <a href={repoUrl} target="_blank" rel="noreferrer">
            {repo}
          </a>
          <span className="muted"> · {status}</span>
        </td>
      </tr>
      {prs.map((pr) => (
        <PrRow key={pr.number} pr={pr} />
      ))}
    </>
  )
}

function computeStatus(result: RepoFetchResult | undefined, isInFlight: boolean): string {
  if (isInFlight) return 'fetching…'
  if (!result) return 'pending'
  if (result.error) return `error: ${result.error}`
  const fetched = formatFetchedAt(result.fetchedAt)
  if (result.prs.length === 0) return `no Dependabot PRs · last fetched ${fetched}`
  return `${result.prs.length} PR${result.prs.length === 1 ? '' : 's'} · last fetched ${fetched}`
}

function PrRow({ pr }: { pr: DependabotPr }) {
  return (
    <tr>
      <td>{pr.title}</td>
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
