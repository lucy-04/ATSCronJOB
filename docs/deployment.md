# Deployment (Phase 3)

The poller runs hourly via GitHub Actions (`.github/workflows/poll.yml`) and keeps
its dedup state (`state.db`) on an orphan `state` branch — never on `main`.

## One-time setup

1. **Allow the workflow to push.** GitHub → repo Settings → Actions → General →
   Workflow permissions → select **Read and write permissions** → Save.

2. **Bootstrap the orphan `state` branch** (holds only `state.db`, no shared
   history with `main`):

   ```bash
   git checkout --orphan state
   git rm -rf .
   printf 'state.db-wal\nstate.db-shm\n' > .gitignore   # never track WAL side files
   git add .gitignore
   git commit -m "Initialize state branch"
   git push -u origin state
   git checkout main
   ```

3. **Trigger the first run manually** to confirm it works: GitHub → Actions →
   "Poll ATS boards" → **Run workflow**. The first run seeds every source silently
   (0 new) and writes the first `state.db` to the `state` branch.

## How it works

Each run: checks out `main` (code) and the `state` branch (prior `state.db`) side
by side, runs `STATE_DB_PATH=state-data/state.db npm start`, then amends the single
state commit and force-pushes it. New roles are logged to the Actions run log
(a Telegram notifier is Phase 4). Runs never overlap (a `concurrency` group), and
the `state` branch stays one commit forever (`commit --amend` + `--force-with-lease`).

## Schedule

Hourly (`cron: '0 * * * *'`, UTC). GitHub may delay scheduled runs under load, and
disables scheduled workflows after 60 days of repo inactivity — push or run
manually to re-enable. Adjust cadence by editing the `cron` line.

## Title-search (Adzuna) setup

Query sources in `sources.json` (`"kind": "query"`) search across all companies
via Adzuna and need a free API key:

1. Sign up at https://developer.adzuna.com/ and create an app to get an
   **App ID** and **App Key**.
2. Add both as GitHub repo secrets: Settings → Secrets and variables → Actions →
   New repository secret → `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`.
3. For local runs, export them in your shell before `npm start`:
   ```bash
   export ADZUNA_APP_ID=... ADZUNA_APP_KEY=...
   npm start
   ```

Without the keys, query sources log a per-source error and are skipped; company
(ATS board) sources still run normally.
