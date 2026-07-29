# AWS Core Deploy (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Tasks 1–3 are code (TDD, testable locally). Task 4–5 are IaC/CI/docs (verified by `terraform validate`/`fmt` and review; the operator runs `terraform apply`).

**Goal:** Run the poller on AWS Lambda (hourly via EventBridge) with DynamoDB dedup state, provisioned by Terraform and deployed from GitHub Actions via OIDC — reusing the existing poll/filter/adapter/Telegram engine unchanged. Monitoring is Plan 2.

**Architecture:** Add a `createDynamoStore()` implementing the existing `StateStore` contract (promisified to async), a thin `src/lambda.ts` handler that reads Telegram secrets from SSM, an esbuild bundle, and Terraform in two tiers (`infra/bootstrap` once, `infra/app` per-deploy). Local `npm start` keeps using SQLite; Lambda uses DynamoDB.

**Tech Stack:** TypeScript (ESM, strict), AWS SDK v3 (`@aws-sdk/lib-dynamodb`, `@aws-sdk/client-ssm`), esbuild, Terraform, GitHub Actions OIDC, vitest, `aws-sdk-client-mock`.

**Design source:** `docs/superpowers/specs/2026-07-29-aws-deployment-design.md`.

## Global Constraints

- Node >= 20; ESM (`verbatimModuleSyntax`): `.js` relative imports, `import type` for types. Tests under `test/`, `npx vitest run`; `npm run typecheck` clean.
- **AWS SDK v3 packages are provided by the Node 20 Lambda runtime** — add them as **devDependencies** and mark `@aws-sdk/*` **external** in the esbuild bundle (keeps the zip small, no native deps).
- `better-sqlite3` stays a dependency for local runs/tests but MUST NOT appear in the Lambda bundle (`src/lambda.ts` imports the DynamoDB store, never `state.ts`).
- DynamoDB table: partition key `pk` (String), sort key `sk` (String). TTL attribute `expires_at` (Number, epoch seconds). Sentinel `sk = "#SOURCE"` marks a seen source (seed-silently).
- Secrets live in SSM Parameter Store (SecureString) at `/ats-poller/telegram-bot-token` and `/ats-poller/telegram-chat-id`; the Lambda reads them at runtime. No secrets in Terraform state or git.
- Terraform: resources prefixed `ats-poller`; region from a variable (default `ap-south-1`, Mumbai — closest to the India-based operator). CI/CD uses GitHub OIDC (no static keys).

---

### Task 1: Promisify the `StateStore` interface

**Files:**
- Modify: `src/core/state.ts`, `src/core/poll.ts`, `src/index.ts`, `test/state.test.ts`, `test/poll.test.ts`

**Interfaces:**
- Produces: `StateStore` with `diffAndRecord(source, jobs): Promise<Job[]>`, `prune(graceDays, sources): Promise<number>`, `close(): Promise<void>`. Consumed by the DynamoDB store (Task 2) and the Lambda handler (Task 3).

- [ ] **Step 1: Update the interface + SQLite impl in `src/core/state.ts`**

Change the interface:
```ts
export interface StateStore {
  /** Record all fetched jobs for a source; return only the ones new to us. */
  diffAndRecord(source: string, jobs: Job[]): Promise<Job[]>;
  /** Remove jobs (only for the given sources) whose last_seen is older than graceDays; return rows removed. */
  prune(graceDays: number, sources: string[]): Promise<number>;
  close(): Promise<void>;
}
```
Make the three returned methods `async` (bodies are otherwise unchanged — better-sqlite3 stays synchronous inside):
```ts
    async diffAndRecord(source: string, jobs: Job[]): Promise<Job[]> {
      const nowIso = new Date(now()).toISOString();
      const tx = db.transaction((): Job[] => {
        const isNewSource = sourceExists.get(source) === undefined;
        if (isNewSource) insertSource.run({ source, now: nowIso });
        const existing = new Set(
          (selectIds.all(source) as Array<{ job_id: string }>).map((r) => r.job_id),
        );
        const newJobs = isNewSource ? [] : jobs.filter((j) => !existing.has(j.id));
        for (const j of jobs) upsert.run({ source, jobId: j.id, now: nowIso });
        return newJobs;
      });
      return tx();
    },

    async prune(graceDays: number, sources: string[]): Promise<number> {
      if (sources.length === 0) return 0;
      const cutoff = new Date(now() - graceDays * DAY_MS).toISOString();
      const run = db.transaction((srcs: string[]): number => {
        let removed = 0;
        for (const source of srcs) {
          removed += deleteStaleForSource.run({ source, cutoff }).changes;
        }
        return removed;
      });
      return run(sources);
    },

    async close(): Promise<void> {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
```

