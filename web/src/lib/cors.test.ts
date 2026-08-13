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
  corsHeaders,
  handlePreflight,
  originAllowed,
} from '../../../netlify/functions/_lib/cors.mts'

// This allowlist is a security boundary, not a convenience: auth-callback
// redirects the browser to the origin it decodes from the OAuth `state`, so a
// gap here turns the function into an open redirect that leaks an OAuth code.
describe('originAllowed', () => {
  it.each([
    'https://aschemaven.github.io',
    'https://maven-simple-reports.netlify.app',
    'https://pr-9--maven-simple-reports.netlify.app',
    'https://feature-pr-assignee--maven-simple-reports.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:8080',
  ])('accepts %s', (origin) => {
    expect(originAllowed(origin)).toBe(true)
  })

  it.each([
    ['a foreign host', 'https://evil.com'],
    ['a suffix attack', 'https://maven-simple-reports.netlify.app.attacker.io'],
    ['a preview-alias suffix attack', 'https://x--maven-simple-reports.netlify.app.evil.io'],
    ['a prefix attack', 'https://evilmaven-simple-reports.netlify.app'],
    ['plain http on the production host', 'http://maven-simple-reports.netlify.app'],
    ['a look-alike Pages host', 'https://aschemaven.github.io.evil.com'],
    ['localhost without a port', 'http://localhost'],
    ['a path appended to an allowed origin', 'https://maven-simple-reports.netlify.app/evil'],
  ])('rejects %s', (_label, origin) => {
    expect(originAllowed(origin)).toBe(false)
  })

  it.each([null, undefined, ''])('rejects the empty origin %s', (origin) => {
    expect(originAllowed(origin)).toBe(false)
  })
})

describe('corsHeaders', () => {
  it('echoes an allowed origin and varies on it', () => {
    const headers = corsHeaders('http://localhost:5173')
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173')
    expect(headers.Vary).toBe('Origin')
  })

  it('emits nothing at all for a disallowed origin', () => {
    expect(corsHeaders('https://evil.com')).toEqual({})
  })
})

describe('handlePreflight', () => {
  const preflight = (origin: string) =>
    new Request('https://example.test/token-exchange', {
      method: 'OPTIONS',
      headers: { origin },
    })

  it('answers 204 with CORS headers for an allowed origin', () => {
    const res = handlePreflight(preflight('https://maven-simple-reports.netlify.app'))
    expect(res?.status).toBe(204)
    expect(res?.headers.get('access-control-allow-origin')).toBe(
      'https://maven-simple-reports.netlify.app',
    )
  })

  it('answers 403 for a disallowed origin so the failure is visible', () => {
    const res = handlePreflight(preflight('https://evil.com'))
    expect(res?.status).toBe(403)
    expect(res?.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('passes non-preflight requests through untouched', () => {
    const post = new Request('https://example.test/token-exchange', { method: 'POST' })
    expect(handlePreflight(post)).toBeNull()
  })
})
