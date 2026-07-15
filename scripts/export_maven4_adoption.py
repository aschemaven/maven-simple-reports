#!/usr/bin/env python3
#
# Copyright 2025 The Apache Software Foundation
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
"""
Export Maven 4 adoption data from GitHub repositories (excluding known Maven components).

Searches all of GitHub for Maven 4 usage, including Apache projects that are not
Maven components themselves. Known Maven component repos (from .gh-configuration.yaml)
are excluded.

Detects three signals:
- POM model version 4.1.0
- Maven 4 wrapper (distributionUrl referencing apache-maven-4)
- GitHub Actions installing/using Maven 4
"""
import subprocess
import json
import csv
import sys
import argparse
import re
import time
from datetime import datetime
from pathlib import Path

# Path to the YAML config listing known Maven component repos
YAML_PATH = Path(__file__).resolve().parent.parent / '.gh-configuration.yaml'

# Default cache file location (stored via actions/cache in CI)
CACHE_PATH = Path(__file__).resolve().parent.parent / 'cache' / 'gh_api_cache.json'

# Time series history file (committed to repo)
HISTORY_PATH = Path(__file__).resolve().parent.parent / 'data' / 'maven4-adoption-history.json'

# Per-repo snapshot of the previous run's enriched results. Used to skip
# enrichment for repos whose discovery signature (signals + file paths)
# hasn't changed since the snapshot was taken. Lives alongside the history
# file on the data branch; see scan-maven4 in publish.yml for restore/push.
SNAPSHOT_PATH = Path(__file__).resolve().parent.parent / 'data' / 'maven4-repos-snapshot.json'
SNAPSHOT_SCHEMA_VERSION = 1

# Forge attribution for the federated history schema. Today only the GitHub
# runner writes here, so each snapshot carries by_forge.github plus mirrored
# top-level aggregates. Going multi-forge would mean parameterising this and
# adding a per-forge API layer; the architecture for that is being worked
# out separately — see README.adoc "Multi-forge expansion".
FORGE_NAME = 'github'

# Cache TTL in seconds (24 hours)
CACHE_TTL = 86400

# Rate limit: GitHub code search allows 10 requests/minute
CODE_SEARCH_DELAY = 7  # seconds between code search API calls

# A 4.0.x runtime version without a pre-release qualifier
# (-alpha-, -beta-, -rc-) is suspect \u2014 Maven 4 has not GA'd yet,
# so any bare 4.0.0 / 4.0.1 / 4.0.2 / 4.0.3 ... is almost certainly
# a misconfigured wrapper.
SUSPECT_VERSION_RE = re.compile(r'^4\.0\.\d+$')
WARN_ICON = '\u26a0\ufe0f'  # warning sign emoji
STOP_ICON = '\U0001f6d1'   # stop sign (red octagon)
CHECK_ICON = '\u2705'       # green check mark
CROSS_ICON = '\u274c'       # red cross mark


# Global cache state
_cache = {}
_cache_enabled = True
_cache_path = CACHE_PATH
_cache_dirty = False


def _cache_key(endpoint, params=None):
    """Create a deterministic cache key from endpoint and params."""
    key = endpoint
    if params:
        sorted_params = '&'.join(f'{k}={v}' for k, v in sorted(params.items()))
        key = f'{endpoint}?{sorted_params}'
    return key


def load_cache():
    """Load cache from disk."""
    global _cache
    if not _cache_enabled:
        return
    if _cache_path.exists():
        try:
            with open(_cache_path, 'r', encoding='utf-8') as f:
                _cache = json.load(f)
            print(f"Loaded {len(_cache)} cached API responses.", file=sys.stderr)
        except (json.JSONDecodeError, OSError) as e:
            print(f"Warning: could not load cache: {e}", file=sys.stderr)
            _cache = {}
    else:
        _cache = {}


def save_cache():
    """Save cache to disk (only if modified)."""
    global _cache_dirty
    if not _cache_enabled or not _cache_dirty:
        return
    _cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(_cache_path, 'w', encoding='utf-8') as f:
        json.dump(_cache, f, separators=(',', ':'))
    print(f"Saved {len(_cache)} cached API responses.", file=sys.stderr)
    _cache_dirty = False


