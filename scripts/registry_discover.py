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
"""Discovery stage of the Maven 4 adoption registry pipeline.

Runs the three Maven 4 code searches and folds the found repos into the
registry: known repos get their last_seen refreshed, unknown repos are
added (first_seen = today) for the re-examination stage to fill in.

Two modes:
  incremental  (Job B, frequent): sort=indexed&order=desc so newly indexed
      matches come first; stop paginating a query once 2 consecutive pages
      brought no unknown repo. Cheap — the registry does the counting, the
      search only has to spot NEW adopters.
  full         (Job A, daily): paginate every query to the end (with the
      escalating rate-limit retry). Catches whatever the early-stop missed
      and records the reconciliation delta that the report annotates.

Usage: registry_discover.py <registry.json> --mode incremental|full
"""
import argparse
import sys
import time

from registry_lib import (gh, load_registry, save_registry, by_name, today,
                          load_excluded, is_excluded)

QUERIES = [
    ('POM 4.1.0', '"maven.apache.org/POM/4.1.0" filename:pom.xml'),
    ('Wrapper', 'filename:maven-wrapper.properties "apache-maven-4"'),
    ('GH Action', 'path:.github/workflows "apache-maven-4"'),
]
PAGE_DELAY = 7      # code search allows ~10 requests/minute
MAX_PAGES = 10      # search API serves at most 1000 results
DRY_PAGES_STOP = 2  # incremental: stop after N consecutive pages w/o news


def search_pages(query, label, mode, known, excluded=frozenset()):
    """Yield repo full_names found for one query. Returns set of names."""
    found = set()
    dry = 0
    params_base = {'q': query, 'per_page': '100'}
    if mode == 'incremental':
        params_base.update({'sort': 'indexed', 'order': 'desc'})
    for page in range(1, MAX_PAGES + 1):
        print(f"  Searching '{label}' page {page}...", file=sys.stderr)
        st, data = gh('search/code', params={**params_base, 'page': str(page)})
        if st != 'ok' or not isinstance(data, dict) or 'items' not in data:
            print(f"  WARNING: '{label}' page {page} failed ({data}); "
                  f"stopping this query.", file=sys.stderr)
            break
        total = data.get('total_count', 0)
        if page == 1:
            print(f"  Total matches: {total}", file=sys.stderr)
            if total > MAX_PAGES * 100:
                print(f"  WARNING: {total} matches exceed the search API's "
                      f"1000-result window; full coverage relies on the "
                      f"registry, not this single sweep.", file=sys.stderr)
        items = data['items']
        page_names = {i.get('repository', {}).get('full_name', '')
                      for i in items} - {''}
        new_here = {n for n in page_names
                    if n.lower() not in known and not is_excluded(n, excluded)}
        found |= page_names
        if mode == 'incremental':
            dry = dry + 1 if not new_here else 0
            if dry >= DRY_PAGES_STOP:
                print(f"  '{label}': {dry} pages without news — early stop.",
                      file=sys.stderr)
                break
        if len(items) < 100:
            break
        time.sleep(PAGE_DELAY)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('registry')
    ap.add_argument('--mode', choices=['incremental', 'full'],
                    default='incremental')
    args = ap.parse_args()

    reg = load_registry(args.registry)
    known = by_name(reg)
    excluded = load_excluded()
    print(f"Registry: {len(reg['repos'])} tracked repos. "
          f"Discovery mode: {args.mode}. "
          f"{len(excluded)} Maven component repos excluded.", file=sys.stderr)

    found_all = set()
    for label, query in QUERIES:
        found_all |= search_pages(query, label, args.mode, known, excluded)
        time.sleep(PAGE_DELAY)

    # Maven's own components are tooling, not adopters
    dropped = {n for n in found_all if is_excluded(n, excluded)}
    if dropped:
        print(f"Excluded {len(dropped)} Maven component repos: "
              f"{', '.join(sorted(dropped))}", file=sys.stderr)
    found_all -= dropped

    new_names = sorted(n for n in found_all if n.lower() not in known)
    for name in new_names:
        reg['repos'].append({
            'repo': name,
            'state': 'active',       # provisional; re-examination confirms
            'first_seen': today(),
            'last_seen': today(),
        })
    for name in found_all:
        entry = known.get(name.lower())
        if entry is not None:
            entry['last_seen'] = today()

    if args.mode == 'full':
        reg['reconciliation'] = {
            'date': today(),
            'missed': len(new_names),
            'found_total': len(found_all),
        }

    save_registry(args.registry, reg)
    print(f"\nDiscovery: {len(found_all)} repos found, "
          f"{len(new_names)} new -> registry now {len(reg['repos'])}",
          file=sys.stderr)
    if new_names:
        for n in new_names[:20]:
            print(f"  NEW {n}", file=sys.stderr)


if __name__ == '__main__':
    main()
