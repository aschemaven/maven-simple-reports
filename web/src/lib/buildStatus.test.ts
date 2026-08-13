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

import { describe, expect, it } from 'vitest'
import {
  deriveBuildState,
  type CheckRunsResponse,
  type CommitStatusResponse,
} from './buildStatus'

function checks(...runs: Array<[status: string, conclusion: string | null]>): CheckRunsResponse {
  return {
    total_count: runs.length,
    check_runs: runs.map(([status, conclusion]) => ({ status, conclusion })),
  }
}

function combined(state: string, ...statuses: string[]): CommitStatusResponse {
  return { state, statuses: statuses.map((s, i) => ({ state: s, context: `ctx-${i}` })) }
}

describe('deriveBuildState — check runs', () => {
  it('reports UNKNOWN when there is nothing to go on', () => {
    expect(deriveBuildState(checks())).toBe('UNKNOWN')
  })

  it.each([
    ['success', 'SUCCESS'],
    ['neutral', 'SUCCESS'],
    ['skipped', 'SUCCESS'],
    ['failure', 'FAILURE'],
    ['timed_out', 'FAILURE'],
    ['cancelled', 'FAILURE'],
    ['action_required', 'FAILURE'],
    ['startup_failure', 'FAILURE'],
  ])('maps a completed run with conclusion %s to %s', (conclusion, expected) => {
    expect(deriveBuildState(checks(['completed', conclusion]))).toBe(expected)
  })

  it.each(['queued', 'in_progress', 'waiting', 'pending'])(
    'treats an uncompleted run in state %s as PENDING',
    (state) => {
      expect(deriveBuildState(checks([state, null]))).toBe('PENDING')
    },
  )

  it('ignores a completed run that carries no conclusion', () => {
    expect(deriveBuildState(checks(['completed', null]))).toBe('UNKNOWN')
  })

  it('lets failure win over pending and success', () => {
    const state = deriveBuildState(
      checks(['completed', 'success'], ['in_progress', null], ['completed', 'failure']),
    )
    expect(state).toBe('FAILURE')
  })

  it('lets pending win over success', () => {
    expect(deriveBuildState(checks(['completed', 'success'], ['queued', null]))).toBe('PENDING')
  })

  it('is case-insensitive about status and conclusion', () => {
    expect(deriveBuildState(checks(['COMPLETED', 'FAILURE']))).toBe('FAILURE')
  })
})

describe('deriveBuildState — legacy combined status', () => {
  // Apache Jenkins posts to the combined-status API rather than check-runs,
  // so this source is the only signal for maven-box plugin builds.
  it.each([
    ['failure', 'FAILURE'],
    ['error', 'FAILURE'],
    ['pending', 'PENDING'],
    ['success', 'SUCCESS'],
  ])('folds a combined status of %s into %s', (state, expected) => {
    expect(deriveBuildState(checks(), combined(state, state))).toBe(expected)
  })

  it('ignores the rolled-up state when there are no individual entries', () => {
    // GitHub reports state=pending for "nothing reported yet"; trusting it
    // would show every PR without Jenkins as perpetually pending.
    expect(deriveBuildState(checks(), combined('pending'))).toBe('UNKNOWN')
  })

  it('does not let a green combined status mask a failing check run', () => {
    expect(deriveBuildState(checks(['completed', 'failure']), combined('success', 'success'))).toBe(
      'FAILURE',
    )
  })

  it('surfaces a Jenkins failure that check runs know nothing about', () => {
    expect(deriveBuildState(checks(['completed', 'success']), combined('failure', 'failure'))).toBe(
      'FAILURE',
    )
  })

  it('tolerates a null status argument', () => {
    expect(deriveBuildState(checks(['completed', 'success']), null)).toBe('SUCCESS')
  })
})
