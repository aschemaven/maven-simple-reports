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
"""Append today's registry-derived counts to the adoption time series.

Replaces the old search-sampling data points: the metric is now "repos in
the registry with a confirmed live Maven 4 signal", which is immune to the
code-search rate-limit weather that corrupted earlier samples. At most one
point per day — a rerun on the same date replaces that day's point.

Usage: registry_history.py <registry.json> <history.json>
"""
import json
import sys
from collections import Counter
from pathlib import Path

from registry_lib import load_registry, today

FORGE_NAME = 'github'


def main():
    reg = load_registry(sys.argv[1])
    hist_path = Path(sys.argv[2])
    history = json.loads(hist_path.read_text()) if hist_path.exists() else []

    repos = reg['repos']
    confirmed = [r for r in repos if r.get('live_signal')]
    signals = dict(Counter(r['live_signal'] for r in confirmed))
    versions = dict(Counter(r['live_version'] for r in confirmed
                            if r.get('live_version')))
    runtimes = {k: v for k, v in versions.items() if '(POM model)' not in k}
    pom_models = {'4.1.0': versions.get('4.1.0 (POM model)', 0)}

    forge = {
        'total': len(confirmed),
        'signals': signals,
        'pom_models': pom_models,
        'runtimes': runtimes,
        'versions': versions,
        # registry lifecycle context so the honest denominator is recorded
        'registry': {
            'tracked': len(repos),
            'active': sum(1 for r in repos if r.get('state') == 'active'),
            'archived': sum(1 for r in repos if r.get('state') == 'archived'),
            'gone': sum(1 for r in repos if r.get('state') == 'gone'),
        },
    }
    point = {
        'date': today(),
        'by_forge': {FORGE_NAME: forge},
        # mirrored top-level aggregates (existing schema convention)
        'total': forge['total'],
        'signals': signals,
        'pom_models': pom_models,
        'runtimes': runtimes,
        'versions': versions,
    }

    history = [p for p in history if p.get('date') != point['date']]
    history.append(point)
    history.sort(key=lambda p: p.get('date') or '')
    hist_path.write_text(json.dumps(history, indent=1))
    print(f"History: {len(history)} points, today = {forge['total']} "
          f"confirmed adopters ({len(repos)} tracked)", file=sys.stderr)


if __name__ == '__main__':
    main()
