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

import type { BuildState } from './types'

interface CheckRun {
  status: string
  conclusion: string | null
}

export interface CheckRunsResponse {
  total_count: number
  check_runs: CheckRun[]
}

interface CommitStatus {
  state: string
  context: string
}

// Legacy combined-status API. Apache Jenkins (ci-maven.apache.org) posts
// build results here as StatusContext entries instead of CheckRuns, so
// without this source the dashboard misses Jenkins failures on plugin PRs.
export interface CommitStatusResponse {
  state: string
  statuses: CommitStatus[]
}

export function deriveBuildState(
  checks: CheckRunsResponse,
  status?: CommitStatusResponse | null,
): BuildState {
  let hasFailure = false
  let hasPending = false
  let hasSuccess = false

  for (const run of checks.check_runs) {
    const runStatus = (run.status || '').toUpperCase()
    const conclusion = (run.conclusion || '').toUpperCase()
    const effective = runStatus === 'COMPLETED' ? conclusion || 'UNKNOWN' : runStatus

    if (
      effective === 'FAILURE' ||
      effective === 'TIMED_OUT' ||
      effective === 'CANCELLED' ||
      effective === 'ACTION_REQUIRED' ||
      effective === 'STARTUP_FAILURE'
    ) {
      hasFailure = true
    } else if (
      effective === 'QUEUED' ||
      effective === 'IN_PROGRESS' ||
      effective === 'WAITING' ||
      effective === 'PENDING'
    ) {
      hasPending = true
    } else if (effective === 'SUCCESS' || effective === 'NEUTRAL' || effective === 'SKIPPED') {
      hasSuccess = true
    }
  }

  // Combined-status rolls "no statuses" up to state=pending — only trust the
  // individual entries, so an empty array stays neutral (UNKNOWN-eligible).
  if (status && status.statuses.length > 0) {
    for (const s of status.statuses) {
      const state = (s.state || '').toUpperCase()
      if (state === 'FAILURE' || state === 'ERROR') hasFailure = true
      else if (state === 'PENDING') hasPending = true
      else if (state === 'SUCCESS') hasSuccess = true
    }
  }

  if (hasFailure) return 'FAILURE'
  if (hasPending) return 'PENDING'
  if (hasSuccess) return 'SUCCESS'
  return 'UNKNOWN'
}
