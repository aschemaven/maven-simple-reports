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

import type { BuildState } from '../lib/types'

const COLORS: Record<BuildState, string> = {
  SUCCESS: '#137f3a',
  FAILURE: '#b62324',
  PENDING: '#9a6700',
  CONFLICT: '#7c2d12',
  UNKNOWN: '#57606a',
}

export function StatusBadge({ state }: { state: BuildState }) {
  return (
    <span className="status-badge" style={{ backgroundColor: COLORS[state] }}>
      {state}
    </span>
  )
}
