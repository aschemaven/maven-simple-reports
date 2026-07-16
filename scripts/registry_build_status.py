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
"""Re-examine the Last Build status for each alive repo in the registry.

This is the build-status step of the registry re-examination (Job B).
"Last Build" means: the most recent COMPLETED run, on the DEFAULT BRANCH,
of a workflow whose file actually invokes Maven (mvn/mvnw or setup-java).

Why content-based: name matching is wrong in both directions — real Maven
builds are often named just "CI"/"build" (false NONE), while Dependabot's
dynamic "maven in /." update runs match "maven" without being a build.
Dynamic workflows (path dynamic/...) have no file and are skipped, which
excludes Dependabot updaters automatically.

Usage: registry_build_status.py <registry.json> [<registry.json out>]
"""
import json, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from pathlib import Path

IN = Path(sys.argv[1])
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else IN
# A workflow is a Maven workflow if its file invokes mvn/mvnw or sets up Java.
MAVEN_CMD = re.compile(r'\bmvnw?\b|actions/setup-java', re.I)
MAX_WORKFLOWS = 10  # probe at most this many workflow files per repo


def gh(endpoint, raw=False):
    cmd = ['gh', 'api', endpoint]
    if raw:
        cmd += ['-H', 'Accept: application/vnd.github.raw']
    for attempt in range(4):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return 'ok', (r.stdout if raw else json.loads(r.stdout))
        except subprocess.CalledProcessError as e:
            err = e.stderr or ''
            if '404' in err:
                return '404', None
            if '403' in err or '429' in err or 'rate limit' in err.lower():
                import time; time.sleep(15 * (attempt + 1)); continue
            return 'error', None
        except json.JSONDecodeError:
            return 'error', None
    return 'error', None


def build_status(f):
    f['build'] = 'NONE'; f['build_url'] = ''; f.pop('build_workflow', None)
    if f['state'] == 'gone':
        f['build'] = 'none'
        return f
    full = f.get('current_full_name') or f['repo']
    st, meta = gh(f"repos/{full}")
    if st != 'ok':
        f['build'] = 'none'
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

    # Only decisive outcomes determine (dis)agreement — a CANCELLED or
    # SKIPPED run neither confirms nor contradicts a green build.
    DECISIVE = {'SUCCESS', 'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'}
    def concl(r):
        return (r.get('conclusion') or 'UNKNOWN').upper()
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
                               + ", ".join(f"{v} {k}" for k, v in counts.most_common()))
    return f


data = json.loads(IN.read_text())
alive = [f for f in data if f['state'] != 'gone']
print(f"Build status for {len(alive)} alive repos "
      f"(Maven-invoking workflows, default branch, completed)...", file=sys.stderr)
with ThreadPoolExecutor(max_workers=8) as ex:
    for i, _ in enumerate(ex.map(build_status, alive), 1):
        if i % 50 == 0:
            print(f"  {i}/{len(alive)}", file=sys.stderr)
for f in data:
    f.setdefault('build', 'none'); f.setdefault('build_url', '')

OUT.write_text(json.dumps(data, indent=1))
confirmed = [f for f in data if f.get('live_signal')]
print("\n=== Last Build among confirmed adopters (Maven workflows only) ===")
for k, v in Counter(f['build'] for f in confirmed).most_common():
    print(f"  {v:4d}  {k}")