def _strip_response(key, data):
    """Strip API response to only the fields we use, to minimize cache size."""
    if data is None:
        return data

    if 'search/code' in key:
        # Keep total_count and only full_name + path from items
        if isinstance(data, dict) and 'items' in data:
            return {
                'total_count': data.get('total_count', 0),
                'incomplete_results': data.get('incomplete_results', False),
                'items': [
                    {
                        'repository': {'full_name': item.get('repository', {}).get('full_name', '')},
                        'path': item.get('path', ''),
                    }
                    for item in data.get('items', [])
                ],
            }

    if '/contents/' in key:
        # Keep only content and encoding (for base64 decode)
        if isinstance(data, dict) and 'content' in data:
            return {'content': data['content'], 'encoding': data.get('encoding', 'base64')}
        # File existence check — just preserve non-None
        return {}

    if '/actions/runs' in key:
        # Keep only first run's conclusion, status, html_url
        if isinstance(data, dict) and 'workflow_runs' in data:
            runs = data.get('workflow_runs', [])
            return {
                'total_count': data.get('total_count', 0),
                'workflow_runs': [
                    {
                        'conclusion': r.get('conclusion'),
                        'status': r.get('status'),
                        'html_url': r.get('html_url', ''),
                    }
                    for r in runs[:1]
                ],
            }

    if '/commits' in key:
        # Keep only first commit's date
        if isinstance(data, list) and data:
            date = data[0].get('commit', {}).get('committer', {}).get('date', '')
            return [{'commit': {'committer': {'date': date}}}]

    # Repo metadata — keep only fields we use
    if isinstance(data, dict) and 'stargazers_count' in data:
        return {
            'stargazers_count': data.get('stargazers_count', 0),
            'description': data.get('description', ''),
            'language': data.get('language', ''),
            'default_branch': data.get('default_branch', 'main'),
            'updated_at': data.get('updated_at', ''),
            'fork': data.get('fork', False),
            'archived': data.get('archived', False),
            'topics': data.get('topics', []),
        }

    return data


def cache_get(key):
    """Get a value from cache if it exists and is not expired."""
    if not _cache_enabled or key not in _cache:
        return None
    entry = _cache[key]
    age = time.time() - entry.get('ts', 0)
    if age > CACHE_TTL:
        return None
    return entry.get('data')


def cache_put(key, data):
    """Store a stripped-down value in the cache."""
    global _cache_dirty
    if not _cache_enabled:
        return
    _cache[key] = {'data': _strip_response(key, data), 'ts': time.time()}
    _cache_dirty = True