- [ ] **Step 2: `await` the store in `src/core/poll.ts`**

Line ~63: `const newJobs = store.diffAndRecord(key, jobs);` → `const newJobs = await store.diffAndRecord(key, jobs);`
Line ~72: `const removed = store.prune(graceDays, okSources);` → `const removed = await store.prune(graceDays, okSources);`

- [ ] **Step 3: `await` close in `src/index.ts`**

In the `finally` block change `store.close();` → `await store.close();`.

- [ ] **Step 4: Update tests to await**

In `test/state.test.ts` and `test/poll.test.ts`, every call to `store.diffAndRecord(...)`, `store.prune(...)`, and `store.close()` must be `await`ed (the enclosing `it(...)` callbacks are already `async` in poll.test.ts; make state.test.ts callbacks `async` where needed). Do NOT change any asserted values — behavior is identical.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run` → all 68 pass (now with awaited async store).
Run: `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/state.ts src/core/poll.ts src/index.ts test/state.test.ts test/poll.test.ts
git commit -m "refactor: promisify StateStore (async diffAndRecord/prune/close)"
```

---

### Task 2: DynamoDB state store

**Files:**
- Create: `src/core/dynamo-state.ts`, `test/dynamo-state.test.ts`
- Modify: `package.json` (add deps)

**Interfaces:**
- Consumes: `StateStore` (Task 1), `Job` from `./types.js`.
- Produces: `createDynamoStore(opts: DynamoStoreOptions): StateStore` where `DynamoStoreOptions = { tableName: string; client?: DynamoDBDocumentClient; now?: () => number; graceDays?: number }`.

- [ ] **Step 1: Add dependencies**

```bash
npm install --save-dev @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb aws-sdk-client-mock
```
(These are dev deps: the Lambda runtime provides `@aws-sdk/*`; `aws-sdk-client-mock` is test-only.)

- [ ] **Step 2: Write `test/dynamo-state.test.ts` (RED)**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoStore } from "../src/core/dynamo-state.js";
import type { Job } from "../src/core/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = "test-table";
const FIXED_NOW = 1_700_000_000_000; // fixed epoch ms
function job(id: string): Job { return { id, title: id, url: "https://x/" + id, location: "Remote" }; }
function store() {
  return createDynamoStore({ tableName: TABLE, client: ddbMock as unknown as DynamoDBDocumentClient, now: () => FIXED_NOW, graceDays: 14 });
}

beforeEach(() => ddbMock.reset());

describe("createDynamoStore", () => {
  it("seeds a new source silently (no new jobs) and writes a #SOURCE marker + job rows", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // marker absent -> new source
    ddbMock.on(BatchWriteCommand).resolves({});
    const result = await store().diffAndRecord("greenhouse:acme", [job("1"), job("2")]);
    expect(result).toEqual([]); // seed-silently
    const writes = ddbMock.commandCalls(BatchWriteCommand);
    expect(writes.length).toBeGreaterThan(0);
    const written = writes.flatMap((c) => (c.args[0].input.RequestItems![TABLE] ?? []).map((r: any) => r.PutRequest.Item));
    expect(written.some((i) => i.sk === "#SOURCE")).toBe(true);
    expect(written.filter((i) => i.sk !== "#SOURCE").map((i) => i.sk).sort()).toEqual(["1", "2"]);
    // TTL set to now + 14d (epoch seconds)
    const expected = Math.floor(FIXED_NOW / 1000) + 14 * 86400;
    expect(written.every((i) => i.expires_at === expected)).toBe(true);
  });

  it("returns only jobs not already seen on a subsequent run", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: "greenhouse:acme", sk: "#SOURCE" } }); // marker present
    // job "1" already exists; "2" and "3" are new
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [{ pk: "greenhouse:acme", sk: "1" }] } });
    ddbMock.on(BatchWriteCommand).resolves({});
    const result = await store().diffAndRecord("greenhouse:acme", [job("1"), job("2"), job("3")]);
    expect(result.map((j) => j.id).sort()).toEqual(["2", "3"]);
  });

  it("prune is a no-op (DynamoDB TTL handles expiry)", async () => {
    expect(await store().prune(14, ["greenhouse:acme"])).toBe(0);
    expect(ddbMock.commandCalls(BatchWriteCommand).length).toBe(0);
  });

  it("returns [] for an empty job list without writing", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: "x", sk: "#SOURCE" } });
    const result = await store().diffAndRecord("greenhouse:acme", []);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/dynamo-state.test.ts` → FAIL (module not found).

- [ ] **Step 4: Write `src/core/dynamo-state.ts`**

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Job } from "./types.js";
import type { StateStore } from "./state.js";

const DAY_S = 86_400;
const SOURCE_MARKER = "#SOURCE";

export interface DynamoStoreOptions {
  tableName: string;
  /** Injectable for tests; defaults to a real DocumentClient. */
  client?: DynamoDBDocumentClient;
  /** Epoch-ms clock, injectable for deterministic tests. */
  now?: () => number;
  /** Prune window in days (drives the TTL). Default 14. */
  graceDays?: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function createDynamoStore(opts: DynamoStoreOptions): StateStore {
  const client = opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const table = opts.tableName;
  const now = opts.now ?? Date.now;
  const graceDays = opts.graceDays ?? 14;

  function ttl(nowMs: number): number {
    return Math.floor(nowMs / 1000) + graceDays * DAY_S;
  }

  /** BatchWrite all items, retrying UnprocessedItems until drained. */
  async function batchWrite(items: Record<string, unknown>[]): Promise<void> {
    for (const group of chunk(items, 25)) {
      let requestItems: Record<string, unknown[]> = {
        [table]: group.map((Item) => ({ PutRequest: { Item } })),
      };
      // Retry unprocessed items a bounded number of times.
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await client.send(new BatchWriteCommand({ RequestItems: requestItems as never }));
        const unprocessed = res.UnprocessedItems?.[table];
        if (!unprocessed || unprocessed.length === 0) break;
        requestItems = { [table]: unprocessed as unknown[] };
      }
    }
  }

  /** Return the set of sk (job_id) values already stored for `source`, among the given ids. */
  async function existingIds(source: string, ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const group of chunk(ids, 100)) {
      let keys = group.map((id) => ({ pk: source, sk: id }));
      for (let attempt = 0; attempt < 5 && keys.length > 0; attempt++) {
        const res = await client.send(
          new BatchGetCommand({ RequestKeys: undefined, RequestItems: { [table]: { Keys: keys } } as never }),
        );
        for (const item of (res.Responses?.[table] ?? []) as Array<{ sk: string }>) found.add(item.sk);
        const un = (res.UnprocessedKeys?.[table] as { Keys?: Array<{ sk: string }> } | undefined)?.Keys;
        keys = (un as typeof keys) ?? [];
      }
    }
    return found;
  }

  return {
    async diffAndRecord(source: string, jobs: Job[]): Promise<Job[]> {
      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();
      const exp = ttl(nowMs);

      const markerRes = await client.send(
        new GetCommand({ TableName: table, Key: { pk: source, sk: SOURCE_MARKER } }),
      );
      const isNewSource = markerRes.Item === undefined;

      const marker = { pk: source, sk: SOURCE_MARKER, last_seen: nowIso, expires_at: exp };
      const jobItem = (j: Job) => ({ pk: source, sk: j.id, first_seen: nowIso, last_seen: nowIso, expires_at: exp });

      if (isNewSource) {
        // Seed silently: record everything, notify nothing.
        await batchWrite([marker, ...jobs.map(jobItem)]);
        return [];
      }
      if (jobs.length === 0) {
        await batchWrite([marker]);
        return [];
      }
      const existing = await existingIds(source, jobs.map((j) => j.id));
      const newJobs = jobs.filter((j) => !existing.has(j.id));
      await batchWrite([marker, ...jobs.map(jobItem)]);
      return newJobs;
    },

    // DynamoDB TTL deletes items not refreshed within graceDays; nothing to do.
    async prune(): Promise<number> {
      return 0;
    },

    async close(): Promise<void> {
      // DocumentClient needs no explicit teardown.
    },
  };
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/dynamo-state.test.ts` → PASS (4).
Run: `npx vitest run` → full suite green.
Run: `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/dynamo-state.ts test/dynamo-state.test.ts package.json package-lock.json
git commit -m "feat: DynamoDB StateStore (seed-silently, TTL-based prune)"
```

---

### Task 3: SSM secrets, Lambda handler, and esbuild bundle

**Files:**
- Create: `src/aws/secrets.ts`, `src/lambda.ts`, `test/secrets.test.ts`
- Modify: `package.json` (add `esbuild` devDep + `bundle` script), `.gitignore` (ignore `dist/`)

**Interfaces:**
- Consumes: `createDynamoStore` (Task 2), existing `loadSources`/`loadRoleFilter`/`createHttpClient`/`createTelegramNotifier`/`consoleNotifier`.
- Produces: `getTelegramCreds(): Promise<{ token: string; chatId: string }>`; `handler(event?): Promise<{ ok: boolean }>` (the Lambda entrypoint).

- [ ] **Step 1: Add esbuild + bundle script to `package.json`**

Add devDep: `npm install --save-dev esbuild`.
Add script (bundles the Lambda entry, keeping the AWS SDK external so the runtime provides it):
```json
"bundle": "esbuild src/lambda.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/lambda.mjs --external:@aws-sdk/*"
```
Add `dist/` to `.gitignore`.

- [ ] **Step 2: Write `test/secrets.test.ts` (RED)**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { getTelegramCreds } from "../src/aws/secrets.js";

const ssmMock = mockClient(SSMClient);
beforeEach(() => ssmMock.reset());

describe("getTelegramCreds", () => {
  it("reads both SecureString params with decryption", async () => {
    ssmMock.on(GetParameterCommand, { Name: "/ats-poller/telegram-bot-token" }).resolves({ Parameter: { Value: "TOKEN" } });
    ssmMock.on(GetParameterCommand, { Name: "/ats-poller/telegram-chat-id" }).resolves({ Parameter: { Value: "CHAT" } });
    const creds = await getTelegramCreds(ssmMock as unknown as SSMClient);
    expect(creds).toEqual({ token: "TOKEN", chatId: "CHAT" });
    const call = ssmMock.commandCalls(GetParameterCommand)[0]!;
    expect(call.args[0].input.WithDecryption).toBe(true);
  });

  it("throws if a parameter is missing a value", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: {} });
    await expect(getTelegramCreds(ssmMock as unknown as SSMClient)).rejects.toThrow(/missing/i);
  });
});
```

