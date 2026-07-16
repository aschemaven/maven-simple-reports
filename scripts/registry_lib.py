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
"""Shared helpers for the Maven 4 adoption registry pipeline.

The registry is the durable list of every repo ever seen with a Maven 4
signal. Pipeline stages (discover -> re-examine -> build status -> history
-> render) all read and write the same registry file.

Registry format (schema 1):
    {
      "schema_version": 1,
      "updated": "<iso>",
      "reconciliation": {"date": ..., "missed": N, "found_total": M} | null,
      "repos": [ {repo, state, first_seen, last_seen, last_checked,
                  gone_since, stars, pushed_at, live_signal, live_version,
                  source, build, build_url, ...}, ... ]
    }
A bare JSON list (the pre-pipeline seed) is accepted and wrapped on load.
"""
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REGISTRY_SCHEMA_VERSION = 1

VER_RE = re.compile(r'apache-maven-(4[\w.\-]+)')
POM_RE = re.compile(r'maven\.apache\.org/POM/(\d+\.\d+\.\d+)')


def today():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def clean_version(v):
    v = re.sub(r'-bin(\.zip|\.tar\.gz)?$', '', v)
    v = re.sub(r'\.(zip|tar\.gz)$', '', v)
    return v


def _rate_limit_guard(min_remaining=50):
    """If the core rate limit is nearly exhausted, sleep until it resets.
    Keeps long re-examination runs alive under GITHUB_TOKEN's 1000/h cap
    instead of failing half-way through."""
    try:
        r = subprocess.run(['gh', 'api', 'rate_limit'],
                           capture_output=True, text=True, check=True)
        core = json.loads(r.stdout)['resources']['core']
        if core['remaining'] < min_remaining:
            wait = max(30, core['reset'] - int(time.time()) + 10)
            print(f"  Core rate limit nearly exhausted "
                  f"({core['remaining']} left); sleeping {wait}s until reset...",
                  file=sys.stderr)
            time.sleep(wait)
    except Exception:
        pass  # guard is best-effort


_guard_counter = 0


def gh(endpoint, raw=False, method='GET', params=None):
    """GitHub API via gh CLI. Returns (status, payload) with status one of
    'ok' | '404' | 'error'. Retries rate limits with escalating backoff and
    consults the core-limit guard every 25 calls."""
    global _guard_counter
    _guard_counter += 1
    if _guard_counter % 25 == 0:
        _rate_limit_guard()

    cmd = ['gh', 'api', '-X', method, endpoint]
    if raw:
        cmd += ['-H', 'Accept: application/vnd.github.raw']
    if params:
        for k, v in params.items():
            cmd += ['-f', f'{k}={v}']
    for attempt in range(4):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return 'ok', (r.stdout if raw else json.loads(r.stdout))
        except subprocess.CalledProcessError as e:
            err = e.stderr or ''
            if '404' in err:
                return '404', None
            if '403' in err or '429' in err or 'rate limit' in err.lower():
                if attempt == 3:
                    break
                wait = 30 + 60 * (attempt + 1)
                print(f"  Rate limited on {endpoint}, waiting {wait}s "
                      f"(attempt {attempt + 1}/3)...", file=sys.stderr)
                time.sleep(wait)
                continue
            return 'error', err.strip()[:120]
        except json.JSONDecodeError:
            return 'error', 'jsondecode'
    return 'error', 'rate-limit-giveup'


def load_registry(path):
    """Load the registry, wrapping a legacy bare list into schema 1."""
    path = Path(path)
    if not path.exists():
        return {'schema_version': REGISTRY_SCHEMA_VERSION, 'updated': None,
                'reconciliation': None, 'repos': []}
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return {'schema_version': REGISTRY_SCHEMA_VERSION, 'updated': None,
                'reconciliation': None, 'repos': data}
    return data


def save_registry(path, reg):
    reg['schema_version'] = REGISTRY_SCHEMA_VERSION
    reg['updated'] = now_iso()
    Path(path).write_text(json.dumps(reg, indent=1))


def by_name(reg):
    """Index repos by (lower-cased) name."""
    return {r['repo'].lower(): r for r in reg['repos']}


def load_excluded(yaml_path=None):
    """Known Maven component repo names from .gh-configuration.yaml.
    These are Maven's own components — tooling, not adopters."""
    if yaml_path is None:
        yaml_path = Path(__file__).resolve().parent.parent / '.gh-configuration.yaml'
    yaml_path = Path(yaml_path)
    if not yaml_path.exists():
        print(f"Warning: {yaml_path} not found, no exclusions applied.",
              file=sys.stderr)
        return set()
    repos = set()
    for line in yaml_path.read_text().splitlines():
        line = line.strip()
        if line.startswith('- '):
            name = line[2:].strip()
            if name and not name.startswith('#'):
                repos.add(name)
    return repos


def is_excluded(full_name, excluded):
    """True for Maven's own component repos (apache org only)."""
    owner, _, repo = full_name.partition('/')
    return owner == 'apache' and repo in excluded
