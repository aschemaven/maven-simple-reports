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

const PREFIX = 'gh-cache:v1:'

interface Entry<T> {
  etag: string | null
  body: T
  fetchedAt: number
}

export function readCache<T>(key: string): Entry<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    return JSON.parse(raw) as Entry<T>
  } catch {
    return null
  }
}

export function writeCache<T>(key: string, entry: Entry<T>): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(entry))
  } catch {
    // Quota exceeded or storage disabled — fail open, in-memory state still works
  }
}

export function deleteCache(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    // ignore
  }
}
