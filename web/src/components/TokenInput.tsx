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

import { useEffect, useState } from 'react'

// Classic PAT creation page accepts ?description= and ?scopes= query params.
// Leaving scopes empty means no checkboxes are pre-selected — which is what
// we want for read-only public-repo access (any scope would be over-permissioned).
const CLASSIC_PAT_URL =
  'https://github.com/settings/tokens/new?description=Maven+Dependabot+Dashboard+(read-only)'
const FINE_GRAINED_PAT_URL = 'https://github.com/settings/personal-access-tokens/new'

interface Props {
  token: string
  persist: boolean
  onSave: (token: string, persist: boolean) => void
  onClear: () => void
}

export function TokenInput({ token, persist, onSave, onClear }: Props) {
  const [draft, setDraft] = useState(token)
  const [persistDraft, setPersistDraft] = useState(persist)
  const [reveal, setReveal] = useState(false)

  // Resync if the parent state changes outside this component
  useEffect(() => {
    setDraft(token)
  }, [token])
  useEffect(() => {
    setPersistDraft(persist)
  }, [persist])

  const trimmed = draft.trim()
  const dirty = trimmed !== token || persistDraft !== persist

  const save = () => {
    if (!dirty) return
    onSave(trimmed, persistDraft)
  }

  const clear = () => {
    setDraft('')
    onClear()
  }

  const storageLabel = token
    ? persist
      ? 'localStorage (persistent)'
      : 'sessionStorage (this tab only)'
    : '—'

  return (
    <details className="settings">
      <summary>
        Settings ·{' '}
        <span className={token ? 'auth-on' : 'auth-off'}>
          {token ? 'authenticated' : 'anonymous'}
        </span>
      </summary>
      <div className="settings-body">
        <label className="settings-field" htmlFor="gh-token">
          GitHub Personal Access Token
        </label>
        <div className="settings-row">
          <input
            id="gh-token"
            className="token-input"
            type={reveal ? 'text' : 'password'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
            placeholder="ghp_… or github_pat_…"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" onClick={() => setReveal((r) => !r)}>
            {reveal ? 'Hide' : 'Show'}
          </button>
          <button type="button" onClick={save} disabled={!dirty}>
            Save
          </button>
          <button type="button" onClick={clear} disabled={!token && !draft}>
            Clear
          </button>
        </div>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={persistDraft}
            onChange={(e) => setPersistDraft(e.target.checked)}
          />
          Remember on this device (store in <code>localStorage</code>);
          uncheck to keep the token only for this tab (<code>sessionStorage</code>).
        </label>
        <p className="settings-help muted">
          Don't have a token?{' '}
          <a href={CLASSIC_PAT_URL} target="_blank" rel="noreferrer">
            Create a classic PAT
          </a>{' '}
          — leave <em>all scopes unchecked</em>, GitHub still grants the higher rate
          limit for read-only access to public repos. Fine-grained alternative:{' '}
          <a href={FINE_GRAINED_PAT_URL} target="_blank" rel="noreferrer">
            Create a fine-grained PAT
          </a>{' '}
          with <em>Public Repositories (read-only)</em>.
        </p>
        <p className="settings-help muted">
          Currently stored in: <strong>{storageLabel}</strong>. Lifts the API limit
          from 60/h to ~5 000/h and shortens the refresh cycle to 5 min.
        </p>
        <p className="settings-help warn-text">
          The token is stored in your browser in plain text and is exposed to any
          script running on this origin. Only enter it on machines you trust, and
          revoke it on GitHub if the browser profile is shared.
        </p>
      </div>
    </details>
  )
}
