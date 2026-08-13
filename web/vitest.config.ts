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

import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: the test run needs neither the
// React plugin nor the deploy-path `base`, and keeping them apart means a
// change to the build config cannot quietly alter how tests execute.
export default defineConfig({
  test: {
    // jsdom supplies localStorage/sessionStorage, which cache.ts and the
    // ETag layer in githubFetch.ts depend on.
    environment: 'jsdom',
    environmentOptions: {
      // jsdom refuses storage on opaque origins (SecurityError), and the
      // default document URL is one — without an explicit http:// URL both
      // localStorage and sessionStorage come out undefined.
      jsdom: { url: 'http://localhost:5173/' },
    },
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
})
