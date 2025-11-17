# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **supporting project** (not an MCP server) that generates reports and statistics about Apache Maven repository pull requests. The primary purpose is to track the status of open PRs across ~62 Apache Maven repositories, with special focus on DependaBot PRs and their CI/CD build statuses.

**Key outputs:**
- CSV and AsciiDoc reports of open PRs with build status information
- Automated hourly reports published to GitHub Pages and Netlify
- Reports include PR metadata, CI/CD status, and links to GitHub checks

## Commands

### Generate Reports

**Full report generation (recommended):**
```bash
scripts/generate_report.sh
```
This runs the Python export script and converts all AsciiDoc files in `public/` to HTML.

**Export PR data directly:**
```bash
# Export all open PRs to CSV
scripts/export_maven_prs.py

# Export DependaBot PRs to AsciiDoc
scripts/export_maven_prs.py --format asciidoc --dependabot

# Custom output path
scripts/export_maven_prs.py --format csv --output /path/to/file.csv

# Filter by author
scripts/export_maven_prs.py --author "someuser"
```

**Convert AsciiDoc to HTML manually:**
```bash
asciidoctor -o public/output.html public/input.adoc
```

### Testing Changes

The GitHub Actions workflow can be triggered manually:
- Via GitHub UI: Actions → Publish Reports → Run workflow
- The workflow also runs automatically on push, PR, and hourly schedule

## Requirements

- **Python 3** (uses standard library only: subprocess, json, csv, datetime, pathlib, re, argparse)
- **GitHub CLI (`gh`)** installed and authenticated
  - Authenticate: `gh auth login` or set `GH_TOKEN`/`GITHUB_TOKEN` environment variable
  - Script uses `gh` to fetch PR data from GitHub API
- **Ruby** and **asciidoctor** gem (for AsciiDoc to HTML conversion)
  ```bash
  gem install asciidoctor
  ```

## Project Architecture

### Script Pipeline

1. **export_maven_prs.py** (Python):
   - Fetches open PRs from ~62 Apache Maven repositories using `gh` CLI
   - Extracts CI/CD build status from GitHub checks API
   - Generates CSV or AsciiDoc output in `public/` directory
   - Repository list is hardcoded in script (sourced from `.jqassistant-github.yml`)

2. **generate_report.sh** (Bash):
   - Orchestrates the full report generation
   - Calls `export_maven_prs.py` for DependaBot report
   - Converts all `.adoc` files in `public/` to `.html` using asciidoctor

3. **GitHub Actions Workflow** (`.github/workflows/publish-reports.yml`):
   - Runs hourly via cron schedule
   - Also runs on push, PR, and manual dispatch
   - Publishes to GitHub Pages (main branch) or Netlify (PRs/branches)
   - Sets up Python, Ruby, asciidoctor, and GitHub CLI

### Directory Structure

- `scripts/` - Python and shell scripts for report generation
- `public/` - Output directory for generated reports (AsciiDoc and HTML)
  - `.gitignore`'d generated files, but committed static files (like `index.adoc`)
- `.github/workflows/` - GitHub Actions automation

## Build Status Detection

The script determines overall PR build status by:
1. Fetching all CI/CD checks for the PR's HEAD commit using `gh pr checks`
2. Aggregating results from GitHub Actions, Jenkins, and other CI systems
3. Classifying as SUCCESS, FAILURE, PENDING, or UNKNOWN
4. Providing links to GitHub's PR checks page for detailed status

## Integration with Parent Project

This is a supporting project under the `maven-mcps` umbrella. See `../CLAUDE.md` for the overall project structure. Unlike `mail-mcp/`, this is **not an MCP server** but provides analysis tools for Maven development tracking.