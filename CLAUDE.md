# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **supporting project** (not an MCP server) that publishes reports and statistics about Apache Maven repository pull requests. The primary purpose is to track the status of open PRs across ~93 Apache Maven repositories, with focus on Dependabot PRs and their CI/CD build statuses.

**Key outputs:**
- A static **single-page dashboard** (`web/`) that calls the GitHub REST API directly from the browser to show open Dependabot PRs with live build status. This replaces the previous Python-generated `dependabot-prs.html`.
- Reports published to GitHub Pages (main) and Netlify (PRs/branches) on push.

Further Python-based reports may live under `scripts/` in the future.

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

### Testing the workflow

The GitHub Actions workflow runs on push, PR, and manual dispatch (Actions → Publish Reports → Run workflow). The previous hourly cron schedule has been removed — the SPA polls itself in the browser.

## Requirements

- **Node.js 20+** and npm (for the SPA build)
- **Ruby** and the `asciidoctor` gem (for AsciiDoc → HTML conversion)
  ```bash
  gem install asciidoctor
  ```
- **Python 3** and **GitHub CLI (`gh`)** — required by future Python-based report scripts under `scripts/`

## Project Architecture

### Pipeline

1. **`web/`** — Vite + React + TypeScript SPA. Calls `api.github.com` directly with ETag/`If-None-Match` caching, serial request scheduling, and 403/429 backoff. Output: `web/dist/`.
2. **`netlify/functions/`** — three TypeScript Netlify Functions (`auth-callback`, `token-exchange`, `token-refresh`) hosting the OAuth Authorization Code + PKCE flow against a registered GitHub App. They never touch dashboard data, only token exchange / refresh.
3. **`scripts/generate_report.sh`** — orchestrator. Builds the SPA, copies it into `public/dependabot-prs/`, then runs `asciidoctor` on remaining `.adoc` files.
4. **`.github/workflows/publish-reports.yml`** — runs `generate_report.sh`, publishes `public/` to GitHub Pages (main) or Netlify (PRs/branches), and uploads `netlify/functions/` alongside Netlify deploys.

### Directory layout

- `web/` — SPA source (Vite + React + TS); `web/dist/` is generated
- `netlify/functions/` — OAuth token-exchange Functions (`.mts`, ESM)
- `netlify.toml` — Functions bundler config (no SPA build step here; the workflow runs `generate_report.sh`)
- `scripts/` — Python and shell scripts
- `public/` — published site root; only `index.adoc` is git-tracked (the rest is generated)
- `.github/workflows/` — CI/CD

### OAuth flow (browser ↔ Netlify Functions ↔ GitHub)

The full setup is documented in `web/README.adoc` (sections _Status_, _UI controls_, _Configuration_). High-level summary:

1. SPA generates PKCE `code_verifier`/`code_challenge` + a CSRF token + a base64-encoded `state = {origin, csrf}`, redirects to `github.com/login/oauth/authorize`.
2. GitHub redirects to the single registered callback URL `https://<netlify-site>/.netlify/functions/auth-callback`. That function decodes `state.origin`, validates it against the allowlist in `netlify/functions/_lib/cors.mts`, and 302s the browser back to the SPA at its own origin with `code` + `state` in the query string.
3. SPA on its origin verifies the CSRF token, POSTs `{code, code_verifier, redirect_uri}` to `/token-exchange`, which calls GitHub with the server-side `client_secret` added and returns the access + refresh tokens.
4. Access tokens (~8 h) are refreshed transparently via `/token-refresh` before each fetch when their remaining lifetime is < 60 s.

## Build status detection (SPA)

The SPA derives a per-PR `BuildState` from `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`:

- Any failed/timed-out/cancelled run → `FAILURE`
- Otherwise any queued/in-progress run → `PENDING`
- Otherwise any successful/neutral/skipped run → `SUCCESS`
- Empty or all-other → `UNKNOWN`

Legacy commit statuses (`/commits/{sha}/status`) and merge-conflict detection (`/pulls/{n}.mergeable`) are not consulted yet. See `web/README.adoc` _Known limitations_.

## Integration with Parent Project

Supporting project under the `maven-mcps` umbrella. See `../CLAUDE.md` for overall project structure. Unlike `mail-mcp/`, this is **not** an MCP server.
