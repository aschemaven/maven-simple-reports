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

import { generateCodeChallenge, generateCodeVerifier, generateCsrfToken } from './pkce'

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'

// Base URL hosting our three Netlify Functions (auth-callback, token-exchange,
// token-refresh). Same on every SPA origin (localhost, GH Pages, Netlify
// previews) — the functions echo the SPA origin back from the state parameter,
// and CORS is gated by an allowlist in the function itself.
export const AUTH_ENDPOINT =
  import.meta.env.VITE_AUTH_ENDPOINT ?? 'https://maven-simple-reports.netlify.app'

export const CLIENT_ID = (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? ''

const REDIRECT_URI = `${AUTH_ENDPOINT}/.netlify/functions/auth-callback`
const TOKEN_EXCHANGE_URL = `${AUTH_ENDPOINT}/.netlify/functions/token-exchange`
const TOKEN_REFRESH_URL = `${AUTH_ENDPOINT}/.netlify/functions/token-refresh`

const STATE_SESSION_KEY = 'gh-oauth-csrf:v1'
const VERIFIER_SESSION_KEY = 'gh-oauth-verifier:v1'

export function oauthConfigured(): boolean {
  return CLIENT_ID.length > 0
}

interface OauthState {
  origin: string
  // Path on which the SPA lives. The auth-callback function appends this when
  // redirecting back so we land on the SPA, not on whatever else is at the
  // origin's root (e.g. a static AsciiDoctor index on Netlify previews).
  path: string
  csrf: string
}

function encodeState(state: OauthState): string {
  const json = JSON.stringify(state)
  // base64url: + → -, / → _, no padding
  return btoa(json).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function decodeState(raw: string): OauthState {
  const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4))
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + pad
  return JSON.parse(atob(b64)) as OauthState
}

/**
 * Begin the OAuth flow by storing PKCE + CSRF state in sessionStorage and
 * redirecting the browser to GitHub's authorize endpoint. The user comes
 * back to this SPA's origin (via the central auth-callback function) with
 * `?code=…&state=…` in the URL, which `completeOAuthFlow` then handles.
 */
export async function startOAuthFlow(): Promise<void> {
  if (!CLIENT_ID) {
    throw new Error(
      'VITE_GITHUB_CLIENT_ID is not configured. Set it in web/.env.local or the build environment.',
    )
  }

  const verifier = generateCodeVerifier()
  const challenge = await generateCodeChallenge(verifier)
  const csrf = generateCsrfToken()

  sessionStorage.setItem(VERIFIER_SESSION_KEY, verifier)
  sessionStorage.setItem(STATE_SESSION_KEY, csrf)

  const state = encodeState({
    origin: window.location.origin,
    path: window.location.pathname,
    csrf,
  })

  const url = new URL(GITHUB_AUTHORIZE_URL)
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')

  window.location.href = url.toString()
}

export interface StoredOauthTokens {
  access_token: string
  refresh_token: string
  /** ms epoch when the access_token stops being accepted by GitHub (~8h after issue). */
  access_expires_at: number
  /** ms epoch when the refresh_token stops being valid (~6mo after issue). */
  refresh_expires_at: number
}

interface GithubTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

function toStoredTokens(payload: GithubTokenResponse): StoredOauthTokens {
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error('Token response missing access_token or refresh_token')
  }
  const now = Date.now()
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    access_expires_at: now + (payload.expires_in ?? 8 * 3600) * 1000,
    refresh_expires_at: now + (payload.refresh_token_expires_in ?? 180 * 24 * 3600) * 1000,
  }
}

/**
 * Detect and complete an OAuth callback. Returns the stored tokens on success,
 * `null` if there was no callback in the URL, or throws if a callback was
 * present but invalid (state mismatch, exchange failed, etc.).
 *
 * Always clears `code`/`state`/`error` from the URL via history.replaceState
 * so a refresh doesn't replay the exchange.
 */
export async function completeOAuthFlow(): Promise<StoredOauthTokens | null> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const stateRaw = params.get('state')
  const error = params.get('error')

  if (!code && !error) return null

  const clean = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('code')
    url.searchParams.delete('state')
    url.searchParams.delete('error')
    url.searchParams.delete('error_description')
    window.history.replaceState({}, '', url.toString())
  }

  try {
    if (error) {
      const desc = params.get('error_description') ?? ''
      throw new Error(`OAuth provider returned error: ${error}${desc ? ` — ${desc}` : ''}`)
    }

    if (!code || !stateRaw) {
      throw new Error('Callback present but missing code or state')
    }

    let parsedState: OauthState
    try {
      parsedState = decodeState(stateRaw)
    } catch {
      throw new Error('Invalid state parameter')
    }

    const expectedCsrf = sessionStorage.getItem(STATE_SESSION_KEY)
    if (!expectedCsrf || expectedCsrf !== parsedState.csrf) {
      throw new Error(
        'CSRF state mismatch — either the login was tampered with, or you started it in a different tab.',
      )
    }

    const verifier = sessionStorage.getItem(VERIFIER_SESSION_KEY)
    if (!verifier) {
      throw new Error('No PKCE verifier found in this tab — restart the login from the Settings panel.')
    }

    // Clear one-shot session items before the network call so a replay can't
    // re-trigger the exchange even if the function is slow.
    sessionStorage.removeItem(STATE_SESSION_KEY)
    sessionStorage.removeItem(VERIFIER_SESSION_KEY)

    const res = await fetch(TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    })

    const payload = (await res.json().catch(() => ({}))) as GithubTokenResponse
    if (!res.ok || payload.error) {
      const msg = payload.error_description ?? payload.error ?? `HTTP ${res.status}`
      throw new Error(`Token exchange failed: ${msg}`)
    }
    return toStoredTokens(payload)
  } finally {
    clean()
  }
}

/**
 * Refresh an expiring access token. The refresh_token is rotated by GitHub on
 * each call, so the returned StoredOauthTokens should replace the previous
 * record in storage.
 */
export async function refreshOAuthToken(refreshToken: string): Promise<StoredOauthTokens> {
  const res = await fetch(TOKEN_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const payload = (await res.json().catch(() => ({}))) as GithubTokenResponse
  if (!res.ok || payload.error) {
    const msg = payload.error_description ?? payload.error ?? `HTTP ${res.status}`
    throw new Error(`Token refresh failed: ${msg}`)
  }
  return toStoredTokens(payload)
}

/**
 * The refresh threshold: if the access_token expires within this many ms,
 * refresh proactively. 60 seconds gives a comfortable margin against clock
 * skew and request latency.
 */
export const ACCESS_TOKEN_REFRESH_THRESHOLD_MS = 60_000

export function needsRefresh(tokens: StoredOauthTokens, now = Date.now()): boolean {
  return tokens.access_expires_at - now < ACCESS_TOKEN_REFRESH_THRESHOLD_MS
}

export function refreshTokenStillValid(tokens: StoredOauthTokens, now = Date.now()): boolean {
  return tokens.refresh_expires_at > now
}
