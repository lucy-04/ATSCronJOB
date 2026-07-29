# AWS Deployment — Design Spec

**Date:** 2026-07-29
**Status:** Draft for user review
**Scope:** Move the poller from a GitHub Actions cron (SQLite state on an orphan branch) to **AWS Lambda + EventBridge + DynamoDB**, provisioned by **Terraform**, deployed by a **GitHub Actions CI/CD pipeline (OIDC)**, with **CloudWatch monitoring + alerting**. Resume goal: demonstrate AWS, Lambda, managed services, IaC, CI/CD-to-AWS, DevOps, CloudWatch/observability.

## Goal

Run the existing poller hourly on AWS with durable serverless dedup state, deployed automatically from `main`, and alert the operator when a run fails or the schedule stops firing. Reuse the existing engine (poll/filter/dedup/adapters/Telegram) unchanged in behavior.

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Compute | **Lambda** (Node 20) triggered by **EventBridge** hourly rule | Serverless cron, no server to operate |
| State store | **DynamoDB** | Key-value dedup fit; serverless; drops native `better-sqlite3` from the Lambda bundle; **TTL auto-prunes** (replaces manual 14-day prune) |
| IaC | **Terraform** | Strongest DevOps keyword; defines all resources incl. the OIDC role |
| CI/CD auth | **GitHub OIDC → IAM role** | No long-lived AWS keys |
| Secrets | **SSM Parameter Store (SecureString)** | Managed, free; Lambda reads at runtime via IAM+KMS |
| Migration | **Move** (Lambda polls; GitHub Actions deploys) | Avoids double-notification; retires the orphan-`state`-branch cron |
| Cost | ~$0 (always-free tiers) | 1 run/hour |

## Architecture

```
EventBridge (rate: 1 hour) ──► Lambda: handler in src/lambda.ts
                                   │  reads Telegram secrets from SSM
                                   │  poll(sources, http, DynamoStore, TelegramNotifier, roleFilter)
                                   ├─► DynamoDB table  (dedup; per-item TTL = last_seen + 14d)
                                   ├─► Telegram        (new jobs)
                                   └─► CloudWatch Logs + custom metrics (EMF)

CloudWatch Alarms ─► SNS topic ─► operator email
  • Lambda Errors ≥ 1 (a run threw)
  • Lambda Invocations < 1 over 3h (schedule stopped firing / staleness)

GitHub Actions (push to main): test → esbuild bundle → terraform apply  (assumes IAM role via OIDC)
```

### Components (each a focused unit)

- **`src/core/dynamo-state.ts`** *(new)* — `createDynamoStore({ tableName, client?, now?, graceDays? }): StateStore`. Implements the same `StateStore` contract against DynamoDB (AWS SDK v3 `@aws-sdk/lib-dynamodb`):
  - Table item shape: `pk` = source key, `sk` = `job_id` for job rows and the sentinel `"#SOURCE"` for the "source has been seen" marker (enables seed-silently). Attributes: `first_seen`, `last_seen`, `expires_at` (epoch seconds, DynamoDB **TTL** attribute).
  - `diffAndRecord(source, jobs)`: read the `#SOURCE` marker; if absent → **seed silently** (BatchWrite all job rows + the marker, return `[]`). Else `BatchGetItem` the fetched job ids → the ones absent are **new**; `BatchWrite` upsert all fetched rows with refreshed `last_seen`/`expires_at`; return the new jobs. (Batched in ≤100/≤25 chunks per API limits.)
  - `prune(graceDays, sources)`: **no-op returning 0** — DynamoDB TTL deletes items not refreshed within `graceDays`. (Interface preserved; the poll loop is unchanged.)
  - `close()`: no-op.
- **`src/aws/secrets.ts`** *(new)* — `getTelegramCredsFromSsm(): Promise<{ token, chatId }>` via `@aws-sdk/client-ssm` `GetParameter(WithDecryption)`. Only the Lambda uses it.
- **`src/lambda.ts`** *(new)* — the handler: build `createHttpClient()`, `createDynamoStore({ tableName: env.STATE_TABLE })`, the Telegram notifier from SSM creds, then `await poll({ sources: loadSources(), http, store, notifier, roleFilter: loadRoleFilter() })`. Emits `NewJobsNotified` / `SourcesFailed` custom metrics via EMF to stdout. Returns a small summary.
- **`infra/`** *(new, Terraform)* — split in two tiers:
  - `infra/bootstrap/` — applied **once, locally, with admin creds**: the S3 remote-state bucket + DynamoDB state-lock table, the GitHub **OIDC provider**, and the CI **deploy role**. (Remote state is required so CI/CD `terraform apply` persists state between runs.)
  - `infra/app/` — the application stack (remote S3 backend): DynamoDB state table (TTL on `expires_at`), Lambda (bundle from `dist/lambda.js`), EventBridge rule + permission, SSM parameters (created empty / value set out-of-band), the Lambda execution role (DynamoDB RW, `ssm:GetParameter`+KMS decrypt, logs), SNS topic + email subscription, CloudWatch alarms + dashboard.