def load_maven_repos(yaml_path=YAML_PATH):
    """Load the list of known Maven component repo names from .gh-configuration.yaml."""
    if not yaml_path.exists():
        print(f"Warning: {yaml_path} not found, no exclusions applied.", file=sys.stderr)
        return set()

    repos = set()
    with open(yaml_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line.startswith('- '):
                repo_name = line[2:].strip()
                if repo_name and not repo_name.startswith('#'):
                    repos.add(repo_name)
    return repos


def _gh_api_call_raw(endpoint, params=None, method='GET'):
    """Call GitHub API via gh CLI (no caching). Returns parsed JSON or None."""
    cmd = ['gh', 'api', endpoint, '--method', method]
    if params:
        for key, value in params.items():
            cmd.extend(['-f', f'{key}={value}'])

    # Code search shares a stricter secondary rate limit than the core API.
    # A single 60s retry was not enough: the wrapper and GH-Action searches
    # run after the POM search has drained the budget and were left empty on
    # essentially every run, collapsing the 'signals'/'maven_runtime' columns.
    # Retry rate-limit failures several times with escalating backoff.
    max_rate_limit_retries = 3
    attempt = 0
    while True:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
        except subprocess.CalledProcessError as e:
            stderr = e.stderr or ''
            is_rate_limit = ('403' in stderr or '429' in stderr
                             or 'rate limit' in stderr.lower())
            if is_rate_limit and attempt < max_rate_limit_retries:
                attempt += 1
                wait = 30 + 60 * attempt  # 90s, 150s, 210s
                print(f"  Rate limited on {endpoint}, waiting {wait}s "
                      f"(attempt {attempt}/{max_rate_limit_retries})...",
                      file=sys.stderr)
                time.sleep(wait)
                continue
            if is_rate_limit:
                print(f"  Still rate limited on {endpoint} after "
                      f"{max_rate_limit_retries} retries; giving up.",
                      file=sys.stderr)
                return None
            if '404' in stderr:
                # Not found — expected for file existence checks
                return None
            if '422' in stderr:
                # Validation error (e.g., search query issues)
                print(f"  API validation error on {endpoint}: {stderr.strip()}", file=sys.stderr)
                return None
            print(f"  API error on {endpoint}: {stderr.strip()}", file=sys.stderr)
            return None
        except json.JSONDecodeError:
            return None


def gh_api_call(endpoint, params=None, method='GET'):
    """Call GitHub API with caching support."""
    key = _cache_key(endpoint, params)
    cached = cache_get(key)
    if cached is not None:
        return cached

    data = _gh_api_call_raw(endpoint, params, method)
    if data is not None:
        # Don't cache empty code search results — GitHub code search
        # can intermittently return 0 items for valid queries
        if 'search/code' in endpoint and isinstance(data, dict):
            if not data.get('items'):
                return data
        cache_put(key, data)
    return data


def code_search(query, signal_name):
    """Run a GitHub code search with pagination. Returns list of (repo_full_name, file_path) tuples."""
    results = []
    page = 1
    total_count = None

    while True:
        print(f"  Searching '{signal_name}' page {page}...", file=sys.stderr)
        data = gh_api_call('search/code', {
            'q': query,
            'per_page': '100',
            'page': str(page),
        })

        if not data or 'items' not in data:
            break

        if total_count is None:
            total_count = data.get('total_count', 0)
            print(f"  Total matches: {total_count}", file=sys.stderr)

        for item in data['items']:
            repo_name = item.get('repository', {}).get('full_name', '')
            file_path = item.get('path', '')
            results.append((repo_name, file_path))

        # Check if there are more pages
        if len(data['items']) < 100:
            break

        page += 1
        # Rate limit: max 10 code search requests per minute
        time.sleep(CODE_SEARCH_DELAY)

    return results


def search_pom_410():
    """Search for POM model version 4.1.0 across all of GitHub."""
    return code_search(
        '"maven.apache.org/POM/4.1.0" filename:pom.xml',
        'POM 4.1.0'
    )


def search_maven4_wrapper():
    """Search for Maven 4 wrapper properties across all of GitHub."""
    return code_search(
        'filename:maven-wrapper.properties "apache-maven-4"',
        'Maven 4 Wrapper'
    )


def search_maven4_gh_actions():
    """Search for Maven 4 references in GitHub Actions workflows across all of GitHub."""
    return code_search(
        'path:.github/workflows "apache-maven-4"',
        'GH Actions Maven 4'
    )


def version_sort_key(version):
    """Sort key for Maven versions: highest/most stable first.

    Order: GA (4.0.0) > RC > beta > alpha, higher numbers first.
    """
    # Qualifier ranking: higher = more stable
    qualifier_rank = {'': 100, 'rc': 3, 'beta': 2, 'alpha': 1}

    match = re.match(r'([\d.]+)(?:-(alpha|beta|rc)-?(\d+))?', version)
    if not match:
        return (0, 0, 0, 0)

    base = match.group(1)
    qualifier = match.group(2) or ''
    qualifier_num = int(match.group(3)) if match.group(3) else 0

    # Parse base version parts as integers
    base_parts = tuple(int(p) for p in base.split('.'))

    return (base_parts, qualifier_rank.get(qualifier, 0), qualifier_num)


def flag_version(version):
    """Add a warning icon to suspect/non-existent versions."""
    if SUSPECT_VERSION_RE.match(version):
        return f'{version} {WARN_ICON}'
    return version


def flag_version_string(version_string):
    """Flag suspect versions in a comma-separated version string."""
    if not version_string:
        return version_string
    parts = [flag_version(v.strip()) for v in version_string.split(', ')]
    return ', '.join(parts)


def fetch_file_content(owner, repo, file_path):
    """Fetch and decode a file from a GitHub repository."""
    import base64
    data = gh_api_call(f'repos/{owner}/{repo}/contents/{file_path}')
    if not data or 'content' not in data:
        return None
    try:
        return base64.b64decode(data['content']).decode('utf-8')
    except Exception:
        return None


def extract_maven4_version(content):
    """Extract Maven 4 version string from file content."""
    # Match apache-maven-4.x.x[-suffix] and clean up
    match = re.search(r'apache-maven-(4[\w.\-]+)', content)
    if match:
        version = match.group(1)
        # Strip -bin.zip, -bin.tar.gz, -bin suffixes (common in distribution URLs)
        version = re.sub(r'-bin(\.zip|\.tar\.gz)?$', '', version)
        # Strip trailing .zip or .tar.gz
        version = re.sub(r'\.(zip|tar\.gz)$', '', version)
        return version
    return None


def extract_version_from_wrapper(owner, repo):
    """Fetch maven-wrapper.properties and extract Maven 4 version."""
    content = fetch_file_content(
        owner, repo, '.mvn/wrapper/maven-wrapper.properties'
    )
    if not content:
        return None
    return extract_maven4_version(content)


def extract_version_from_workflow(owner, repo, file_path):
    """Fetch a workflow file and extract Maven 4 version."""
    content = fetch_file_content(owner, repo, file_path)
    if not content:
        return None
    return extract_maven4_version(content)


POM_MODEL_RE = re.compile(r'maven\.apache\.org/POM/(\d+\.\d+\.\d+)')


def detect_pom_model(owner, repo, files):
    """Detect the POM model version declared in the project root pom.xml.

    Returns the model version string (e.g. '4.0.0', '4.1.0') or '' if no
    pom.xml could be located or parsed.

    Strategy:
    - If the repo already has a POM 4.1.0 signal, return '4.1.0' (the
      code-search query that produced the signal targets that exact
      namespace; no file fetch needed).
    - Otherwise probe the project root pom.xml. For wrapper-using repos
      the root is the directory containing .mvn/. As a fallback, try
      the repository root.
    """
    if 'pom' in files:
        return '4.1.0'

    candidates = []
    wrapper = files.get('wrapper', '')
    suffix = '.mvn/wrapper/maven-wrapper.properties'
    if wrapper.endswith(suffix):
        project_root = wrapper[:-len(suffix)]
        candidates.append(f'{project_root}pom.xml')
    if 'pom.xml' not in candidates:
        candidates.append('pom.xml')

    for path in candidates:
        content = fetch_file_content(owner, repo, path)
        if not content:
            continue
        match = POM_MODEL_RE.search(content)
        if match:
            return match.group(1)
    return ''


def enrich_repo(owner, repo):
    """Fetch repository metadata."""
    data = gh_api_call(f'repos/{owner}/{repo}')
    if not data:
        return {}
    return {
        'stars': data.get('stargazers_count', 0),
        'description': data.get('description', '') or '',
        'language': data.get('language', '') or '',
        'default_branch': data.get('default_branch', 'main'),
        'updated_at': data.get('updated_at', '')[:10],
        'fork': data.get('fork', False),
        'archived': data.get('archived', False),
        'topics': data.get('topics', []),
    }


def get_last_workflow_run(owner, repo):
    """Get the conclusion of the last workflow run."""
    data = gh_api_call(f'repos/{owner}/{repo}/actions/runs', {
        'per_page': '1',
    })
    if not data or 'workflow_runs' not in data or not data['workflow_runs']:
        return 'UNKNOWN', ''

    run = data['workflow_runs'][0]
    conclusion = (run.get('conclusion') or run.get('status') or 'UNKNOWN').upper()
    run_url = run.get('html_url', '')
    return conclusion, run_url


def check_file_exists(owner, repo, file_path):
    """Check if a file exists in a repository (HEAD request via contents API)."""
    data = gh_api_call(f'repos/{owner}/{repo}/contents/{file_path}')
    return data is not None


def run_plausibility_checks(owner, repo, signals, files):
    """Run plausibility checks and return list of warnings."""
    warnings = []

    # If wrapper signal: check that mvnw script exists relative to wrapper location
    if 'Wrapper' in signals and 'wrapper' in files:
        wrapper_path = files['wrapper']
        # Derive project root from wrapper path:
        # e.g. ".mvn/wrapper/maven-wrapper.properties" -> ""
        # e.g. "subdir/.mvn/wrapper/maven-wrapper.properties" -> "subdir/"
        # e.g. "a/b/.mvn/wrapper/maven-wrapper.properties" -> "a/b/"
        mvn_dir_suffix = '.mvn/wrapper/maven-wrapper.properties'
        if wrapper_path.endswith(mvn_dir_suffix):
            project_root = wrapper_path[:-len(mvn_dir_suffix)]
        else:
            project_root = ''
        mvnw_path = f'{project_root}mvnw' if project_root else 'mvnw'
        has_mvnw = check_file_exists(owner, repo, mvnw_path)
        if not has_mvnw:
            warnings.append('wrapper.properties without mvnw script')

    return warnings


def get_last_commit_date(owner, repo):
    """Return the date of the latest commit on the default branch, or ''."""
    commits = gh_api_call(f'repos/{owner}/{repo}/commits', {'per_page': '1'})
    if commits and isinstance(commits, list) and len(commits) > 0:
        commit_date = commits[0].get('commit', {}).get('committer', {}).get('date', '')
        if commit_date:
            return commit_date[:10]
    return ''


def load_snapshot(snapshot_path=SNAPSHOT_PATH):
    """Load the previous run's per-repo snapshot. Returns a dict keyed by
    full_name -> result entry, or empty dict if the file is missing,
    unreadable, or has an incompatible schema_version."""
    if not snapshot_path.exists():
        print(f"No prior snapshot at {snapshot_path.name}; full enrichment.",
              file=sys.stderr)
        return {}
    try:
        with open(snapshot_path, 'r', encoding='utf-8') as f:
            payload = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"Warning: snapshot unreadable ({e}); falling back to full enrichment.",
              file=sys.stderr)
        return {}
    if payload.get('schema_version') != SNAPSHOT_SCHEMA_VERSION:
        print(f"Snapshot schema mismatch (have {payload.get('schema_version')}, "
              f"want {SNAPSHOT_SCHEMA_VERSION}); falling back to full enrichment.",
              file=sys.stderr)
        return {}
    by_repo = {r['repository']: r for r in payload.get('repos', [])}
    print(f"Loaded {len(by_repo)} entries from snapshot "
          f"(taken {payload.get('snapshot_date', '?')})",
          file=sys.stderr)
    return by_repo


