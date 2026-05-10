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

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative asset URLs so the same build works at any deploy path:
//   GH Pages: aschemaven.github.io/maven-simple-reports/dependabot-prs/
//   Netlify branch:  <site>--<branch>.netlify.app/dependabot-prs/
//   Local dev:       /dependabot-prs/  (configured separately below)
const base = process.env.PUBLIC_BASE ?? './'

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
})
