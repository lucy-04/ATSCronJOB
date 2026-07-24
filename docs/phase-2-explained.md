# Phase 2, Explained From Scratch

A plain-language walkthrough of what your codebase does, what Phase 2 added, and
*why* each piece exists. No prior knowledge assumed. Concepts are introduced one
at a time, each building on the last.

---

## 1. What is this project, in one sentence?

It's a robot that checks company job boards on a schedule and tells you when a
**new** job is posted — so you don't have to keep refreshing careers pages.

- **ATS** = *Applicant Tracking System*. It's the software companies use to run
  hiring (Greenhouse, Lever, Ashby, Workday, etc.). When you see a "careers" page,
  an ATS is usually powering it behind the scenes.
- Most ATSes expose a public **API** (a URL that returns the job list as data
  instead of a web page). For Greenhouse it's literally:
  `https://boards-api.greenhouse.io/v1/boards/stripe/jobs` → returns Stripe's jobs
  as JSON.
- Your poller hits those URLs, reads the jobs, and reports the new ones.

**"Poller"** just means: a program that repeatedly *polls* (asks) a source
"anything new?" on a timer. The repo name `ATSCronJOB` hints at the eventual
deployment — a *cron job* is a task that runs automatically on a schedule.

---

## 2. The core problem Phase 2 solves: **deduplication ("dedup")**

Here's the thing that makes this non-trivial.

Every time you call the Greenhouse API, it returns the **entire current list** of
jobs — all ~500 of them. It does *not* give you "just what changed since last
time." There's no such option.

So a naive poller has a fatal flaw:

```
Monday    9am: fetch → 500 jobs → notify you about 500 jobs
Monday    9:05: fetch → 500 jobs → notify you about the SAME 500 jobs again
Monday    9:10: fetch → 500 jobs → notify you about them AGAIN
```

That's useless. You'd get spammed with the same jobs forever, and you'd never be
able to spot the one genuinely new posting in the noise.

**Deduplication** = the poller *remembers* which jobs it has already seen, so it
can subtract them out and show you only what's actually new:

```
Monday  9am:  fetch 500 → all 500 are new-to-me → remember them → (see §4: notify 0)
Tuesday 9am:  fetch 501 → 500 I remember + 1 I don't → notify you about just the 1
```

That "remembering" is the whole job of Phase 2. Everything below is in service of
doing it *correctly*.

---

## 3. Where the memory lives: **SQLite** (`state.db`)

To remember things between runs, the program needs to write them down somewhere
that survives after it exits. We use **SQLite**.

- SQLite is a full SQL database that lives in a **single file** (`state.db`). No
  server to install, no configuration — the whole database is just that file on
  disk. Perfect for a small tool.
- We talk to it through a library called `better-sqlite3`.
- The file is listed in `.gitignore`, so it never gets committed to GitHub — it's
  *local runtime state*, not source code. (In the future Phase 3, it'll be stored
  on a separate git branch so the scheduled cron job can carry state between runs.)

Think of `state.db` as the poller's notebook. Each run, it reads the notebook
("what have I seen?"), does its work, and writes updates back.

### What we store

The core table is `seen_jobs`. Conceptually it's a spreadsheet:

| source            | job_id | first_seen           | last_seen            |
|-------------------|--------|----------------------|----------------------|
| greenhouse:stripe | 12345  | 2026-07-24T09:00:00Z | 2026-07-24T09:00:00Z |
| greenhouse:stripe | 12346  | 2026-07-24T09:00:00Z | 2026-07-25T09:00:00Z |
| greenhouse:airbnb | 12345  | 2026-07-20T09:00:00Z | 2026-07-25T09:00:00Z |

