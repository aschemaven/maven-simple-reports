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

function formatDate(iso: string): string {
  return iso.slice(0, 10)
}

export function PrTable({ repos }: { repos: RepoFetchResult[] }) {
  const reposWithPrs = repos
    .filter((r) => r.prs.length > 0)
    .sort((a, b) => a.repo.localeCompare(b.repo))

  if (reposWithPrs.length === 0) {
    return <p className="empty">No open Dependabot PRs found yet.</p>
  }

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
        {reposWithPrs.map((r) => (
          <RepoRows key={r.repo} result={r} />
        ))}
      </tbody>
    </table>
  )
}

function RepoRows({ result }: { result: RepoFetchResult }) {
  const repoUrl = `https://github.com/${MAVEN_OWNER}/${result.repo}/pulls`
  const prs = [...result.prs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <>
      <tr className="repo-header">
        <td colSpan={4}>
          <a href={repoUrl} target="_blank" rel="noreferrer">
            {result.repo}
          </a>
          <span className="muted">
            {' '}
            · {prs.length} PR{prs.length === 1 ? '' : 's'} · updated{' '}
            {new Date(result.fetchedAt).toLocaleTimeString()}
          </span>
        </td>
      </tr>
      {prs.map((pr) => (
        <PrRow key={pr.number} pr={pr} />
      ))}
    </>
  )
}

function PrRow({ pr }: { pr: DependabotPr }) {
  return (
    <tr>
      <td>{pr.title}</td>
      <td className="nowrap">{formatDate(pr.createdAt)}</td>
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
