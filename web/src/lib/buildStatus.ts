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

export function deriveBuildState(checks: CheckRunsResponse): BuildState {
  if (checks.total_count === 0) return 'UNKNOWN'

  let hasFailure = false
  let hasPending = false
  let hasSuccess = false

  for (const run of checks.check_runs) {
    const status = (run.status || '').toUpperCase()
    const conclusion = (run.conclusion || '').toUpperCase()
    const effective = status === 'COMPLETED' ? conclusion || 'UNKNOWN' : status

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

  if (hasFailure) return 'FAILURE'
  if (hasPending) return 'PENDING'
  if (hasSuccess) return 'SUCCESS'
  return 'UNKNOWN'
}
