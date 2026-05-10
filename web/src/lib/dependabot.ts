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
import { deriveBuildState, type CheckRunsResponse } from './buildStatus'
import { MAVEN_OWNER } from './repos'
import type { DependabotPr, RepoFetchResult } from './types'

interface RestPullRequest {
  number: number
  title: string
  user: { login: string; type: string } | null
  created_at: string
  updated_at: string
  draft: boolean
  html_url: string
  head: { sha: string }
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
    const list = await ghFetch<RestPullRequest[]>(
      `/repos/${MAVEN_OWNER}/${repo}/pulls?state=open&per_page=100`,
      { token: opts.token, spaceBeforeMs: opts.spaceBeforeMs },
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
          pull.buildState = deriveBuildState(checks.data)
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

    return {
      repo,
      prs,
      fetchedAt: Date.now(),
      fromCache: list.fromCache,
    }
  } catch (err) {
    return {
      repo,
      prs: [],
      fetchedAt: Date.now(),
      fromCache: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
