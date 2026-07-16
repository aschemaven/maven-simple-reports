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
"""Print a one-line substantive-change summary between two registry files.

"Substantive" means new/removed repos or a changed state / live_signal /
live_version / build — NOT the last_checked/build_checked timestamps that
change on every run. The registry workflow puts this line into the data
branch commit message, so `git log data` doubles as the cadence-value
metric: if most runs say "no substantive changes", the schedule can be
thinned out.

Usage: registry_delta.py <old_registry.json> <new_registry.json>
"""
import sys
from pathlib import Path

from registry_lib import load_registry

SUBSTANTIVE = ['state', 'live_signal', 'live_version', 'build']


def norm(field, value):
    if field == 'build':
        return (value or '').upper()
    return value


def main():
    old_path, new_path = Path(sys.argv[1]), Path(sys.argv[2])
    if not old_path.exists():
        print("initial registry")
        return
    old = {r['repo']: r for r in load_registry(old_path)['repos']}
    new = {r['repo']: r for r in load_registry(new_path)['repos']}

    added = [k for k in new if k not in old]
    removed = [k for k in old if k not in new]
    changed = {f: 0 for f in SUBSTANTIVE}
    for k, r in new.items():
        o = old.get(k)
        if o is None:
            continue
        for f in SUBSTANTIVE:
            if norm(f, o.get(f)) != norm(f, r.get(f)):
                changed[f] += 1

    parts = []
    if added:
        parts.append(f"+{len(added)} new")
    if removed:
        parts.append(f"-{len(removed)} removed")
    parts += [f"{n} {f}" for f, n in changed.items() if n]
    print(", ".join(parts) if parts else "no substantive changes")


if __name__ == '__main__':
    main()
