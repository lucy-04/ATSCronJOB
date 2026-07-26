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

## Role filter (roles.json)

`roles.json` limits which company-board jobs you're notified about, by title:
- `include` — a job's title must contain one of these (word-boundary, case- and
  punctuation-insensitive), e.g. "backend engineer".
- `exclude` — …and none of these (e.g. "manager", "senior").

Empty or missing `roles.json` = no filtering (every job notifies). Query
(Adzuna) sources are not filtered — they're already scoped by their query.

`sources.json` company tokens are Greenhouse board slugs, verified against the
public board API at seed time. If a company later 404s in the run log
(`! <Company> failed: … 404 …`), its slug changed or it moved ATS — fix the
token or remove the entry.

## Supported ATSes

- **Greenhouse** — `"ats":"greenhouse"`, `token` = board slug (`boards-api.greenhouse.io/v1/boards/{token}/jobs`).
- **Ashby** — `"ats":"ashby"`, `token` = job-board slug (`api.ashbyhq.com/posting-api/job-board/{token}`). This is where many AI-first companies post (OpenAI, Cohere, Notion, Ramp, Perplexity, …).
- **Lever** — `"ats":"lever"`, `token` = postings slug (`api.lever.co/v0/postings/{token}?mode=json`). Public, key-less; returns a bare array of postings.
- **SmartRecruiters** — `"ats":"smartrecruiters"`, `token` = the case-sensitive company identifier (`api.smartrecruiters.com/v1/companies/{token}/postings`). Public, key-less; large enterprises (e.g. ServiceNow, Experian). Only the first 100 postings per company are fetched.

All are public, key-less APIs. A wrong/renamed token surfaces on the next run as
`! <Company> failed: … 404 …` without aborting the run — fix or remove the entry.

## Telegram notifications

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both set, the poller sends
new jobs to Telegram instead of printing them; without them it falls back to the
console (local runs, or CI before you add the secrets).

Setup:
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the
   **bot token** it gives you.
2. Start a chat with your new bot and send it any message (a bot cannot message
   you first).
3. Get your **chat id**: open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `result[].message.chat.id` (a number; negative for groups).
4. Add both as GitHub repo secrets (Settings → Secrets and variables → Actions):
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
5. Locally, export the same two env vars before `npm start` to test delivery.

Messages use HTML formatting and are split to stay within Telegram's
4096-character per-message limit when a run finds many new roles.
