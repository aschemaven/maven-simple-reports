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

import { handlePreflight, jsonResponse, originAllowed } from './_lib/cors.mjs'

// Exchange an OAuth authorization code (received from GitHub) for an access
// token + refresh token. The client_secret stays server-side; PKCE binds the
// request to the SPA's original code_verifier.

interface ExchangeBody {
  code?: string
  code_verifier?: string
  redirect_uri?: string
}

export default async (request: Request): Promise<Response> => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  const origin = request.headers.get('origin')
  if (!originAllowed(origin)) {
    return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, origin)
  }

  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return jsonResponse(500, { error: 'auth_not_configured' }, origin)
  }

  let body: ExchangeBody
  try {
    body = (await request.json()) as ExchangeBody
  } catch {
    return jsonResponse(400, { error: 'invalid_json' }, origin)
  }

  if (!body.code || !body.code_verifier || !body.redirect_uri) {
    return jsonResponse(
      400,
      { error: 'missing_fields', required: ['code', 'code_verifier', 'redirect_uri'] },
      origin,
    )
  }

  const ghRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: body.code,
      code_verifier: body.code_verifier,
      redirect_uri: body.redirect_uri,
    }),
  })

  const text = await ghRes.text()
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    // GitHub returns 200 even for OAuth errors, with `error` in the body.
    const status = parsed.error ? 400 : 200
    return jsonResponse(status, parsed, origin)
  } catch {
    return jsonResponse(
      502,
      { error: 'github_non_json_response', body: text.slice(0, 200) },
      origin,
    )
  }
}
