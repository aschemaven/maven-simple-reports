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

interface Props {
  pattern: string
  onChange: (next: string) => void
  matchCount: number
  totalCount: number
  invalid: boolean
}

export function FilterInput({ pattern, onChange, matchCount, totalCount, invalid }: Props) {
  return (
    <div className={`filter${invalid ? ' invalid' : ''}`}>
      <label htmlFor="repo-filter">
        Filter (regex)
      </label>
      <input
        id="repo-filter"
        type="text"
        value={pattern}
        placeholder="e.g. mvnd|surefire|^maven$"
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        className="filter-reset"
        onClick={() => onChange('')}
        disabled={!pattern}
        title="Clear filter and show all repositories"
      >
        Reset
      </button>
      <span className="filter-status muted">
        {invalid ? 'invalid regex — showing all' : `${matchCount}/${totalCount} repos match`}
      </span>
    </div>
  )
}
