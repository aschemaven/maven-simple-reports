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

import { assigneesOf, hasAssigneeData } from './types'
import type { DependabotPr, RepoFetchResult } from './types'

/** Sentinel values for the assignee dropdown; anything else is a GitHub login. */
export const ASSIGNEE_ALL = 'all'
export const ASSIGNEE_ANY = '__any__'
export const ASSIGNEE_NONE = '__none__'

export function countAssigned(prs: DependabotPr[]): number {
  return prs.filter((pr) => assigneesOf(pr).length > 0).length
}

export function matchesAssignee(pr: DependabotPr, filter: string): boolean {
  if (filter === ASSIGNEE_ALL) return true
  // A PR whose entry predates the column is *unknown*, not unassigned — it
  // must not show up under "Unassigned" and claim nobody has picked it up.
  if (!hasAssigneeData(pr)) return false
  const assignees = assigneesOf(pr)
  if (filter === ASSIGNEE_ANY) return assignees.length > 0
  if (filter === ASSIGNEE_NONE) return assignees.length === 0
  return assignees.some((a) => a.login === filter)
}

export function filterPrs(prs: DependabotPr[], assigneeFilter: string): DependabotPr[] {
  if (assigneeFilter === ASSIGNEE_ALL) return prs
  return prs.filter((pr) => matchesAssignee(pr, assigneeFilter))
}

/** Distinct logins across everything fetched so far, for the dropdown. */
export function collectAssignees(results: Record<string, RepoFetchResult>): string[] {
  const logins = new Set<string>()
  for (const result of Object.values(results)) {
    for (const pr of result.prs) {
      for (const a of assigneesOf(pr)) logins.add(a.login)
    }
  }
  return [...logins].sort((a, b) => a.localeCompare(b))
}
