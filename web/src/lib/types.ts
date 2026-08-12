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

export type BuildState =
  | 'SUCCESS'
  | 'FAILURE'
  | 'PENDING'
  | 'CONFLICT'
  | 'UNKNOWN'

export interface RateLimitInfo {
  limit: number
  remaining: number
  resetAt: number // ms epoch
}

export interface PrAssignee {
  login: string
  avatarUrl: string
  htmlUrl: string
}

export interface DependabotPr {
  repo: string
  number: number
  title: string
  author: string
  createdAt: string
  updatedAt: string
  isDraft: boolean
  baseRef: string
  url: string
  checksUrl: string
  headSha: string
  buildState: BuildState
  buildStateFetchedAt: number | null
  /**
   * Optional on purpose: results persisted by earlier versions predate this
   * field, and we want them to keep working rather than force a cache version
   * bump (which would discard every repo's last known state and burn a full
   * refetch cycle against the rate limit).
   *
   * `undefined` therefore means "this cached entry was written before the
   * column existed" — *not* "nobody is assigned". Use `hasAssigneeData()` to
   * tell the two apart and `assigneesOf()` to read the list safely.
   */
  assignees?: PrAssignee[]
}

/**
 * True once a PR has been fetched by a version that knows about assignees.
 * Distinguishes a genuinely unassigned PR from a stale cache entry, so the UI
 * never claims "unassigned" about data it simply does not have yet.
 */
export function hasAssigneeData(pr: DependabotPr): boolean {
  return pr.assignees !== undefined
}

/** Null-safe accessor tolerating pre-assignee entries from `localStorage`. */
export function assigneesOf(pr: DependabotPr): PrAssignee[] {
  return pr.assignees ?? []
}

export interface RepoFetchResult {
  repo: string
  prs: DependabotPr[]
  fetchedAt: number
  fromCache: boolean
  error?: string
  archived?: boolean
}

export interface DashboardState {
  repos: Record<string, RepoFetchResult>
  rateLimit: RateLimitInfo | null
  lastError: string | null
  cycleStartedAt: number | null
  cycleCompletedAt: number | null
  inFlightRepo: string | null
}
