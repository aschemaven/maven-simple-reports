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

import { ghFetch, GhRateLimitError } from './githubFetch'
import {
  deriveBuildState,
  type CheckRunsResponse,
  type CommitStatusResponse,
} from './buildStatus'
import { MAVEN_OWNER } from './repos'
import { readArchived, writeArchived, writeResult } from './cache'
import type { DependabotPr, RepoFetchResult } from './types'

interface RepoMetadata {
  archived: boolean
}

interface RestPullRequest {
  number: number
  title: string
  user: { login: string; type: string } | null
  created_at: string
  updated_at: string
  draft: boolean
  html_url: string
  head: { sha: string }
  base: { ref: string }
}

const DEPENDABOT_LOGIN_PATTERNS = [/^dependabot(\[bot\])?$/i, /^app\/dependabot$/i]

function isDependabotAuthor(login: string | undefined | null): boolean {
  if (!login) return false
  return DEPENDABOT_LOGIN_PATTERNS.some((re) => re.test(login))
}

export interface FetchRepoOptions {
  token?: string | null
  spaceBeforeMs?: number
  /** Skip fetching check-runs for each PR (faster but no build status). */
  skipChecks?: boolean
}

export async function fetchRepoPrs(repo: string, opts: FetchRepoOptions = {}): Promise<RepoFetchResult> {
  try {
    // Step 1: archived check (cached in localStorage for 7 days). If archived,
    // we skip the PR fetch entirely so quota isn't wasted on dead repos.
    let archived = false
    const cachedArchived = readArchived(repo)
    if (cachedArchived) {
      archived = cachedArchived.archived
    } else {
      const meta = await ghFetch<RepoMetadata>(`/repos/${MAVEN_OWNER}/${repo}`, {
        token: opts.token,
        spaceBeforeMs: opts.spaceBeforeMs,
      })
      archived = !!meta.data.archived
      writeArchived(repo, archived)
    }

    if (archived) {
      const result: RepoFetchResult = {
        repo,
        prs: [],
        fetchedAt: Date.now(),
        fromCache: !!cachedArchived,
        archived: true,
      }
      writeResult(repo, result)
      return result
    }

    const list = await ghFetch<RestPullRequest[]>(
      `/repos/${MAVEN_OWNER}/${repo}/pulls?state=open&per_page=100`,
      { token: opts.token, spaceBeforeMs: cachedArchived ? opts.spaceBeforeMs : 0 },
    )

    const dependabotPulls = list.data.filter((p) => isDependabotAuthor(p.user?.login))

    const prs: DependabotPr[] = []
    for (const pr of dependabotPulls) {
      const baseUrl = `https://github.com/${MAVEN_OWNER}/${repo}`
      const pull: DependabotPr = {
        repo,
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? 'unknown',
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        isDraft: pr.draft,
        baseRef: pr.base.ref,
        url: pr.html_url,
        checksUrl: `${baseUrl}/pull/${pr.number}/checks`,
        headSha: pr.head.sha,
        buildState: 'UNKNOWN',
        buildStateFetchedAt: null,
      }

      if (!opts.skipChecks) {
        try {
          const checks = await ghFetch<CheckRunsResponse>(
            `/repos/${MAVEN_OWNER}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
            { token: opts.token },
          )
          // Legacy combined-status surfaces Apache Jenkins results that
          // never appear as CheckRuns. Failure here mustn't drop the
          // CheckRun signal we already have — fall back to checks-only.
          let status: CommitStatusResponse | null = null
          try {
            const statusRes = await ghFetch<CommitStatusResponse>(
              `/repos/${MAVEN_OWNER}/${repo}/commits/${pr.head.sha}/status?per_page=100`,
              { token: opts.token },
            )
            status = statusRes.data
          } catch (err) {
            if (err instanceof GhRateLimitError) {
              prs.push(pull)
              throw err
            }
          }
          pull.buildState = deriveBuildState(checks.data, status)
          pull.buildStateFetchedAt = Date.now()
        } catch (err) {
          if (err instanceof GhRateLimitError) {
            // Stop fetching further checks for this repo; bubble up so caller can pause cycle
            prs.push(pull)
            throw err
          }
          // Non-rate-limit error on a single PR's checks — leave UNKNOWN, continue
        }
      }

      prs.push(pull)
    }

    const result: RepoFetchResult = {
      repo,
      prs,
      fetchedAt: Date.now(),
      fromCache: list.fromCache,
    }
    writeResult(repo, result)
    return result
  } catch (err) {
    // Rate-limit errors bubble up so the caller can pause the cycle and
    // re-queue this repo; everything else is recorded as a per-repo failure.
    if (err instanceof GhRateLimitError) throw err
    return {
      repo,
      prs: [],
      fetchedAt: Date.now(),
      fromCache: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