- **`.github/workflows/deploy.yml`** *(new)* — on push to `main`: `npm ci` → `npm test` → `npm run bundle` (esbuild) → configure AWS via OIDC → `terraform -chdir=infra/app init/apply`. `terraform plan` (no apply) runs on PRs.
- **`src/core/state.ts`, `src/core/poll.ts`** *(modified)* — **promisify `StateStore`**: `diffAndRecord(...) : Promise<Job[]>`, `prune(...) : Promise<number>`, `close(): Promise<void> | void`. The SQLite impl wraps its synchronous body in `async` (trivial). `poll.ts` gains `await` on `store.diffAndRecord` and `store.prune`. This is the ONLY engine change and it is required because a networked store cannot be synchronous.

### Data flow (one run)

EventBridge fires → Lambda cold/warm start → read SSM secrets (cached across warm invocations) → `poll()` iterates sources → each adapter fetches (unchanged) → role filter (unchanged) → `await store.diffAndRecord` against DynamoDB → new jobs collected → `await notifier.notifyBatch` to Telegram → EMF metrics to logs → return.

## Error handling

- Per-source fetch failures stay isolated in `poll` (unchanged) — one bad ATS never fails the run.
- A thrown handler (e.g. DynamoDB/SSM/Telegram outage) → Lambda records an **Error** → CloudWatch alarm → SNS email. Because state is written per-source during the run, a mid-run failure is at-least-once (re-notifies next hour) — same semantics as today; the tracked `record-after-notify` follow-up still applies and is out of scope here.
- Lambda timeout 60s, memory 256 MB, no retries on the async EventBridge invoke beyond the default (idempotent-ish; dedup tolerates re-runs).

## Testing

- **`test/dynamo-state.test.ts`** *(new)* — unit-test `createDynamoStore` with `aws-sdk-client-mock` (no network): seed-silently on first sight of a source; new-job detection on the second run; `expires_at` TTL set to `last_seen + graceDays`; `prune` returns 0.
- **Existing 68 tests stay green** — the promisified `StateStore` requires adding `await` in `state.test.ts`/`poll.test.ts`; behavior is unchanged.
- **IaC checks** — `terraform fmt -check` and `terraform validate` (+ `plan` on PRs) run in CI.
- **Live smoke (operator)** — manual `aws lambda invoke` twice: first seeds DynamoDB silently, second delivers new roles to Telegram; confirm items appear in the DynamoDB table and metrics in CloudWatch.

## Rollout (operator-run, documented in `docs/aws-deployment.md`)

1. One-time: `terraform -chdir=infra/bootstrap apply` (admin creds) → creates state backend + OIDC provider + deploy role.
2. Put secrets: `aws ssm put-parameter` for `/ats-poller/telegram-bot-token` and `/ats-poller/telegram-chat-id` (SecureString). Confirm the SNS subscription email.
3. First app deploy: `terraform -chdir=infra/app apply` locally (or push to `main` to let CI do it).
4. Verify via two manual invokes (smoke above).
5. **Disable the old cron**: remove the `schedule:` trigger from `.github/workflows/poll.yml` (keep the file for local/manual runs, or delete). AWS is now the source of truth.

## Out of scope (later)

- `record-after-notify` transactional delivery; SmartRecruiters pagination; zod validation.
- Multi-region, VPC, X-Ray tracing, blue/green Lambda aliases.
- Migrating existing dedup history from the `state` branch — not worth it; DynamoDB seeds silently on first run (one quiet cycle), same as any new source.

## Success criteria

- `terraform apply` provisions the full stack; `npm test` green (incl. new DynamoDB tests); `npm run bundle` produces a Lambda zip with no native deps.
- Two manual Lambda invokes: first seeds silently, second delivers new jobs to Telegram; DynamoDB shows items with a future `expires_at`.
- Pushing to `main` triggers `deploy.yml` which assumes the OIDC role and applies Terraform with no static AWS keys anywhere.
- A forced Lambda error (or a 3h gap in invocations) sends an SNS email.
- Old GitHub Actions poll cron disabled; no double-notification.

## What the operator must do (cannot be automated from here)

Create/own an AWS account; install AWS CLI + Terraform; run the one-time `infra/bootstrap` apply with admin creds; put the two Telegram SSM parameters; confirm the SNS alert email; add the OIDC role ARN as a GitHub Actions variable. Everything else (code, IaC, workflow, runbook) is written for them.