- [ ] **Step 3: Add `@aws-sdk/client-ssm`**

```bash
npm install --save-dev @aws-sdk/client-ssm
```

- [ ] **Step 4: Write `src/aws/secrets.ts`**

```ts
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const BOT_TOKEN_PARAM = "/ats-poller/telegram-bot-token";
const CHAT_ID_PARAM = "/ats-poller/telegram-chat-id";

async function getParam(client: SSMClient, name: string): Promise<string> {
  const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is missing a value`);
  return value;
}

/** Read the Telegram bot token + chat id from SSM Parameter Store (SecureString). */
export async function getTelegramCreds(client: SSMClient = new SSMClient({})): Promise<{ token: string; chatId: string }> {
  const [token, chatId] = await Promise.all([
    getParam(client, BOT_TOKEN_PARAM),
    getParam(client, CHAT_ID_PARAM),
  ]);
  return { token, chatId };
}
```

- [ ] **Step 5: Write `src/lambda.ts`**

```ts
import { loadSources, loadRoleFilter } from "./config.js";
import { createHttpClient } from "./core/http.js";
import { createDynamoStore } from "./core/dynamo-state.js";
import { poll } from "./core/poll.js";
import { createTelegramNotifier } from "./notifiers/telegram.js";
import { consoleNotifier } from "./notifiers/console.js";
import { getTelegramCreds } from "./aws/secrets.js";
import type { Notifier } from "./core/types.js";