Each row = "I have seen this one job, on this board." The columns:
- **source** — which board (explained in §5, it's the important subtle bit).
- **job_id** — the id the ATS gave that posting.
- **first_seen** — when we first ever noticed it (set once, never changes).
- **last_seen** — the most recent run where it was still on the board (updated
  every run; drives pruning in §6).

---

## 4. "Seed silently": don't flood you on day one

Look again at the first run: on Monday, all 500 jobs are technically "new to me"
because my notebook was empty. If I notified you about every one, your first
experience would be 500 alerts. Useless.

So the rule for a board's **very first run** is: **record everything as seen, but
notify about nothing.** We call this *seeding* — like planting the initial state.
Only jobs that show up on *later* runs are treated as genuinely new and reported.

```
First ever run for Stripe:  fetch 500 → store all 500 → notify 0   ← "seeded silently"
Next run:                   fetch 501 → 1 not in store → notify 1
```

This is why, in the live test earlier, you saw `Stripe (greenhouse): 527 job(s),
0 new` — 527 jobs fetched, but 0 reported because it was the first run and they
all got seeded.

---

## 5. `sourceKeyOf`: why we can't just store job ids

This is the concept you specifically asked about. Here's the problem it solves.

Job ids are **only unique within a single company's board.** Stripe might have a
job with id `12345`, and Airbnb *also* has a job with id `12345` — they're
completely unrelated jobs that happen to share a number. (Look at the table in §3:
`12345` appears for both `greenhouse:stripe` and `greenhouse:airbnb`.)

So if we stored just the bare job id `12345`, we'd have a collision: after seeing
Stripe's job 12345, we'd wrongly think Airbnb's brand-new job 12345 was "already
seen" and never tell you about it.

**Fix:** store each job id *paired with a label for which board it came from.*
That label is the **source key**, and `sourceKeyOf(target)` is the tiny function
that builds it.

```ts
sourceKeyOf({ ats: "greenhouse", token: "stripe" })  →  "greenhouse:stripe"
sourceKeyOf({ ats: "greenhouse", token: "airbnb" })  →  "greenhouse:airbnb"
```

It's just `"<ats-type>:<board-identifier>"`. Now Stripe's `12345` is stored as
`(greenhouse:stripe, 12345)` and Airbnb's as `(greenhouse:airbnb, 12345)` — no
collision.

### The subtle design choice: why not key on the company *name*?

Your targets look like:
```json
{ "company": "Stripe", "ats": "greenhouse", "token": "stripe", "tier": 1 }
```

`"company": "Stripe"` is a **display name** — it exists only to look nice in
notifications. It could change tomorrow: you might rename it to `"Stripe Inc."` or
`"Stripe Payments"`.

If the source key were built from the display name, then renaming `Stripe` →
`Stripe Inc.` would change every stored key from `Stripe:12345` to
`Stripe Inc.:12345`. Suddenly **none** of the stored jobs match the new key, so
the poller thinks it's a brand-new board and re-notifies you about all 500 jobs.
A cosmetic rename would trigger a spam flood.

`token` (`"stripe"`) is the *technical* identifier — it's part of the actual API
URL, so it can't change without pointing at a different board entirely. Keying on
`ats` + `token` makes the source key **stable**: it only changes when you're
genuinely talking about a different board. That's the "stable per-source key,
NOT the display name" principle. There's even a test that renames the company and
asserts the key stays the same.

> **Insight:** This is a recurring idea in data systems — separate the *identity*
> of a thing (stable, technical, used as a key) from its *label* (human-friendly,
> allowed to change). Using a label as a key is a classic source of bugs.

---

## 6. "Prune & re-notify": handling jobs that disappear and come back

Jobs don't just appear — they also *vanish* (the role gets filled or closed, so
it drops off the board). And sometimes the same role gets **reposted** weeks later.

You chose the behavior: if a job disappears and later comes back, treat the
comeback as **new** and notify again. Here's how that works, and it's why we track
`last_seen`.

- Every run, for each job still on the board, we bump its `last_seen` to "now."
- A job that's fallen off the board stops getting its `last_seen` bumped — it goes
  stale.
- Once a job hasn't been seen for **14 days** (the "grace window"), we **prune**
  it — delete its row from `seen_jobs`.
- Because its row is now gone, if that same job id reappears on the board later,
  it's no longer in our notebook → it counts as new → you get re-notified. 

**Why a 14-day grace window instead of deleting the instant a job vanishes?**
Boards are flaky. A job might momentarily drop out because of a network hiccup, a
paging glitch, or the ATS having a bad moment. If we pruned instantly, that job
would "reappear" on the very next run and re-notify you — this rapid appear/
disappear/appear is called **flapping**. The 14-day buffer means a job has to be
*genuinely* gone for two weeks before we forget it. That's a deliberate tradeoff
you approved.

> **Insight:** "Grace windows" / debouncing show up everywhere in systems that
> watch a noisy signal — you wait to confirm a change is real before acting on it,
> trading a little latency for a lot fewer false alarms.

---

## 7. The trickiest bug we designed around: the `sources` table

This is the one real design correction we made (it came up while writing the
implementation plan), and it's worth understanding because it ties §4, §5, and §6
together.

**Question:** How does the code know a board is on its "first run" (so it should
seed silently)?

**Tempting-but-wrong answer:** "It's the first run if I have zero stored jobs for
this source."

Why that's wrong: pruning (§6) can legitimately delete *all* of a source's rows —
imagine a small startup that closes every open role for a while. Now the source
has zero stored jobs. The naive check would say "zero jobs = must be a first run"
and **seed it silently again** — meaning when roles reappear, you'd get *nothing*,
because it re-seeded instead of re-notifying. That directly breaks the
"re-notify" behavior you asked for.

