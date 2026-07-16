#!/usr/bin/env python3
#
# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
"""Re-examination stage of the Maven 4 adoption registry pipeline.

Live-checks registry entries via the core (Contents) API — NOT the flaky
code-search API — so the adoption count no longer depends on the search's
rate-limit weather:

  - repo reachable? -> state active/archived/gone (+ gone_since, rename)
  - Maven 4 signal: root pom.xml (POM 4.1.0) or root wrapper; if neither,
    a recursive git-tree walk finds nested wrappers/poms/workflows
  - Maven runtime version from the signal file
  - last_checked timestamp per entry

--max-checks N staggers work for the frequent incremental job (Job B):
only the N stalest entries (by last_checked) are re-examined per run,
keeping each run inside GITHUB_TOKEN's 1000 requests/hour budget. Job A
passes 0 (= everything).

Usage: registry_reexamine.py <registry.json> [--max-checks N]
"""
import argparse
import sys
from concurrent.futures import ThreadPoolExecutor

from registry_lib import (gh, load_registry, save_registry, today, now_iso,
                          clean_version, VER_RE, POM_RE)


def probe_root(full):
    """Root pom.xml / root wrapper. Returns (signal, version, source)."""
    st, content = gh(f'repos/{full}/contents/pom.xml', raw=True)
    if st == 'ok' and content:
        m = POM_RE.search(content)
        if m and m.group(1) == '4.1.0':
            return 'POM 4.1.0', '4.1.0 (POM model)', 'root'
    st, content = gh(f'repos/{full}/contents/.mvn/wrapper/maven-wrapper.properties',
                     raw=True)
    if st == 'ok' and content:
        m = VER_RE.search(content)
        if m:
            return 'Wrapper', clean_version(m.group(1)), 'root'
    return None, None, None


def probe_nested(full, default_branch):
    """Git-tree walk below the root. Returns (signal, version, source)."""
    st, tree = gh(f'repos/{full}/git/trees/{default_branch}?recursive=1')
    if st != 'ok' or 'tree' not in tree:
        return None, None, None
    paths = [t['path'] for t in tree['tree'] if t.get('type') == 'blob']
    wrappers = [p for p in paths if p.endswith('maven-wrapper.properties')][:6]
    poms = [p for p in paths if p.endswith('pom.xml')][:10]
    flows = [p for p in paths if p.startswith('.github/workflows/')
             and p.endswith(('.yml', '.yaml'))][:6]
    for p in wrappers:
        s, c = gh(f'repos/{full}/contents/{p}', raw=True)
        if s == 'ok' and c:
            m = VER_RE.search(c)
            if m:
                return 'Wrapper', clean_version(m.group(1)), f'nested:{p}'
    for p in poms:
        s, c = gh(f'repos/{full}/contents/{p}', raw=True)
        if s == 'ok' and c:
            m = POM_RE.search(c)
            if m and m.group(1) == '4.1.0':
                return 'POM 4.1.0', '4.1.0 (POM model)', f'nested:{p}'
    for p in flows:
        s, c = gh(f'repos/{full}/contents/{p}', raw=True)
        if s == 'ok' and c and 'apache-maven-4' in c:
            m = VER_RE.search(c)
            return ('GH Action', clean_version(m.group(1)) if m else '',
                    f'nested:{p}')
    return None, None, None


def examine(entry):
    name = entry['repo']
    st, meta = gh(f'repos/{name}')
    entry['last_checked'] = now_iso()
    if st == '404':
        if entry.get('state') != 'gone':
            entry['gone_since'] = today()
        entry['state'] = 'gone'
        entry['live_signal'] = None
        entry['live_version'] = None
        return entry
    if st != 'ok':
        return entry  # transient error: keep previous knowledge
    entry.pop('gone_since', None)
    full = meta.get('full_name', name)
    entry['current_full_name'] = full
    entry['renamed_to'] = full if full.lower() != name.lower() else ''
    entry['state'] = 'archived' if meta.get('archived') else 'active'
    entry['stars'] = meta.get('stargazers_count', 0)
    entry['pushed_at'] = (meta.get('pushed_at') or '')[:10]

    sig, ver, src = probe_root(full)
    if sig is None:
        sig, ver, src = probe_nested(full, meta.get('default_branch', 'main'))
    entry['live_signal'] = sig
    entry['live_version'] = ver
    entry['source'] = src
    if sig:
        entry['lastknown_signal'] = sig
        entry['lastknown_version'] = ver
    return entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('registry')
    ap.add_argument('--max-checks', type=int, default=0,
                    help='re-examine only the N stalest entries (0 = all)')
    args = ap.parse_args()

    reg = load_registry(args.registry)
    entries = reg['repos']
    todo = sorted(entries, key=lambda e: e.get('last_checked') or '')
    if args.max_checks > 0:
        todo = todo[:args.max_checks]
    print(f"Re-examining {len(todo)} of {len(entries)} entries...",
          file=sys.stderr)

    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, _ in enumerate(ex.map(examine, todo), 1):
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}", file=sys.stderr)

    save_registry(args.registry, reg)
    confirmed = sum(1 for e in entries if e.get('live_signal'))
    gone = sum(1 for e in entries if e.get('state') == 'gone')
    print(f"\nRegistry: {len(entries)} tracked, {confirmed} confirmed live "
          f"M4 signal, {gone} gone", file=sys.stderr)


if __name__ == '__main__':
    main()