/**
 * Lambda entrypoint. One poll cycle against DynamoDB, delivering to Telegram.
 * STATE_TABLE is injected by Terraform; secrets come from SSM.
 */
export async function handler(): Promise<{ ok: boolean; error?: string }> {
  const tableName = process.env.STATE_TABLE;
  if (!tableName) throw new Error("STATE_TABLE env var is required");

  const http = createHttpClient();
  const store = createDynamoStore({ tableName });

  let notifier: Notifier = consoleNotifier;
  try {
    const { token, chatId } = await getTelegramCreds();
    notifier = createTelegramNotifier({ token, chatId, http });
  } catch (err) {
    console.error(`Telegram creds unavailable, falling back to console: ${(err as Error).message}`);
  }

  await poll({
    sources: loadSources(),
    http,
    store,
    notifier,
    roleFilter: loadRoleFilter(),
  });
  return { ok: true };
}
```
NOTE: `loadSources()`/`loadRoleFilter()` read `sources.json`/`roles.json` relative to `process.cwd()`. The bundle zip includes these files at the root (Terraform packages them — see Task 4), and Lambda sets cwd to the task root, so they resolve.

- [ ] **Step 6: Run tests, typecheck, and verify the bundle builds**

Run: `npx vitest run test/secrets.test.ts` → PASS (2).
Run: `npx vitest run` → full suite green.
Run: `npm run typecheck` → clean.
Run: `npm run bundle` → produces `dist/lambda.mjs`. Verify it contains no `better-sqlite3`:
Run: `grep -c "better-sqlite3" dist/lambda.mjs || echo "0 (good)"` → expect `0 (good)`.

- [ ] **Step 7: Commit**

```bash
git add src/aws/secrets.ts src/lambda.ts test/secrets.test.ts package.json package-lock.json .gitignore
git commit -m "feat: Lambda handler + SSM secrets + esbuild bundle"
```

---

### Task 4: Terraform (bootstrap + app stack, no monitoring)

**Files:**
- Create: `infra/bootstrap/main.tf`, `infra/bootstrap/variables.tf`, `infra/bootstrap/outputs.tf`
- Create: `infra/app/main.tf`, `infra/app/dynamodb.tf`, `infra/app/lambda.tf`, `infra/app/eventbridge.tf`, `infra/app/ssm.tf`, `infra/app/variables.tf`, `infra/app/outputs.tf`, `infra/app/backend.tf`
- Create: `infra/README.md`

**Interfaces:**
- Consumes: the esbuild bundle at `dist/lambda.mjs` + `sources.json` + `roles.json` (packaged into the Lambda zip by Terraform's `archive_file`).
- Produces: outputs `lambda_function_name`, `state_table_name`, `deploy_role_arn`, `ssm_param_names`.

- [ ] **Step 1: `infra/bootstrap/` — remote state, OIDC, deploy role**

`infra/bootstrap/variables.tf`:
```hcl
variable "region" { type = string, default = "ap-south-1" }
variable "github_repo" { type = string, description = "owner/repo, e.g. lucy-04/ATSCronJOB" }
variable "state_bucket_name" { type = string, description = "Globally-unique S3 bucket for Terraform state" }
```
`infra/bootstrap/main.tf`:
```hcl
terraform {
  required_version = ">= 1.6"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }
}
provider "aws" { region = var.region }

