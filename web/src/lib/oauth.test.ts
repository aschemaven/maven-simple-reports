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
  ACCESS_TOKEN_REFRESH_THRESHOLD_MS,
  needsRefresh,
  refreshTokenStillValid,
  type StoredOauthTokens,
} from './oauth'

const NOW = 1_700_000_000_000

function tokens(overrides: Partial<StoredOauthTokens> = {}): StoredOauthTokens {
  return {
    access_token: 'gho_access',
    refresh_token: 'ghr_refresh',
    access_expires_at: NOW + 8 * 60 * 60_000,
    refresh_expires_at: NOW + 180 * 24 * 60 * 60_000,
    ...overrides,
  }
}

describe('needsRefresh', () => {
  it('leaves a comfortably valid access token alone', () => {
    expect(needsRefresh(tokens(), NOW)).toBe(false)
  })

  it('refreshes inside the threshold rather than risking a 401 mid-cycle', () => {
    const almost = tokens({ access_expires_at: NOW + ACCESS_TOKEN_REFRESH_THRESHOLD_MS - 1 })
    expect(needsRefresh(almost, NOW)).toBe(true)
  })

  it('does not refresh exactly at the threshold', () => {
    const edge = tokens({ access_expires_at: NOW + ACCESS_TOKEN_REFRESH_THRESHOLD_MS })
    expect(needsRefresh(edge, NOW)).toBe(false)
  })

  it('treats an already-expired access token as needing refresh', () => {
    expect(needsRefresh(tokens({ access_expires_at: NOW - 1 }), NOW)).toBe(true)
  })
})

describe('refreshTokenStillValid', () => {
  it('accepts a refresh token with time left', () => {
    expect(refreshTokenStillValid(tokens(), NOW)).toBe(true)
  })

  it('rejects an expired refresh token so the app falls back instead of looping', () => {
    expect(refreshTokenStillValid(tokens({ refresh_expires_at: NOW - 1 }), NOW)).toBe(false)
  })

  it('rejects a refresh token expiring exactly now', () => {
    expect(refreshTokenStillValid(tokens({ refresh_expires_at: NOW }), NOW)).toBe(false)
  })
})
