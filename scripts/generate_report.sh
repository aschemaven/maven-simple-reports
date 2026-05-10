#!/usr/bin/env bash
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

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

mkdir -p "${REPO_ROOT}/public"

# Build the Dependabot dashboard SPA (replaces the previous Python-generated
# dependabot-prs.html — the SPA fetches data live from the GitHub REST API).
echo "Building Dependabot dashboard SPA..."
pushd "${REPO_ROOT}/web" >/dev/null
npm ci
npm run build
popd >/dev/null

DASHBOARD_DEST="${REPO_ROOT}/public/dependabot-prs"
rm -rf "${DASHBOARD_DEST}"
mkdir -p "${DASHBOARD_DEST}"
cp -R "${REPO_ROOT}/web/dist/." "${DASHBOARD_DEST}/"

# Convert any remaining AsciiDoc files (e.g. index.adoc) to HTML.
echo "Converting AsciiDoc files to HTML..."
shopt -s nullglob
for adoc_file in "${REPO_ROOT}/public"/*.adoc; do
    html_file="${adoc_file%.adoc}.html"
    echo "  Converting $(basename "$adoc_file")..."
    asciidoctor -o "$html_file" "$adoc_file"
done

echo "Report generated successfully in ${REPO_ROOT}/public/"
