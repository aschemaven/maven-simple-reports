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

import type { RateLimitInfo as RL } from '../lib/types'

export function RateLimitInfo({ rl }: { rl: RL | null }) {
  if (!rl) return <span className="rate-limit muted">rate limit: unknown</span>

  const used = Math.max(0, rl.limit - rl.remaining)
  // 60/h is the anonymous IP-shared quota — reset time is actionable there.
  // With a PAT (limit ~5000) reset is rarely relevant and the value can flicker
  // between resource buckets, so we omit it.
  const isAnonymous = rl.limit <= 60
  const low = isAnonymous ? rl.remaining < 5 : rl.remaining < rl.limit * 0.05

  let resetSuffix = ''
  if (isAnonymous) {
    const resetTime = new Date(rl.resetAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    const mins = Math.max(0, Math.ceil((rl.resetAt - Date.now()) / 60_000))
    resetSuffix = ` · resets at ${resetTime} (in ${mins} min)`
  }

  return (
    <span className={`rate-limit ${low ? 'warn' : ''}`}>
      GitHub API: {rl.remaining} left of {rl.limit} ({used} used){resetSuffix}
    </span>
  )
}
