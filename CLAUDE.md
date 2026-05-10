# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **supporting project** (not an MCP server) that publishes reports and statistics about Apache Maven repository pull requests. The primary purpose is to track the status of open PRs across ~93 Apache Maven repositories, with focus on Dependabot PRs and their CI/CD build statuses.

**Key outputs:**
- A static **single-page dashboard** (`web/`) that calls the GitHub REST API directly from the browser to show open Dependabot PRs with live build status. This replaces the previous Python-generated `dependabot-prs.html`.
- A **Python CSV/AsciiDoc exporter** (`scripts/export_maven_prs.py`), retained for ad-hoc local exports.
- Reports published to GitHub Pages (main) and Netlify (PRs/branches) on push.

## Commands

### Generate the published site locally

```bash
scripts/generate_report.sh
```
This builds the SPA (`cd web && npm ci && npm run build`), copies `web/dist/` into `public/dependabot-prs/`, and converts the remaining static AsciiDoc files (e.g. `index.adoc`) to HTML.

### Develop the SPA

```bash
cd web
npm install
npm run dev          # http://localhost:5173/maven-simple-reports/dependabot-prs/
npm run build        # production build into web/dist/
npm run typecheck    # tsc -b --noEmit
```

See `web/README.adoc` for architecture, rate-limit handling, and roadmap.

### Ad-hoc Python exports

```bash
# CSV of all open Maven PRs
scripts/export_maven_prs.py

# Dependabot only, AsciiDoc
scripts/export_maven_prs.py --format asciidoc --dependabot

# Filter by author
scripts/export_maven_prs.py --author "someuser"
```

### Testing the workflow

The GitHub Actions workflow runs on push, PR, and manual dispatch (Actions → Publish Reports → Run workflow). The previous hourly cron schedule has been removed — the SPA polls itself in the browser.

## Requirements

- **Node.js 20+** and npm (for the SPA build)
- **Ruby** and the `asciidoctor` gem (for AsciiDoc → HTML conversion)
  ```bash
  gem install asciidoctor
  ```
- **Python 3** and **GitHub CLI (`gh`)** — only needed for the legacy `export_maven_prs.py` exporter

## Project Architecture

### Pipeline

1. **`web/`** — Vite + React + TypeScript SPA. Calls `api.github.com` directly with ETag/`If-None-Match` caching, serial request scheduling, and 403/429 backoff. Output: `web/dist/`.
2. **`scripts/generate_report.sh`** — orchestrator. Builds the SPA, copies it into `public/dependabot-prs/`, then runs `asciidoctor` on remaining `.adoc` files.
3. **`scripts/export_maven_prs.py`** — legacy Python exporter (CSV/AsciiDoc) using `gh` CLI. No longer invoked by CI but kept for local use.
4. **`.github/workflows/publish-reports.yml`** — runs `generate_report.sh`, publishes `public/` to GitHub Pages (main) or Netlify (PRs/branches).

### Directory layout

- `web/` — SPA source (Vite + React + TS); `web/dist/` is generated
- `scripts/` — Python and shell scripts
- `public/` — published site root; only `index.adoc` is git-tracked (the rest is generated)
- `.github/workflows/` — CI/CD

## Build status detection (SPA)

The SPA derives a per-PR `BuildState` from `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`:

- Any failed/timed-out/cancelled run → `FAILURE`
- Otherwise any queued/in-progress run → `PENDING`
- Otherwise any successful/neutral/skipped run → `SUCCESS`
- Empty or all-other → `UNKNOWN`

Legacy commit statuses (`/commits/{sha}/status`) and merge-conflict detection (`/pulls/{n}.mergeable`) are not consulted yet. See `web/README.adoc` _Known limitations_.

## Integration with Parent Project

Supporting project under the `maven-mcps` umbrella. See `../CLAUDE.md` for overall project structure. Unlike `mail-mcp/`, this is **not** an MCP server.
