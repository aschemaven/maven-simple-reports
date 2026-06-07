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

# Versions that do not exist (yet) and should be flagged
SUSPECT_VERSIONS = {'4.0.0'}
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

    if '/commits' in key and '__headers__' not in key:
        # Keep only first commit's date
        if isinstance(data, list) and data:
            date = data[0].get('commit', {}).get('committer', {}).get('date', '')
            return [{'commit': {'committer': {'date': date}}}]

    if '/branches' in key and '__headers__' not in key:
        # Keep only branch names
        if isinstance(data, list):
            return [{'name': b.get('name', '')} for b in data]

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


def _strip_header_response(key, cached_data):
    """Strip header+body responses to only what we need."""
    if cached_data is None:
        return cached_data
    headers = cached_data.get('headers', '')
    body = cached_data.get('body')
    # Only keep Link header lines (for pagination count)
    stripped_headers = '\n'.join(
        line for line in headers.split('\n')
        if line.lower().startswith('link:')
    )
    # For branches body, keep only names; for commits body, discard
    stripped_body = None
    if isinstance(body, list):
        if '/branches' in key:
            stripped_body = [{'name': b.get('name', '')} for b in body]
        else:
            stripped_body = []
    return {'headers': stripped_headers, 'body': stripped_body}


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
    if '__headers__' in key:
        stripped = _strip_header_response(key, data)
    else:
        stripped = _strip_response(key, data)
    _cache[key] = {'data': stripped, 'ts': time.time()}
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

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr or ''
        if '403' in stderr or '429' in stderr or 'rate limit' in stderr.lower():
            print(f"  Rate limited on {endpoint}, waiting 60s...", file=sys.stderr)
            time.sleep(60)
            # Retry once
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, check=True)
                return json.loads(result.stdout)
            except subprocess.CalledProcessError:
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
    if version in SUSPECT_VERSIONS:
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


def extract_version_from_pom(owner, repo, file_path):
    """Fetch a pom.xml and extract Maven 4 version from parent or properties."""
    content = fetch_file_content(owner, repo, file_path)
    if not content:
        return None
    # The POM 4.1.0 namespace itself doesn't carry a Maven version,
    # but we can confirm it uses model 4.1.0
    if 'maven.apache.org/POM/4.1.0' in content:
        return '4.1.0 (POM model)'
    return None


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


def check_maven4_branches(owner, repo):
    """Check for branches with Maven 4-related names."""
    # Fetch branches (limited to 100 - sufficient for pattern matching)
    data = gh_api_call(f'repos/{owner}/{repo}/branches', {'per_page': '100'})
    if not data or not isinstance(data, list):
        return []

    maven4_patterns = re.compile(r'maven[-_]?4|m4|mvn4', re.IGNORECASE)
    maven4_branches = []
    for branch in data:
        name = branch.get('name', '')
        if maven4_patterns.search(name):
            maven4_branches.append(name)
    return maven4_branches


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


def _gh_api_call_with_headers(endpoint, params=None):
    """Call GitHub API with --include to get headers. Returns (headers_str, body_json).
    Results are cached."""
    key = _cache_key(f'__headers__{endpoint}', params)
    cached = cache_get(key)
    if cached is not None:
        return cached.get('headers', ''), cached.get('body')

    cmd = ['gh', 'api', endpoint, '--method', 'GET', '--include']
    if params:
        for k, v in params.items():
            cmd.extend(['-f', f'{k}={v}'])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        # Split headers from body
        output = result.stdout
        body_start = output.find('[')
        if body_start < 0:
            body_start = output.find('{')
        headers = output[:body_start] if body_start >= 0 else output
        body = None
        if body_start >= 0:
            try:
                body = json.loads(output[body_start:])
            except json.JSONDecodeError:
                pass
        cache_put(key, {'headers': headers, 'body': body})
        return headers, body
    except subprocess.CalledProcessError:
        return '', None


