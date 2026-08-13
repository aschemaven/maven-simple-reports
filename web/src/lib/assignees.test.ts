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
  ASSIGNEE_ALL,
  ASSIGNEE_ANY,
  ASSIGNEE_NONE,
  collectAssignees,
  countAssigned,
  filterPrs,
  matchesAssignee,
} from './assignees'
import { assigneesOf, hasAssigneeData } from './types'
import type { DependabotPr, RepoFetchResult } from './types'

function pr(number: number, assignees?: string[]): DependabotPr {
  const base: DependabotPr = {
    repo: 'maven-site',
    number,
    title: `Bump something to ${number}`,
    author: 'dependabot[bot]',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    isDraft: false,
    baseRef: 'master',
    url: `https://github.com/apache/maven-site/pull/${number}`,
    checksUrl: '',
    headSha: 'abc',
    buildState: 'SUCCESS',
    buildStateFetchedAt: null,
  }
  if (assignees === undefined) return base
  return {
    ...base,
    assignees: assignees.map((login) => ({
      login,
      avatarUrl: `https://avatars.example/${login}`,
      htmlUrl: `https://github.com/${login}`,
    })),
  }
}

/** A PR as persisted by a version that predates the assignee column. */
const legacyPr = pr(1)
const unassigned = pr(2, [])
const assignedToAnna = pr(3, ['anna'])
const assignedToBoth = pr(4, ['anna', 'ben'])

describe('hasAssigneeData', () => {
  it('separates "not fetched yet" from "nobody assigned"', () => {
    expect(hasAssigneeData(legacyPr)).toBe(false)
    expect(hasAssigneeData(unassigned)).toBe(true)
  })

  it('reads a missing list as empty without throwing', () => {
    expect(assigneesOf(legacyPr)).toEqual([])
  })
})

describe('matchesAssignee', () => {
  it('lets everything through under "all", including unknown entries', () => {
    for (const p of [legacyPr, unassigned, assignedToAnna]) {
      expect(matchesAssignee(p, ASSIGNEE_ALL)).toBe(true)
    }
  })

  it('matches a specific login', () => {
    expect(matchesAssignee(assignedToAnna, 'anna')).toBe(true)
    expect(matchesAssignee(assignedToAnna, 'ben')).toBe(false)
    expect(matchesAssignee(assignedToBoth, 'ben')).toBe(true)
  })

  it('matches "assigned to anyone" only when somebody is', () => {
    expect(matchesAssignee(assignedToAnna, ASSIGNEE_ANY)).toBe(true)
    expect(matchesAssignee(unassigned, ASSIGNEE_ANY)).toBe(false)
  })

  it('matches "unassigned" only for a PR known to have nobody', () => {
    expect(matchesAssignee(unassigned, ASSIGNEE_NONE)).toBe(true)
    expect(matchesAssignee(assignedToAnna, ASSIGNEE_NONE)).toBe(false)
  })

  // The point of the distinction: a stale cache entry must never be presented
  // as free for the taking, nor as belonging to somebody.
  it('excludes an entry with unknown assignees from both directions', () => {
    expect(matchesAssignee(legacyPr, ASSIGNEE_NONE)).toBe(false)
    expect(matchesAssignee(legacyPr, ASSIGNEE_ANY)).toBe(false)
    expect(matchesAssignee(legacyPr, 'anna')).toBe(false)
  })
})

describe('filterPrs', () => {
  const all = [legacyPr, unassigned, assignedToAnna, assignedToBoth]

  it('returns the input untouched under "all"', () => {
    expect(filterPrs(all, ASSIGNEE_ALL)).toBe(all)
  })

  it('narrows to one person', () => {
    expect(filterPrs(all, 'anna').map((p) => p.number)).toEqual([3, 4])
  })

  it('narrows to unassigned without dragging in unknown entries', () => {
    expect(filterPrs(all, ASSIGNEE_NONE).map((p) => p.number)).toEqual([2])
  })

  it('yields nothing for a login nobody has', () => {
    expect(filterPrs(all, 'nobody')).toEqual([])
  })
})

describe('countAssigned', () => {
  it('counts PRs with at least one assignee', () => {
    expect(countAssigned([legacyPr, unassigned, assignedToAnna, assignedToBoth])).toBe(2)
  })

  it('counts nothing in an empty set', () => {
    expect(countAssigned([])).toBe(0)
  })
})

describe('collectAssignees', () => {
  const results: Record<string, RepoFetchResult> = {
    'maven-site': {
      repo: 'maven-site',
      prs: [assignedToAnna, unassigned],
      fetchedAt: 0,
      fromCache: false,
    },
    'maven-wrapper': {
      repo: 'maven-wrapper',
      prs: [assignedToBoth, legacyPr],
      fetchedAt: 0,
      fromCache: false,
    },
  }

  it('collects distinct logins across repos, sorted', () => {
    expect(collectAssignees(results)).toEqual(['anna', 'ben'])
  })

  it('returns nothing when no repo has been fetched', () => {
    expect(collectAssignees({})).toEqual([])
  })
})
