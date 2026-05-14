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

import { originAllowed } from './_lib/cors.mjs'

// Stable OAuth callback. GitHub redirects here with ?code=&state=. The state
// is a base64-encoded JSON `{ origin, path, csrf }`, written by the SPA before
// the authorize step. We validate the origin against the allowlist and 302
// back to <origin><path> with code + state intact, so the SPA can finish the
// exchange from its own URL — important when the SPA isn't at the origin's
// root (e.g. /dependabot-prs/ on this deploy).

interface DecodedState {
  origin?: string
  path?: string
  csrf?: string
}

function decodeBase64Url(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  if (typeof atob === 'function') return atob(b64)
  return Buffer.from(b64, 'base64').toString('utf-8')
}

export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const stateRaw = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const errorDescription = url.searchParams.get('error_description')

  if (!stateRaw) {
    return new Response('Missing state parameter', { status: 400 })
  }

  let parsed: DecodedState
  try {
    parsed = JSON.parse(decodeBase64Url(stateRaw)) as DecodedState
  } catch {
    return new Response('Invalid state encoding', { status: 400 })
  }

  if (!originAllowed(parsed.origin)) {
    return new Response(
      `Origin '${parsed.origin ?? '(missing)'}' is not in the allowlist. ` +
        'If you reached this page legitimately, update ALLOWED_ORIGIN_PATTERNS in netlify/functions/_lib/cors.mts.',
      { status: 403 },
    )
  }

  // Resolve the destination path on the trusted origin. We must guard against
  // protocol-relative (`//evil.example/x`) or absolute (`https://...`) paths
  // that the URL constructor would happily resolve away from the origin.
  // After parsing, the resulting origin must still match the allowlisted one.
  const rawPath = typeof parsed.path === 'string' && parsed.path.startsWith('/') ? parsed.path : '/'
  let dest: URL
  try {
    dest = new URL(rawPath, parsed.origin)
  } catch {
    return new Response('Invalid path in state', { status: 400 })
  }
  if (dest.origin !== parsed.origin) {
    return new Response('Path attempts to break out of origin', { status: 400 })
  }
  if (code) dest.searchParams.set('code', code)
  dest.searchParams.set('state', stateRaw)
  if (error) dest.searchParams.set('error', error)
  if (errorDescription) dest.searchParams.set('error_description', errorDescription)

  return Response.redirect(dest.toString(), 302)
}