# --- Remote state backend resources ---
resource "aws_s3_bucket" "tfstate" { bucket = var.state_bucket_name }
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_dynamodb_table" "tflock" {
  name         = "ats-poller-tf-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute { name = "LockID", type = "S" }
}

# --- GitHub Actions OIDC provider + deploy role ---
data "aws_iam_openid_connect_provider" "existing" { url = "https://token.actions.githubusercontent.com" }
# If the provider does not already exist in the account, create it instead of the data lookup:
#   resource "aws_iam_openid_connect_provider" "github" {
#     url             = "https://token.actions.githubusercontent.com"
#     client_id_list  = ["sts.amazonaws.com"]
#     thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
#   }

resource "aws_iam_role" "deploy" {
  name = "ats-poller-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.existing.arn }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main" }
      }
    }]
  })
}
# Deploy role needs to manage the app stack. Scope tightened later; PowerUser-ish for v1.
resource "aws_iam_role_policy_attachment" "deploy_admin" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}
resource "aws_iam_role_policy" "deploy_iam" {
  name = "ats-poller-deploy-iam"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["iam:*"], Resource = "*" }]
  })
}
```
`infra/bootstrap/outputs.tf`:
```hcl
output "deploy_role_arn"    { value = aws_iam_role.deploy.arn }
output "state_bucket_name"  { value = aws_s3_bucket.tfstate.bucket }
output "state_lock_table"   { value = aws_dynamodb_table.tflock.name }
```

- [ ] **Step 2: `infra/app/backend.tf` — remote state (values filled at init)**

```hcl
terraform {
  required_version = ">= 1.6"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" }, archive = { source = "hashicorp/archive", version = "~> 2.4" } }
  backend "s3" {
    key            = "ats-poller/app.tfstate"
    dynamodb_table = "ats-poller-tf-lock"
    # bucket + region passed via `terraform init -backend-config=...`
  }
}
provider "aws" { region = var.region }
```
`infra/app/variables.tf`:
```hcl
variable "region" { type = string, default = "ap-south-1" }
```

- [ ] **Step 3: `infra/app/dynamodb.tf` — state table with TTL**

```hcl
resource "aws_dynamodb_table" "state" {
  name         = "ats-poller-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute { name = "pk", type = "S" }
  attribute { name = "sk", type = "S" }
  ttl { attribute_name = "expires_at", enabled = true }
}
```

- [ ] **Step 4: `infra/app/ssm.tf` — SecureString params (values set out-of-band)**

```hcl
# Created empty; the operator sets values with `aws ssm put-parameter --overwrite`.
# lifecycle ignore_changes[value] so Terraform never manages/echoes the secret.
resource "aws_ssm_parameter" "bot_token" {
  name  = "/ats-poller/telegram-bot-token"
  type  = "SecureString"
  value = "PLACEHOLDER"
  lifecycle { ignore_changes = [value] }
}
resource "aws_ssm_parameter" "chat_id" {
  name  = "/ats-poller/telegram-chat-id"
  type  = "SecureString"
  value = "PLACEHOLDER"
  lifecycle { ignore_changes = [value] }
}
```

- [ ] **Step 5: `infra/app/lambda.tf` — package + function + role**

```hcl
# Package the esbuild output + config files into the zip.
data "archive_file" "lambda" {
  type        = "zip"
  output_path = "${path.module}/.build/lambda.zip"
  source_dir  = "${path.module}/../../dist"     # dist/lambda.mjs
}
# NOTE: sources.json/roles.json are copied into dist/ by the bundle step (see plan Task 5 CI + runbook).