def get_repo_activity(owner, repo):
    """Get repository activity stats: latest commit date, commit count, branch count."""
    activity = {
        'last_commit': '',
        'commit_count': 0,
        'branch_count': 0,
    }

    # Get latest commit on default branch
    commits = gh_api_call(f'repos/{owner}/{repo}/commits', {'per_page': '1'})
    if commits and isinstance(commits, list) and len(commits) > 0:
        commit_date = commits[0].get('commit', {}).get('committer', {}).get('date', '')
        if commit_date:
            activity['last_commit'] = commit_date[:10]

    # Get total commit count via Link header pagination
    headers, _ = _gh_api_call_with_headers(
        f'repos/{owner}/{repo}/commits', {'per_page': '1'}
    )
    for line in headers.split('\n'):
        if line.lower().startswith('link:'):
            match = re.search(r'page=(\d+)>;\s*rel="last"', line)
            if match:
                activity['commit_count'] = int(match.group(1))
            break

    # Get branch count via Link header pagination
    headers, body = _gh_api_call_with_headers(
        f'repos/{owner}/{repo}/branches', {'per_page': '1'}
    )
    found_link = False
    for line in headers.split('\n'):
        if line.lower().startswith('link:'):
            match = re.search(r'page=(\d+)>;\s*rel="last"', line)
            if match:
                activity['branch_count'] = int(match.group(1))
            found_link = True
            break
    if not found_link and body and isinstance(body, list):
        activity['branch_count'] = len(body)

    return activity


def collect_adoption_data(exclude_forks=False):
    """Run all searches, deduplicate, enrich, and return adoption data."""
    maven_repos = load_maven_repos()
    print(f"Loaded {len(maven_repos)} Maven component repos to exclude.", file=sys.stderr)

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

    # Enrich each repo with metadata
    results = []
    for full_name, data in sorted(filtered.items()):
        owner, repo_name = full_name.split('/')
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

        # Extract Maven 4 version from all available signals
        versions = []
        if 'wrapper' in data['files']:
            v = extract_version_from_wrapper(owner, repo_name)
            if v:
                versions.append(v)
        if 'action' in data['files']:
            v = extract_version_from_workflow(
                owner, repo_name, data['files']['action']
            )
            if v and v not in versions:
                versions.append(v)
        if 'pom' in data['files']:
            v = extract_version_from_pom(
                owner, repo_name, data['files']['pom']
            )
            if v and v not in versions:
                versions.append(v)
        version = ', '.join(versions) if versions else ''

        # Get last workflow run
        build_status, build_url = get_last_workflow_run(owner, repo_name)

        # Check for Maven 4 branches
        maven4_branches = check_maven4_branches(owner, repo_name)

        branch_info = meta.get('default_branch', 'main')
        if maven4_branches:
            branch_info += f" + {', '.join(maven4_branches)}"

        # Run plausibility checks
        warnings = run_plausibility_checks(
            owner, repo_name, data['signals'], data['files']
        )

        # Get repository activity stats
        activity = get_repo_activity(owner, repo_name)

        results.append({
            'repository': full_name,
            'description': meta.get('description', ''),
            'stars': meta.get('stars', 0),
            'signals': ', '.join(sorted(data['signals'])),
            'maven4_version': version or '',
            'branch': branch_info,
            'build_status': build_status,
            'build_url': build_url,
            'language': meta.get('language', ''),
            'updated': meta.get('updated_at', ''),
            'url': f'https://github.com/{full_name}',
            'fork': meta.get('fork', False),
            'warnings': warnings,
            'last_commit': activity['last_commit'],
            'commit_count': activity['commit_count'],
            'branch_count': activity['branch_count'],
        })

    # Sort by stars descending
    results.sort(key=lambda x: x['stars'], reverse=True)

    return results