def save_snapshot(results, snapshot_path=SNAPSHOT_PATH):
    """Persist the current run's results so the next run can skip
    re-enrichment for unchanged repos."""
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'schema_version': SNAPSHOT_SCHEMA_VERSION,
        'snapshot_date': datetime.now().strftime('%Y-%m-%d'),
        'total': len(results),
        'repos': results,
    }
    with open(snapshot_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    print(f"Wrote snapshot of {len(results)} repos to {snapshot_path}",
          file=sys.stderr)


def collect_adoption_data(exclude_forks=False, use_snapshot=False):
    """Run all searches, deduplicate, enrich, and return adoption data."""
    maven_repos = load_maven_repos()
    print(f"Loaded {len(maven_repos)} Maven component repos to exclude.", file=sys.stderr)

    snapshot = load_snapshot() if use_snapshot else {}

    # Run the three code searches
    print("\nSearching for Maven 4 adoption signals...", file=sys.stderr)

    pom_results = search_pom_410()
    if not pom_results:
        print("  WARNING: POM 4.1.0 search returned no results (rate limit?)",
              file=sys.stderr)
    time.sleep(CODE_SEARCH_DELAY)

    wrapper_results = search_maven4_wrapper()
    if not wrapper_results:
        print("  WARNING: Wrapper search returned no results (rate limit?)",
              file=sys.stderr)
    time.sleep(CODE_SEARCH_DELAY)

    actions_results = search_maven4_gh_actions()
    if not actions_results:
        print("  WARNING: GH Actions search returned no results (rate limit?)",
              file=sys.stderr)

    # Aggregate by repo, tracking which signals were found and which files
    repos = {}  # key: full_name, value: dict with signals and file paths

    for full_name, file_path in pom_results:
        if full_name not in repos:
            repos[full_name] = {'signals': set(), 'files': {}}
        repos[full_name]['signals'].add('POM 4.1.0')
        repos[full_name]['files']['pom'] = file_path

    for full_name, file_path in wrapper_results:
        if full_name not in repos:
            repos[full_name] = {'signals': set(), 'files': {}}
        repos[full_name]['signals'].add('Wrapper')
        repos[full_name]['files']['wrapper'] = file_path

    for full_name, file_path in actions_results:
        if full_name not in repos:
            repos[full_name] = {'signals': set(), 'files': {}}
        repos[full_name]['signals'].add('GH Action')
        repos[full_name]['files']['action'] = file_path

    print(f"\nFound {len(repos)} unique repos before filtering.", file=sys.stderr)

    # Filter out known Maven component repos (apache/<name> where <name> is in the list)
    filtered = {}
    excluded_count = 0
    for full_name, data in repos.items():
        parts = full_name.split('/')
        if len(parts) != 2:
            continue
        owner, repo_name = parts

        # Exclude known Maven component repos from the apache org
        if owner == 'apache' and repo_name in maven_repos:
            excluded_count += 1
            continue

        filtered[full_name] = data

    print(f"Excluded {excluded_count} Maven component repos.", file=sys.stderr)
    print(f"Remaining: {len(filtered)} repos to enrich.\n", file=sys.stderr)

    # Enrich each repo with metadata. When a snapshot is loaded, the fast
    # path skips the whole enrichment for repos whose discovery signature
    # (signals + file paths) hasn't changed; that turns ~300 API-heavy
    # enrichments per run into ~5-20 for the actual delta.
    results = []
    reused = 0
    re_enriched_signal_change = 0
    fresh = 0
    for full_name, data in sorted(filtered.items()):
        owner, repo_name = full_name.split('/')

        snap_entry = snapshot.get(full_name)
        if snap_entry is not None:
            snap_signals = tuple(sorted(snap_entry.get('_signals_raw') or []))
            snap_files = tuple(sorted((snap_entry.get('_files') or {}).items()))
            cur_signals = tuple(sorted(data['signals']))
            cur_files = tuple(sorted(data['files'].items()))
            if snap_signals == cur_signals and snap_files == cur_files:
                results.append(snap_entry)
                reused += 1
                continue
            re_enriched_signal_change += 1
        else:
            fresh += 1

        print(f"  Enriching {full_name}...", file=sys.stderr)

        meta = enrich_repo(owner, repo_name)

        # Skip archived repos
        if meta.get('archived', False):
            print(f"    Skipping (archived)", file=sys.stderr)
            continue

        # Skip forks if requested
        if exclude_forks and meta.get('fork', False):
            print(f"    Skipping (fork)", file=sys.stderr)
            continue

        # POM model version: known to be 4.1.0 for repos with the POM
        # signal; for the others (wrapper/action only) we actively probe
        # the project root pom.xml so we get a real distribution.
        pom_model = detect_pom_model(owner, repo_name, data['files'])

        # Maven runtime version: extracted from wrapper or workflow.
        # Both may report different versions — keep all of them visible.
        runtime_versions = []
        if 'wrapper' in data['files']:
            v = extract_version_from_wrapper(owner, repo_name)
            if v:
                runtime_versions.append(v)
        if 'action' in data['files']:
            v = extract_version_from_workflow(
                owner, repo_name, data['files']['action']
            )
            if v and v not in runtime_versions:
                runtime_versions.append(v)
        maven_runtime = ', '.join(runtime_versions)

        # Get last workflow run
        build_status, build_url = get_last_workflow_run(owner, repo_name)

        # Run plausibility checks
        warnings = run_plausibility_checks(
            owner, repo_name, data['signals'], data['files']
        )

        results.append({
            'repository': full_name,
            'description': meta.get('description', ''),
            'stars': meta.get('stars', 0),
            'signals': ', '.join(sorted(data['signals'])),
            'pom_model': pom_model,
            'maven_runtime': maven_runtime,
            'branch': meta.get('default_branch', 'main'),
            'build_status': build_status,
            'build_url': build_url,
            'language': meta.get('language', ''),
            'updated': meta.get('updated_at', ''),
            'url': f'https://github.com/{full_name}',
            'fork': meta.get('fork', False),
            'warnings': warnings,
            'last_commit': get_last_commit_date(owner, repo_name),
            # Internal fields for snapshot signature matching on the next
            # run. Underscore prefix marks them as not for human display;
            # CSV/AsciiDoc writers reference fields by name and ignore them.
            '_signals_raw': sorted(data['signals']),
            '_files': data['files'],
        })

    if use_snapshot:
        print(f"\nSnapshot delta: {reused} reused, "
              f"{re_enriched_signal_change} re-enriched (signals/files changed), "
              f"{fresh} new",
              file=sys.stderr)

    # Sort by stars descending
    results.sort(key=lambda x: x['stars'], reverse=True)

    return results


def export_to_csv(results, filename):
    """Export results to CSV."""
    with open(filename, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow([
            'Repository', 'Description', 'Stars', 'Maven 4 Signals',
            'POM Model', 'Maven Runtime', 'Default Branch',
            'Last Build', 'Build URL', 'Language', 'Updated',
            'Last Commit', 'Warnings', 'URL', 'Fork'
        ])
        for r in results:
            writer.writerow([
                r['repository'], r['description'], r['stars'],
                r['signals'], r['pom_model'], r['maven_runtime'],
                r['branch'], r['build_status'], r['build_url'],
                r['language'], r['updated'], r['last_commit'],
                '; '.join(r['warnings']),
                r['url'], 'Yes' if r['fork'] else 'No'
            ])
    return filename


def export_to_asciidoc(results, filename):
    """Export results to AsciiDoc report."""
    now = datetime.now().strftime('%a %b %d %H:%M:%S %Z %Y')

    # Compute summary stats: POM model and Maven runtime are tracked
    # separately because they're orthogonal — a repo can have POM
    # model 4.1.0 in pom.xml but build with a Maven 4.0.0-rc-X runtime.
    total = len(results)
    signal_counts = {}
    pom_model_counts = {}
    runtime_counts = {}
    for r in results:
        for s in r['signals'].split(', '):
            signal_counts[s] = signal_counts.get(s, 0) + 1
        pm = r.get('pom_model', '')
        if pm:
            pom_model_counts[pm] = pom_model_counts.get(pm, 0) + 1
        for ver in r.get('maven_runtime', '').split(', '):
            ver = ver.strip()
            if ver:
                runtime_counts[ver] = runtime_counts.get(ver, 0) + 1

    with open(filename, 'w', encoding='utf-8') as f:
        f.write('= Maven 4 Adoption Report\n')
        f.write(':toc: left\n')
        f.write(':icons: font\n\n')
        f.write(f'Generated: {now}\n\n')
        f.write('Projects across GitHub using Maven 4 features.\n')
        f.write('Known Maven component repositories are excluded.\n\n')

        f.write('NOTE: Detection runs against each repository\'s default branch only. ')
        f.write('Maven 4 work on feature branches is not currently captured.\n\n')

        f.write('== Summary\n\n')
        f.write(f'Total projects with Maven 4 signals: *{total}*\n\n')

        if signal_counts:
            f.write('.Signals\n')
            f.write('[cols="2,1", options="header"]\n')
            f.write('|===\n')
            f.write('| Signal | Count\n\n')
            for signal, count in sorted(signal_counts.items()):
                f.write(f'| {signal}\n')
                f.write(f'| {count}\n\n')
            f.write('|===\n\n')

        f.write('.POM Model Versions\n')
        f.write('The XML schema declared in the project root `pom.xml` (the `xmlns` URL).\n')
        f.write('Independent of which Maven runtime built the project.\n\n')
        detected = sum(pom_model_counts.values())
        undetected = total - detected
        f.write('[cols="2,1", options="header"]\n')
        f.write('|===\n')
        f.write('| Version | Count\n\n')
        for ver, count in sorted(pom_model_counts.items(),
                                 key=lambda x: version_sort_key(x[0]),
                                 reverse=True):
            f.write(f'| {ver}\n')
            f.write(f'| {count}\n\n')
        if undetected:
            f.write('| (not detected)\n')
            f.write(f'| {undetected}\n\n')
        f.write('|===\n\n')
        if undetected:
            f.write(f'_{undetected} repos have no reachable project root `pom.xml` ')
            f.write('(multi-module without an aggregator at the obvious location, ')
            f.write('archived layout, or a non-standard structure)._\n\n')

        if runtime_counts:
            has_suspect = any(SUSPECT_VERSION_RE.match(v) for v in runtime_counts)
            f.write('.Maven Runtime Versions\n')
            f.write('The Maven CLI version pinned in the wrapper or workflow.\n\n')
            f.write('[cols="2,1", options="header"]\n')
            f.write('|===\n')
            f.write('| Version | Count\n\n')
            for ver, count in sorted(runtime_counts.items(),
                                     key=lambda x: version_sort_key(x[0]),
                                     reverse=True):
                f.write(f'| {flag_version(ver)}\n')
                f.write(f'| {count}\n\n')
            f.write('|===\n\n')
            if has_suspect:
                f.write(f'{WARN_ICON} Version does not exist (yet).\n')
                f.write('The wrapper configuration is likely misconfigured.\n\n')

        f.write('== Adoption Details\n\n')
        f.write('Sorted by star count (descending).\n\n')
        f.write(f'{STOP_ICON} = plausibility issue (e.g., wrapper.properties without mvnw script) +\n')
        f.write(f'{WARN_ICON} = suspect runtime version (does not exist yet)\n\n')

        f.write('.Column reference\n')
        f.write('Repository:: GitHub repo (`owner/name`), linked to its GitHub page.\n')
        f.write('Stars:: GitHub star count.\n')
        f.write('Used here as a popularity proxy and as the table sort key.\n')
        f.write('_Not a Maven 4 signal._\n')
        f.write('Signals:: Which of the three Maven 4 detection signals fired for this repo: ')
        f.write('`POM 4.1.0` (a `pom.xml` with the new namespace), ')
        f.write('`Wrapper` (a `maven-wrapper.properties` referencing `apache-maven-4`), ')
        f.write('`GH Action` (a workflow installing Maven 4).\n')
        f.write('POM Model:: XML schema version declared in the project root `pom.xml` ')
        f.write('(`4.0.0` = legacy, `4.1.0` = new). ')
        f.write('Independent of the Maven runtime version. Empty if no root `pom.xml` was reachable.\n')
        f.write('Maven Runtime:: Maven CLI version pinned in the wrapper or workflow ')
        f.write('(e.g., `4.0.0-rc-5`). Multiple values if wrapper and workflow disagree.\n')
        f.write('Default Branch:: The repository\'s default branch — this is the branch ')
        f.write('all detections were run against. _Not a Maven 4 signal._\n')
        f.write('Last Commit:: Date of the most recent commit on the default branch.\n')
        f.write('Lets you tell active projects apart from dormant ones at a glance.\n')
        f.write('_Not a Maven 4 signal._\n')
        f.write('Last Build:: Conclusion of the repo\'s most recent GitHub Actions ')
        f.write('workflow run (any workflow, not necessarily a Maven build). ')
        f.write('Useful as a sanity check that CI is wired up. _Not a Maven 4 signal._\n')
        f.write('Language:: GitHub\'s primary-language detection for the repo. ')
        f.write('_Not a Maven 4 signal._\n\n')

        f.write('[cols="3,1,2,1,2,2,1,2,1", options="header"]\n')
        f.write('|===\n')
        f.write('| Repository | Stars | Signals | POM Model | Maven Runtime ')
        f.write('| Default Branch | Last Commit | Last Build | Language\n\n')

        for r in results:
            repo_link = f'https://github.com/{r["repository"]}[{r["repository"]}^]'
            build_text = r['build_status']
            if r['build_url']:
                build_text = f'{r["build_url"]}[{r["build_status"]}^]'
            pom_model = r['pom_model'].replace('|', '{vbar}')
            runtime = flag_version_string(r['maven_runtime'])
            runtime = runtime.replace('|', '{vbar}')
            branch = r['branch'].replace('|', '{vbar}')
            has_suspect_runtime = any(
                SUSPECT_VERSION_RE.match(v.strip())
                for v in r['maven_runtime'].split(', ') if v.strip()
            )
            repo_display = repo_link
            if r['warnings']:
                repo_display = f'{STOP_ICON} {repo_link}'
            elif has_suspect_runtime:
                repo_display = f'{WARN_ICON} {repo_link}'

            f.write(f'| {repo_display}\n')
            f.write(f'| {r["stars"]}\n')
            f.write(f'| {r["signals"]}\n')
            f.write(f'| {pom_model}\n')
            f.write(f'| {runtime}\n')
            f.write(f'| {branch}\n')
            f.write(f'| {r["last_commit"]}\n')
            f.write(f'| {build_text}\n')
            f.write(f'| {r["language"]}\n\n')

        f.write('|===\n')

    return filename


def append_history(results, history_path=HISTORY_PATH, forge=FORGE_NAME):
    """Append a federated timestamped snapshot to the adoption history file.

    Each snapshot carries per-forge breakdown under by_forge.<forge> plus
    mirrored top-level aggregates so existing readers keep working. While
    only one forge feeds the history the top-level fields equal
    by_forge.<forge>; once additional forges (gitlab, codeberg) ship,
    the consolidator will recompute top-level totals from by_forge.
    """
    today = datetime.now().strftime('%Y-%m-%d')

    # Compute signal, POM model and Maven runtime counts. `versions` is
    # kept as a legacy union (POM model entries tagged "(POM model)") so
    # existing readers of the history schema keep working.
    signal_counts = {}
    pom_model_counts = {}
    runtime_counts = {}
    for r in results:
        for s in r['signals'].split(', '):
            signal_counts[s] = signal_counts.get(s, 0) + 1
        pm = r.get('pom_model', '')
        if pm:
            pom_model_counts[pm] = pom_model_counts.get(pm, 0) + 1
        for ver in r.get('maven_runtime', '').split(', '):
            ver = ver.strip()
            if ver:
                runtime_counts[ver] = runtime_counts.get(ver, 0) + 1

    version_counts = dict(runtime_counts)
    for ver, count in pom_model_counts.items():
        version_counts[f'{ver} (POM model)'] = count

    forge_data = {
        'total': len(results),
        'signals': signal_counts,
        'pom_models': pom_model_counts,
        'runtimes': runtime_counts,
        'versions': version_counts,
    }
    entry = {
        'date': today,
        'by_forge': {forge: forge_data},
        'total': forge_data['total'],
        'signals': dict(forge_data['signals']),
        'pom_models': dict(forge_data['pom_models']),
        'runtimes': dict(forge_data['runtimes']),
        'versions': dict(forge_data['versions']),
    }

    # Load existing history (federated shape after the one-time migration;
    # see scripts/migrate_history_to_federated.py).
    history = []
    if history_path.exists():
        try:
            with open(history_path, 'r', encoding='utf-8') as f:
                history = json.load(f)
        except (json.JSONDecodeError, OSError):
            history = []

    # Replace entry for today if it already exists (idempotent re-runs)
    history = [h for h in history if h.get('date') != today]
    history.append(entry)
    history.sort(key=lambda h: h['date'])

    # Write back
    history_path.parent.mkdir(parents=True, exist_ok=True)
    with open(history_path, 'w', encoding='utf-8') as f:
        json.dump(history, f, indent=2)

    print(f"Updated adoption history ({len(history)} entries) in {history_path}",
          file=sys.stderr)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Export Maven 4 adoption data from GitHub (excluding Maven components)'
    )
    parser.add_argument(
        '--format',
        choices=['csv', 'asciidoc'],
        default='csv',
        help='Output format (default: csv)'
    )
    parser.add_argument(
        '--output', '-o',
        help='Output file path'
    )
    parser.add_argument(
        '--exclude-forks',
        action='store_true',
        help='Exclude forked repositories from results'
    )
    parser.add_argument(
        '--no-cache',
        action='store_true',
        help='Disable API response caching (fresh data from GitHub)'
    )
    parser.add_argument(
        '--cache-file',
        help=f'Cache file path (default: {CACHE_PATH})'
    )
    parser.add_argument(
        '--no-history',
        action='store_true',
        help='Skip appending to the adoption history file (useful for previews)'
    )
    parser.add_argument(
        '--use-snapshot',
        action='store_true',
        help='Reuse enrichment from data/maven4-repos-snapshot.json for repos '
             'whose discovery signature (signals + file paths) is unchanged. '
             'Turns ~300 enrichments into ~5-20; intended for branch/PR previews.'
    )
    parser.add_argument(
        '--no-snapshot-write',
        action='store_true',
        help='Do not overwrite the snapshot file after the run (useful for '
             'previews so they do not steal the snapshot from main).'
    )

    args = parser.parse_args()

    # Configure caching
    if args.no_cache:
        _cache_enabled = False
        print("Caching disabled.", file=sys.stderr)
    else:
        if args.cache_file:
            _cache_path = Path(args.cache_file)
        load_cache()

    # Determine output filename
    if args.output:
        output_file = args.output
    else:
        ext = 'adoc' if args.format == 'asciidoc' else 'csv'
        output_file = f'public/maven4-adoption.{ext}'

    print("Collecting Maven 4 adoption data from GitHub...\n",
          file=sys.stderr)
    results = collect_adoption_data(
        exclude_forks=args.exclude_forks,
        use_snapshot=args.use_snapshot,
    )

    print(f"\n{'=' * 60}", file=sys.stderr)
    print(f"Total repos found: {len(results)}", file=sys.stderr)
    print(f"{'=' * 60}\n", file=sys.stderr)

    if args.format == 'asciidoc':
        filename = export_to_asciidoc(results, output_file)
        print(f"Exported AsciiDoc to: {filename}", file=sys.stderr)
    else:
        filename = export_to_csv(results, output_file)
        print(f"Exported CSV to: {filename}", file=sys.stderr)

    # Print summary
    if results:
        print("\nBy signal:", file=sys.stderr)
        signal_counts = {}
        for r in results:
            for s in r['signals'].split(', '):
                signal_counts[s] = signal_counts.get(s, 0) + 1
        for signal, count in sorted(signal_counts.items(),
                                    key=lambda x: x[1], reverse=True):
            print(f"  {signal}: {count}", file=sys.stderr)

        print("\nBy POM model:", file=sys.stderr)
        pom_model_counts = {}
        for r in results:
            pm = r.get('pom_model', '')
            if pm:
                pom_model_counts[pm] = pom_model_counts.get(pm, 0) + 1
        if pom_model_counts:
            for ver, count in sorted(pom_model_counts.items(),
                                     key=lambda x: x[1], reverse=True):
                print(f"  {ver}: {count}", file=sys.stderr)
        else:
            print("  (no POM model versions detected)", file=sys.stderr)

        print("\nBy Maven runtime:", file=sys.stderr)
        runtime_counts = {}
        for r in results:
            for ver in r.get('maven_runtime', '').split(', '):
                ver = ver.strip()
                if ver:
                    runtime_counts[ver] = runtime_counts.get(ver, 0) + 1
        if runtime_counts:
            for ver, count in sorted(runtime_counts.items(),
                                     key=lambda x: x[1], reverse=True):
                print(f"  {ver}: {count}", file=sys.stderr)
        else:
            print("  (no runtime versions detected)", file=sys.stderr)

        print("\nTop repos by stars:", file=sys.stderr)
        for r in results[:10]:
            print(f"  {r['repository']} ({r['stars']} stars) - {r['signals']}",
                  file=sys.stderr)

    # Append to time series history
    if results and not args.no_history:
        append_history(results)

    # Persist the per-repo snapshot so the next run can fast-path repos
    # whose discovery signature hasn't changed.
    if results and not args.no_snapshot_write:
        save_snapshot(results)

    # Save cache for next run
    save_cache()
