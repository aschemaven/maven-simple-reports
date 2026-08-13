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

/**
 * Guarantee Web Storage in the test environment.
 *
 * Node 26 ships an experimental global `localStorage` that is undefined unless
 * `--localstorage-file` is passed. That global shadows the one jsdom would
 * otherwise expose, so under this Node/Vitest combination both `localStorage`
 * and `sessionStorage` come out undefined even though jsdom itself provides
 * them (verified: a standalone JSDOM with the same http:// URL has working
 * storage). Rather than pin Node or the runner, install a spec-shaped
 * in-memory Storage — but only where one is genuinely missing, so a fixed
 * environment silently goes back to the real implementation.
 *
 * cache.ts only uses getItem/setItem/removeItem/clear/length/key, all of which
 * behave here as the spec requires (string coercion, null for absent keys).
 */
class MemoryStorage implements Storage {
  private entries = new Map<string, string>()

  get length(): number {
    return this.entries.size
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    const value = this.entries.get(String(key))
    return value === undefined ? null : value
  }

  setItem(key: string, value: string): void {
    this.entries.set(String(key), String(value))
  }

  removeItem(key: string): void {
    this.entries.delete(String(key))
  }

  clear(): void {
    this.entries.clear()
  }
}

function installIfMissing(name: 'localStorage' | 'sessionStorage'): void {
  const existing = (globalThis as Record<string, unknown>)[name]
  if (existing) return
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
    writable: true,
  })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, { value: storage, configurable: true, writable: true })
  }
}

installIfMissing('localStorage')
installIfMissing('sessionStorage')