**The fix:** keep a second, tiny table called `sources` that just records *"I have
polled this board at least once."*

| source            | first_seen           |
|-------------------|----------------------|
| greenhouse:stripe | 2026-07-24T09:00:00Z |
| greenhouse:airbnb | 2026-07-20T09:00:00Z |

Now "first run?" is answered by **"is this source in the `sources` table?"** —
which is independent of how many job rows currently exist. A source pruned down to
zero jobs is *still* in `sources`, so it's correctly treated as "known," and its
reappearing jobs re-notify instead of getting silently re-seeded.

> **The key distinction:** "have I ever seen this **board**?" (the `sources` table)
> is a different question from "have I seen this specific **job**?" (the
> `seen_jobs` table). Conflating them was the bug; separating them is the fix.

---

## 8. `diffAndRecord`: the heart of it all

One function does the actual dedup. Given a source key and the list of jobs just
fetched, it returns **only the new ones** and updates the notebook. Its logic:

```
diffAndRecord(source, jobs):
  1. isNewSource = (source is NOT in the `sources` table)
  2. if isNewSource: add source to the `sources` table
  3. existingIds = all job_ids already stored for this source
  4. newJobs = isNewSource ? []                              ← seed silently
                           : jobs whose id is NOT in existingIds
  5. for every fetched job: upsert it (bump last_seen to now)
  6. return newJobs
```

- **Step 4** is where seeding (§4) and dedup (§2) both live: on a first run we
  return nothing; otherwise we return only jobs we hadn't stored.
- **"upsert"** in step 5 = *update-or-insert*: if the job is new, insert a row
  (setting both `first_seen` and `last_seen` to now); if it already exists, just
  update its `last_seen`. This is one SQL statement (`INSERT ... ON CONFLICT ...
  DO UPDATE`) — it's how `first_seen` stays frozen while `last_seen` keeps moving.

### Atomicity / "transaction" (why one Phase-2 fix happened)

All those writes happen inside a **transaction** — a database concept meaning
"these changes all succeed together, or none of them do." If the program crashed
halfway (power loss, kill signal), you'd never end up with a *partial* write.

