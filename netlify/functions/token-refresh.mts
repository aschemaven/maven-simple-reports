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

// Refresh a GitHub App user-to-server access token using the refresh_token
// grant. Returns the new access_token (8h) and a rotated refresh_token (6mo).

interface RefreshBody {
  refresh_token?: string
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

  let body: RefreshBody
  try {
    body = (await request.json()) as RefreshBody
  } catch {
    return jsonResponse(400, { error: 'invalid_json' }, origin)
  }

  if (!body.refresh_token) {
    return jsonResponse(400, { error: 'missing_refresh_token' }, origin)
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
      grant_type: 'refresh_token',
      refresh_token: body.refresh_token,
    }),
  })

  const text = await ghRes.text()
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
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
