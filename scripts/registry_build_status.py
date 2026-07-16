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
"""Build-status stage of the Maven 4 adoption registry pipeline.

"Last Build" means: the most recent COMPLETED run, on the DEFAULT BRANCH,
of a workflow whose file actually invokes Maven (mvn/mvnw or setup-java).

Why content-based: name matching is wrong in both directions — real Maven
builds are often named just "CI"/"build" (false NONE), while Dependabot's
dynamic "maven in /." update runs match "maven" without being a build.
Dynamic workflows (path dynamic/...) have no file and are skipped, which
excludes Dependabot updaters automatically.

Several Maven workflows with differing decisive results -> AMBIGUOUS,
linking to the repo's Actions view (we cannot tell which workflow is the
Maven-4-relevant one). CANCELLED/SKIPPED runs neither confirm nor
contradict a result, so they do not break agreement.

--max-checks N staggers work for the frequent incremental job (Job B):
only the N stalest entries (by build_checked) are refreshed per run.

Usage: registry_build_status.py <registry.json> [--max-checks N]
"""
import argparse
import sys
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from registry_lib import gh, load_registry, save_registry, now_iso

# A workflow is a Maven workflow if its file invokes mvn/mvnw or sets up Java.
MAVEN_CMD = re.compile(r'\bmvnw?\b|actions/setup-java', re.I)
MAX_WORKFLOWS = 10   # probe at most this many workflow files per repo
DECISIVE = {'SUCCESS', 'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT',
            'ACTION_REQUIRED'}


def build_status(f):
    f['build'] = 'NONE'
    f['build_url'] = ''
    f.pop('build_workflow', None)
    f['build_checked'] = now_iso()
    if f.get('state') == 'gone':
        f['build'] = 'NONE'
        return f
    full = f.get('current_full_name') or f['repo']
    st, meta = gh(f"repos/{full}")
    if st != 'ok':
        f['build'] = 'NONE'
        return f
    branch = meta.get('default_branch', 'main')

    st, wfs = gh(f"repos/{full}/actions/workflows?per_page=50")
    if st != 'ok' or not wfs.get('workflows'):
        return f
    maven_wfs = []
    for wf in wfs['workflows'][:MAX_WORKFLOWS]:
        path = wf.get('path', '')
        # dynamic/... workflows (Dependabot updates, pages) have no file
        if not path.startswith('.github/workflows/'):
            continue
        s, content = gh(f"repos/{full}/contents/{path}", raw=True)
        if s == 'ok' and content and MAVEN_CMD.search(content):
            maven_wfs.append(wf)

    # latest completed default-branch run per Maven workflow
    latest = []
    for wf in maven_wfs:
        s, runs = gh(f"repos/{full}/actions/workflows/{wf['id']}/runs"
                     f"?branch={branch}&status=completed&per_page=1")
        if s != 'ok' or not runs.get('workflow_runs'):
            continue
        latest.append(runs['workflow_runs'][0])
    if not latest:
        return f

    def concl(r):
        return (r.get('conclusion') or 'UNKNOWN').upper()

    # Only decisive outcomes determine (dis)agreement — a CANCELLED or
    # SKIPPED run neither confirms nor contradicts a green build.
    decisive = [r for r in latest if concl(r) in DECISIVE]
    pool = decisive or latest
    conclusions = {concl(r) for r in pool}
    if len(conclusions) == 1:
        # one Maven workflow, or several that agree — the statement holds
        # whichever of them is the M4-relevant one.
        best = max(pool, key=lambda r: r.get('created_at', ''))
        f['build'] = conclusions.pop()
        f['build_url'] = best.get('html_url', '')
        f['build_workflow'] = best.get('name', '')
        if len(pool) > 1:
            f['build_workflow'] = f"{len(pool)} Maven workflows, all agree"
    else:
        # several Maven workflows with differing decisive results — we
        # cannot tell which one is the Maven-4-relevant build. Say so and
        # link to the repo's Actions view instead of guessing.
        f['build'] = 'AMBIGUOUS'
        f['build_url'] = f"https://github.com/{full}/actions"
        counts = Counter(concl(r) for r in latest)
        f['build_workflow'] = (f"{len(latest)} Maven workflows: "
                               + ", ".join(f"{v} {k}"
                                           for k, v in counts.most_common()))
    return f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('registry')
    ap.add_argument('--max-checks', type=int, default=0,
                    help='refresh only the N stalest entries (0 = all)')
    args = ap.parse_args()

    reg = load_registry(args.registry)
    entries = reg['repos']
    todo = [e for e in entries if e.get('state') != 'gone']
    todo.sort(key=lambda e: e.get('build_checked') or '')
    if args.max_checks > 0:
        todo = todo[:args.max_checks]
    print(f"Build status for {len(todo)} of {len(entries)} entries "
          f"(Maven-invoking workflows, default branch, completed)...",
          file=sys.stderr)
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, _ in enumerate(ex.map(build_status, todo), 1):
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}", file=sys.stderr)
    for e in entries:
        e.setdefault('build', 'NONE')
        e.setdefault('build_url', '')

    save_registry(args.registry, reg)
    confirmed = [e for e in entries if e.get('live_signal')]
    print("\n=== Last Build among confirmed adopters ===")
    for k, v in Counter(e['build'] for e in confirmed).most_common():
        print(f"  {v:4d}  {k}")


if __name__ == '__main__':
    main()