def export_to_csv(results, filename):
    """Export results to CSV."""
    with open(filename, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow([
            'Repository', 'Description', 'Stars', 'Maven 4 Signals',
            'Maven 4 Version', 'Branch', 'Last Build', 'Build URL',
            'Language', 'Updated', 'Last Commit', 'Commits', 'Branches',
            'Warnings', 'URL', 'Fork'
        ])
        for r in results:
            writer.writerow([
                r['repository'], r['description'], r['stars'],
                r['signals'], r['maven4_version'], r['branch'],
                r['build_status'], r['build_url'], r['language'],
                r['updated'], r['last_commit'], r['commit_count'],
                r['branch_count'], '; '.join(r['warnings']),
                r['url'], 'Yes' if r['fork'] else 'No'
            ])
    return filename


def export_to_asciidoc(results, filename):
    """Export results to AsciiDoc report."""
    now = datetime.now().strftime('%a %b %d %H:%M:%S %Z %Y')

    # Compute summary stats
    total = len(results)
    signal_counts = {}
    version_counts = {}
    for r in results:
        for s in r['signals'].split(', '):
            signal_counts[s] = signal_counts.get(s, 0) + 1
        v = r.get('maven4_version', '')
        if v:
            # A repo may list multiple versions; count each
            for ver in v.split(', '):
                ver = ver.strip()
                if ver:
                    version_counts[ver] = version_counts.get(ver, 0) + 1

    with open(filename, 'w', encoding='utf-8') as f:
        f.write('= Maven 4 Adoption Report\n')
        f.write(':toc: left\n\n')
        f.write(f'Generated: {now}\n\n')
        f.write('Projects across GitHub using Maven 4 features.\n')
        f.write('Known Maven component repositories are excluded.\n\n')

        f.write('== Summary\n\n')
        f.write(f'Total projects with Maven 4 signals: *{total}*\n\n')

        if signal_counts:
            f.write('[cols="2,1", options="header"]\n')
            f.write('|===\n')
            f.write('| Signal | Count\n\n')
            for signal, count in sorted(signal_counts.items()):
                f.write(f'| {signal}\n')
                f.write(f'| {count}\n\n')
            f.write('|===\n\n')

        # Filter out POM model version (XML schema, not a Maven version)
        maven_versions = {k: v for k, v in version_counts.items()
                          if '(POM model)' not in k}
        if maven_versions:
            has_suspect = any(v in SUSPECT_VERSIONS for v in maven_versions)
            f.write('.Maven 4 Versions\n')
            f.write('[cols="2,1", options="header"]\n')
            f.write('|===\n')
            f.write('| Version | Count\n\n')
            for ver, count in sorted(maven_versions.items(),
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
        f.write(f'{WARN_ICON} = suspect version (does not exist yet)\n\n')

        f.write('[cols="3,1,2,2,1,1,1,1,2,1", options="header"]\n')
        f.write('|===\n')
        f.write('| Repository | Stars | Signals | Maven 4 Version | Branch ')
        f.write('| Last Commit | Commits | Branches | Last Build | Language\n\n')

        for r in results:
            repo_link = f'https://github.com/{r["repository"]}[{r["repository"]}^]'
            build_text = r['build_status']
            if r['build_url']:
                build_text = f'{r["build_url"]}[{r["build_status"]}^]'
            # Flag suspect versions and escape pipe characters
            version = flag_version_string(r['maven4_version'])
            version = version.replace('|', '{vbar}')
            branch = r['branch'].replace('|', '{vbar}')
            # Add icons to repo name for easy scanning
            has_suspect_version = any(
                v.strip() in SUSPECT_VERSIONS
                for v in r['maven4_version'].split(', ') if v.strip()
            )
            repo_display = repo_link
            if r['warnings']:
                repo_display = f'{STOP_ICON} {repo_link}'
            elif has_suspect_version:
                repo_display = f'{WARN_ICON} {repo_link}'
            commit_count = str(r['commit_count']) if r['commit_count'] else ''
            branch_count = str(r['branch_count']) if r['branch_count'] else ''

            f.write(f'| {repo_display}\n')
            f.write(f'| {r["stars"]}\n')
            f.write(f'| {r["signals"]}\n')
            f.write(f'| {version}\n')
            f.write(f'| {branch}\n')
            f.write(f'| {r["last_commit"]}\n')
            f.write(f'| {commit_count}\n')
            f.write(f'| {branch_count}\n')
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

    # Compute signal and version counts
    signal_counts = {}
    version_counts = {}
    for r in results:
        for s in r['signals'].split(', '):
            signal_counts[s] = signal_counts.get(s, 0) + 1
        v = r.get('maven4_version', '')
        if v:
            for ver in v.split(', '):
                ver = ver.strip()
                if ver:
                    version_counts[ver] = version_counts.get(ver, 0) + 1

    forge_data = {
        'total': len(results),
        'signals': signal_counts,
        'versions': version_counts,
    }
    entry = {
        'date': today,
        'by_forge': {forge: forge_data},
        'total': forge_data['total'],
        'signals': dict(forge_data['signals']),
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
    results = collect_adoption_data(exclude_forks=args.exclude_forks)

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

        print("\nBy Maven 4 version:", file=sys.stderr)
        version_counts = {}
        for r in results:
            v = r.get('maven4_version', '')
            if v:
                for ver in v.split(', '):
                    ver = ver.strip()
                    if ver:
                        version_counts[ver] = version_counts.get(ver, 0) + 1
        if version_counts:
            for ver, count in sorted(version_counts.items(),
                                     key=lambda x: x[1], reverse=True):
                print(f"  {ver}: {count}", file=sys.stderr)
        else:
            print("  (no versions detected)", file=sys.stderr)

        print("\nTop repos by stars:", file=sys.stderr)
        for r in results[:10]:
            print(f"  {r['repository']} ({r['stars']} stars) - {r['signals']}",
                  file=sys.stderr)

    # Append to time series history
    if results and not args.no_history:
        append_history(results)

    # Save cache for next run
    save_cache()
