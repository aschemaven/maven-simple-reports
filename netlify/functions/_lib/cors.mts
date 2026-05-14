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

// Origin allowlist for both the CORS response header (token-exchange,
// token-refresh) and the auth-callback's 302 redirect destination. The same
// list is used in both places so the SPA can only hand off the OAuth code
// back to an origin we recognise — preventing the function from being used
// as an open redirect.
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^https:\/\/aschemaven\.github\.io$/,
  /^https:\/\/maven-simple-reports\.netlify\.app$/,
  /^https:\/\/[a-z0-9-]+--maven-simple-reports\.netlify\.app$/,
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
  // Future: /^https:\/\/.*\.aschemann\.net$/
]

export function originAllowed(origin: string | null | undefined): origin is string {
  return !!origin && ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))
}

export function corsHeaders(origin: string | null | undefined): Record<string, string> {
  if (!originAllowed(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  }
}

/**
 * Handle a CORS preflight (OPTIONS) request. Returns a Response if the
 * request was preflight, otherwise null. 403 for disallowed origins so the
 * browser surfaces the failure clearly.
 */
export function handlePreflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null
  const origin = request.headers.get('origin')
  if (!originAllowed(origin)) return new Response(null, { status: 403 })
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export function jsonResponse(
  status: number,
  body: unknown,
  origin: string | null | undefined,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  })
}