resource "aws_iam_role" "lambda" {
  name = "ats-poller-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "lambda_inline" {
  name = "ats-poller-lambda-inline"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem","dynamodb:BatchGetItem","dynamodb:BatchWriteItem","dynamodb:PutItem"], Resource = aws_dynamodb_table.state.arn },
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = [aws_ssm_parameter.bot_token.arn, aws_ssm_parameter.chat_id.arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = "*" }
    ]
  })
}
resource "aws_lambda_function" "poller" {
  function_name    = "ats-poller"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "lambda.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 60
  memory_size      = 256
  environment { variables = { STATE_TABLE = aws_dynamodb_table.state.name } }
}
```

- [ ] **Step 6: `infra/app/eventbridge.tf` — hourly trigger**

```hcl
resource "aws_cloudwatch_event_rule" "hourly" {
  name                = "ats-poller-hourly"
  schedule_expression = "rate(1 hour)"
}
resource "aws_cloudwatch_event_target" "lambda" {
  rule = aws_cloudwatch_event_rule.hourly.name
  arn  = aws_lambda_function.poller.arn
}
resource "aws_lambda_permission" "events" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.poller.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.hourly.arn
}
```
`infra/app/outputs.tf`:
```hcl
output "lambda_function_name" { value = aws_lambda_function.poller.function_name }
output "state_table_name"     { value = aws_dynamodb_table.state.name }
```

- [ ] **Step 7: Format-check and commit**

Run (if terraform is installed): `terraform -chdir=infra/bootstrap fmt -check` and `terraform -chdir=infra/app fmt -check`. If terraform is NOT installed locally, skip — the operator runs `terraform validate` during deploy.
```bash
git add infra/
git commit -m "feat: Terraform for AWS core deploy (bootstrap + app stack)"
```

---

### Task 5: CI/CD deploy workflow, disable old cron, operator runbook

**Files:**
- Create: `.github/workflows/deploy.yml`, `docs/aws-deployment.md`
- Modify: `.github/workflows/poll.yml` (disable the hourly cron), `package.json` (add a `prebundle` copy step)

**Interfaces:**
- Consumes: `infra/app` Terraform, `npm run bundle`, the bootstrap outputs (deploy role ARN, state bucket).

- [ ] **Step 1: Ensure the Lambda zip carries the config files — `package.json`**

The Lambda handler reads `sources.json`/`roles.json` from cwd, so they must be in `dist/`. Add a copy that runs before bundling:
```json
"prebundle": "mkdir -p dist && cp sources.json roles.json dist/",
"bundle": "esbuild src/lambda.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/lambda.mjs --external:@aws-sdk/*"
```
(`npm run bundle` triggers `prebundle` automatically.) Re-run `npm run bundle` and confirm `dist/` contains `lambda.mjs`, `sources.json`, `roles.json`.

- [ ] **Step 2: Write `.github/workflows/deploy.yml`**

```yaml
name: deploy
on:
  push:
    branches: [main]
    paths: ["src/**", "infra/**", "sources.json", "roles.json", "package.json", ".github/workflows/deploy.yml"]
  workflow_dispatch:
permissions:
  id-token: write   # for OIDC
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      AWS_REGION: ap-south-1
      TF_STATE_BUCKET: ${{ vars.TF_STATE_BUCKET }}
      DEPLOY_ROLE_ARN: ${{ vars.DEPLOY_ROLE_ARN }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: "npm" }
      - run: npm ci
      - run: npm test
      - run: npm run bundle
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
      - uses: hashicorp/setup-terraform@v3
      - name: Terraform apply
        run: |
          terraform -chdir=infra/app init -backend-config="bucket=$TF_STATE_BUCKET" -backend-config="region=$AWS_REGION"
          terraform -chdir=infra/app apply -auto-approve
```

- [ ] **Step 3: Disable the old poll cron in `.github/workflows/poll.yml`**

Comment out (or remove) the `schedule:` trigger so it no longer runs hourly, keeping `workflow_dispatch` for manual/local fallback. Add a comment: `# Hourly polling moved to AWS Lambda (see docs/aws-deployment.md). Manual-only now.`

- [ ] **Step 4: Write `docs/aws-deployment.md` (operator runbook)**

Include, as copy-paste commands: install AWS CLI + Terraform; `aws configure` with an admin/bootstrap user; `terraform -chdir=infra/bootstrap init && terraform -chdir=infra/bootstrap apply -var github_repo=lucy-04/ATSCronJOB -var state_bucket_name=<unique>`; capture the `deploy_role_arn` + `state_bucket_name` outputs; set GitHub repo **variables** `DEPLOY_ROLE_ARN` and `TF_STATE_BUCKET`; put secrets `aws ssm put-parameter --name /ats-poller/telegram-bot-token --type SecureString --value <token> --overwrite` (and chat id); first app deploy either by pushing to main or `npm run bundle && terraform -chdir=infra/app init -backend-config=... && terraform -chdir=infra/app apply`; smoke test `aws lambda invoke --function-name ats-poller /dev/stdout` twice (first seeds silently, second delivers); inspect the DynamoDB table (`aws dynamodb scan --table-name ats-poller-state --max-items 5`). Note the ~$0 cost and the ap-south-1 region.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml .github/workflows/poll.yml docs/aws-deployment.md package.json
git commit -m "feat: CI/CD deploy workflow (OIDC), disable old cron, operator runbook"
```

---

## Self-Review

**Spec coverage:**
- Lambda + EventBridge hourly → Task 4 (`aws_lambda_function` + `aws_cloudwatch_event_rule rate(1 hour)`). ✓
- DynamoDB dedup with TTL prune → Task 2 (store) + Task 4 (table + TTL). ✓
- Promisified StateStore → Task 1. ✓
- SSM secrets, Lambda reads at runtime → Task 3 (`secrets.ts`, handler) + Task 4 (params + IAM). ✓
- esbuild bundle, no native deps → Task 3 (bundle + grep check). ✓
- Terraform bootstrap (S3 state + OIDC + deploy role) + app stack → Task 4. ✓
- CI/CD via OIDC, disable old cron → Task 5. ✓
- Reuse engine unchanged → only `poll.ts` gains awaits (Task 1); adapters/filter/notifier untouched. ✓
- Monitoring → intentionally deferred to Plan 2 (CloudWatch alarms/SNS/dashboard/EMF). ✓ (out of scope here)

**Placeholder scan:** SSM `value = "PLACEHOLDER"` is intentional (with `ignore_changes`), not a plan placeholder. The bootstrap OIDC-provider `data` vs `resource` choice is documented inline (use the resource block if the provider doesn't already exist in the account) — the operator picks one during bootstrap. No TBD/TODO in code steps.

**Type consistency:** `StateStore` async signatures (Task 1) match `createDynamoStore`'s implementation (Task 2) and the handler's `await poll(...)`. `DynamoStoreOptions` fields (`tableName`, `client`, `now`, `graceDays`) are used identically in the test and impl. `getTelegramCreds(client?)` signature matches its test and the handler call.

**Note on Terraform verification:** terraform/aws CLIs are not installed in the build environment, so Tasks 4–5 are verified by careful review + `fmt`/`validate` where available; the operator's `terraform init/validate/plan/apply` is the real gate (documented in the runbook). Tasks 1–3 are fully verified locally (vitest + typecheck + `npm run bundle`).
