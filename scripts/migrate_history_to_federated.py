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
"""
One-time migration: rewrite maven4-adoption-history.json from the original
single-forge shape into the federated schema used from Phase 0 onwards.

Legacy entry:
    {"date": "...", "total": N, "signals": {...}, "versions": {...}}

Federated entry:
    {
      "date": "...",
      "by_forge": {"github": {"total": N, "signals": {...}, "versions": {...}}},
      "total": N,
      "signals": {...},
      "versions": {...}
    }

Top-level aggregates mirror by_forge.<forge> while only one forge feeds the
history. Once gitlab and codeberg join, the consolidator will recompute the
top-level totals across all forges.

Entries that already carry by_forge are left untouched, so the script is
idempotent.
"""
import argparse
import json
import sys
from pathlib import Path

DEFAULT_FORGE = 'github'
DEFAULT_PATH = Path(__file__).resolve().parent.parent / 'data' / 'maven4-adoption-history.json'


def is_federated(entry):
    return isinstance(entry, dict) and 'by_forge' in entry


def migrate_entry(entry, forge):
    forge_data = {
        'total': entry['total'],
        'signals': dict(entry.get('signals', {})),
        'versions': dict(entry.get('versions', {})),
    }
    return {
        'date': entry['date'],
        'by_forge': {forge: forge_data},
        'total': forge_data['total'],
        'signals': dict(forge_data['signals']),
        'versions': dict(forge_data['versions']),
    }


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        'path', nargs='?', type=Path, default=DEFAULT_PATH,
        help=f'History file to migrate in place (default: {DEFAULT_PATH})',
    )
    parser.add_argument(
        '--forge', default=DEFAULT_FORGE,
        help=f'Forge name to tag legacy entries with (default: {DEFAULT_FORGE})',
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='Print the migrated history to stdout without writing.',
    )
    args = parser.parse_args()

    if not args.path.exists():
        print(f'No file at {args.path}', file=sys.stderr)
        return 1

    with open(args.path, 'r', encoding='utf-8') as f:
        history = json.load(f)

    migrated = skipped = 0
    new_history = []
    for entry in history:
        if is_federated(entry):
            new_history.append(entry)
            skipped += 1
        else:
            new_history.append(migrate_entry(entry, args.forge))
            migrated += 1

    if args.dry_run:
        json.dump(new_history, sys.stdout, indent=2)
        sys.stdout.write('\n')
        print(f'[dry-run] migrated={migrated} skipped={skipped}', file=sys.stderr)
        return 0

    with open(args.path, 'w', encoding='utf-8') as f:
        json.dump(new_history, f, indent=2)

    print(
        f'Migrated {migrated} entries (skipped {skipped} already-federated). '
        f'Wrote {args.path}',
        file=sys.stderr,
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
