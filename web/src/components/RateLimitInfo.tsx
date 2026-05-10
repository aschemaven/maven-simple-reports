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

  const resetIn = Math.max(0, rl.resetAt - Date.now())
  const mins = Math.ceil(resetIn / 60_000)
  const low = rl.remaining < 5
  return (
    <span className={`rate-limit ${low ? 'warn' : ''}`}>
      GitHub API quota: {rl.remaining}/{rl.limit} (resets in {mins} min)
    </span>
  )
}