The first version of the code accidentally did the `sources` insert (step 2)
*outside* the transaction that wrapped the job writes (step 5). A crash in between
could leave a source marked "known" but with zero jobs stored — which on the next
run would make **every** job look new and flood you. The review caught it, and the
fix wrapped the whole read-decide-write sequence in a single transaction so it's
truly all-or-nothing. (That's the commit `fix: make diffAndRecord fully atomic`.)

> **Insight:** Transactions are the standard tool for keeping a database
> *consistent* across failures. The rule of thumb: writes that must be true
> *together* belong in the same transaction.

---

## 9. How the pieces fit — the full poll cycle

Here's one complete run, end to end, and which file owns each step:

```
  src/index.ts          "start up": open the database, wire everything together
        │
        ▼
  src/config.ts         loadTargets()  → read targets.json (the companies to check)
        │
        ▼
  src/core/poll.ts      poll() — the orchestrator. For each target:
        │                 ├─ src/adapters/index.ts  pick the right adapter for the ATS
        │                 ├─ src/adapters/greenhouse.ts  fetchJobs() → call the API,
        │                 │                                normalize the raw JSON into
        │                 │                                clean Job objects
        │                 ├─ src/adapters/util.ts    sourceKeyOf(target) → the stable key
        │                 └─ src/core/state.ts       diffAndRecord(key, jobs) → NEW jobs only
        │
        │               after the loop over all targets:
        │                 ├─ src/core/state.ts       prune(14) → forget jobs gone >14 days
        │                 └─ src/notifiers/console.ts notifyBatch(newJobs) → print them
        ▼
  src/index.ts          finally: close the database (always, even if something errored)
```

A few design notes on this structure:

- **`poll()` is separate from `index.ts` on purpose.** `index.ts` just wires up
  the *real* pieces (real database, real network, real console). `poll()` contains
  the actual logic but receives its dependencies as arguments. This is called
  **dependency injection**, and its payoff is testing (§10).
- **Adapters** isolate each ATS's quirks. `greenhouse.ts` knows Greenhouse's exact
  JSON shape and translates it into a clean, uniform `Job` object. When you add
  Lever or Ashby later, you write a new adapter — nothing else changes. The
  `Job` type is the "common language" the rest of the code speaks.
- **Per-target error isolation:** each company's fetch is wrapped in its own
  try/catch. If Stripe's API is down, you get a logged error for Stripe and the
  run *continues* to Airbnb. One bad board never kills the whole run.
- **`prune` runs once, after the loop** — not per company — and notifications are
  **batched** (collected across all companies, sent in one go) rather than fired
  one-by-one. That's tidier and, once a real notifier like Telegram exists, avoids
  hammering it.

---

## 10. Why everything was testable without the internet

You saw "13 tests passing" without the tests ever calling Stripe. That's the
dependency-injection payoff:

- **Fake HTTP client:** in tests, instead of the real network client we pass in a
  stub whose `getJson()` just returns a hand-written Greenhouse-shaped payload. The
  real adapter still runs and normalizes it — we're testing our logic, not
  Greenhouse's servers.
- **In-memory database:** SQLite supports a special path `":memory:"` — a throwaway
  database that lives in RAM and vanishes when the test ends. Each test gets a
  clean one. No files, no cleanup, no interference between tests.
- **Injectable clock:** the store takes an optional `now()` function. Real runs use
  the system clock; the prune tests pass a *fake* clock they can fast-forward, so a
  test can simulate "20 days later" instantly and check that pruning kicks in at
  the 14-day line. (You can't test a 14-day timeout by actually waiting 14 days.)

> **Insight:** The pattern is always the same — a unit of code should receive the
> outside world (network, database, time) as arguments rather than reaching out
> and grabbing it. Then tests can hand it a controllable stand-in. This is the
> single biggest reason the code is testable at all.

---

## 11. How the work itself got built (the process you saw scroll by)

You watched a lot of "dispatching subagent… reviewer… fix." Here's what that was:

1. **Brainstorm** — I asked you the 3 decisions that actually shaped the design
   (seed-silently, local-only scope, prune-and-re-notify) and wrote them into a
   **spec** (`docs/superpowers/specs/…-design.md`) — the "what and why."
2. **Plan** — I turned the spec into a step-by-step **implementation plan**
   (`docs/superpowers/plans/…`) broken into 5 small tasks, each with exact code and
   tests. This is also where I caught the `sources`-table bug (§7) before any code
   was written.
3. **Build, task by task** — for each task I launched a fresh **implementer**
   agent (writes the code test-first), then a separate **reviewer** agent (checks
   it against the spec and for bugs). When the reviewer found the atomicity bug
   (§8), a **fix** agent corrected it and it was re-reviewed. Using *fresh* agents
   per task keeps each one focused and unbiased — the reviewer isn't the same
   entity that wrote the code, so it's a genuine second opinion.
4. **Final review** — after all tasks, one broad review over the whole branch
   confirmed the pieces integrate correctly and flagged the Phase-3 follow-up
   below.

The result is 7 commits on a branch called `phase-2-dedup-state`, each a small,
reviewed, tested step — rather than one giant unreviewed dump of code.

---

## 12. What's deliberately NOT done yet (future phases)

Phase 2 was scoped to *local dedup only*. Intentionally left for later:

- **Phase 3 — the actual cron:** a GitHub Action that runs the poller on a schedule
  and saves `state.db` to a separate git branch so state survives between runs.
- **Telegram notifier:** right now new jobs print to your console. The
  `Notifier` interface is already shaped so a Telegram sender drops in without
  touching the poll logic.
- **More ATS adapters:** Lever, Ashby, SmartRecruiters, Workable, Workday. Only
  Greenhouse exists today.
- **Input validation + HTTP retries** (Phase 5 in the roadmap).

### One known limitation the final review flagged (a Phase-3 to-do)

If a company's board is *unreachable for more than 14 days straight* (their API is
down that whole time), pruning will age out all its stored jobs, and when the board
comes back you'll get re-notified about the entire board as if it were new. It's a
rare edge case, and the fix (skip pruning a source on runs where its fetch failed)
is noted for Phase 3.

---

## TL;DR

- The app polls job boards, which always return *all* jobs, so it needs **dedup**:
  remember what you've seen, report only what's new.
- Memory = a **SQLite** file (`state.db`) with a `seen_jobs` table.
- Job ids collide across companies, so we store them under a **stable source key**
  (`sourceKeyOf` → `greenhouse:stripe`), built from technical config, *not* the
  renameable display name.
- **First run seeds silently** (record all, notify none) so you don't get flooded.
- **`last_seen` + a 14-day prune** let genuinely reposted jobs re-notify while
  ignoring brief board glitches.
- A separate **`sources` table** answers "seen this *board* before?" independently
  of "seen this *job*?" — without it, pruning would wrongly re-seed emptied boards.
- Writes are wrapped in a **transaction** so a crash can't leave a half-updated,
  flood-causing state.
- Everything is **dependency-injected** (fake HTTP, in-memory DB, fake clock), which
  is why it's fully tested offline.
