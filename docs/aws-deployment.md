# AWS Deployment Runbook (isolated lab)

This deploys the poller to **AWS Lambda + EventBridge + DynamoDB**, provisioned by **Terraform**, deployable via **GitHub Actions OIDC** — a hands-on/resume lab you stand up, verify, screenshot, and tear down.

> **This does not touch production.** The live poller keeps running on the GitHub Actions hourly cron (`.github/workflows/poll.yml`) with SQLite state on the `state` branch. This lab lives only on the **`aws-deploy`** branch and is deployed **manually**. Cost is **~$0** — every resource is pay-per-use with no idle charge (no VPC/RDS/NAT/load-balancer).

**Region:** `ap-south-1` (Mumbai). **Work from the `aws-deploy` branch:** `git checkout aws-deploy`.

---

## 0. Prerequisites (one-time, your machine)

```bash
# AWS CLI + Terraform
brew install awscli terraform            # macOS; or see the official installers
aws configure                            # use an admin/bootstrap IAM user's access keys + region ap-south-1
terraform -version                       # >= 1.6
node -v                                  # >= 20
```
You need an AWS account. A brand-new account is fine and stays in the free tier for this.

---

## 1. Bootstrap (once) — remote state, OIDC, deploy role

Pick a **globally-unique** S3 bucket name (e.g. `ats-poller-tfstate-<your-initials>-<digits>`).

```bash
cd infra/bootstrap
terraform init
terraform apply \
  -var github_repo=lucy-04/ATSCronJOB \
  -var state_bucket_name=<your-unique-bucket>
# If your account has NO GitHub OIDC provider yet, add:  -var create_oidc_provider=true
```
Copy the two outputs:
```bash
terraform output deploy_role_arn      # -> GitHub repo variable DEPLOY_ROLE_ARN
terraform output state_bucket_name    # -> GitHub repo variable TF_STATE_BUCKET
```
In GitHub: **Settings → Secrets and variables → Actions → Variables** → add `DEPLOY_ROLE_ARN` and `TF_STATE_BUCKET`.

---

## 2. Put the Telegram secrets in SSM

Reuse the same bot token + chat id already in your GitHub secrets (or make a new bot). These never enter Terraform state.

```bash
aws ssm put-parameter --name /ats-poller/telegram-bot-token --type SecureString --value "<BOT_TOKEN>" --overwrite
aws ssm put-parameter --name /ats-poller/telegram-chat-id   --type SecureString --value "<CHAT_ID>"   --overwrite
```

---

## 3. Deploy the app stack

**Option A — via GitHub Actions (the CI/CD path, recommended for the resume story):**
Actions tab → **deploy-aws** → **Run workflow** → branch `aws-deploy`. It runs tests, bundles, assumes the OIDC role, and applies Terraform. Watch it go green.

**Option B — locally:**
```bash
npm ci
npm run bundle                          # builds dist/lambda.mjs (+ sources.json/roles.json)
cd infra/app
terraform init \
  -backend-config="bucket=<your-unique-bucket>" \
  -backend-config="region=ap-south-1"
terraform apply
```

---

## 4. Smoke test (prove it works)

```bash
# First invoke: brand-new DynamoDB table -> every source seeds SILENTLY (no Telegram).
aws lambda invoke --function-name ats-poller --region ap-south-1 /dev/stdout

# See the seeded dedup items (note the future `expires_at` = TTL):
aws dynamodb scan --table-name ats-poller-state --region ap-south-1 --max-items 5

# Second invoke (or wait for the hourly EventBridge run): only genuinely-new roles hit Telegram.
aws lambda invoke --function-name ats-poller --region ap-south-1 /dev/stdout
```
Look at **CloudWatch → Log groups → /aws/lambda/ats-poller** to see the per-source summary lines. This is the moment to screenshot for your portfolio: the Lambda config, the EventBridge rule, the DynamoDB items, the CloudWatch logs.

---

## 5. Teardown (do this when done → guarantees $0)

The stack has no idle-cost resources, so even left running it's ~$0 — but destroying removes everything cleanly (a good DevOps habit to demonstrate):

```bash
cd infra/app
terraform destroy                       # removes Lambda, DynamoDB, EventBridge, SSM params, IAM, logs
cd ../bootstrap
# empty the state bucket first if destroy complains it's not empty:
aws s3 rm s3://<your-unique-bucket> --recursive
terraform destroy                       # removes the state bucket, lock table, OIDC deploy role
```

---

## What this demonstrates (for interviews)

- **AWS serverless**: Lambda (Node 20, esbuild-bundled) on an **EventBridge** hourly schedule.
- **Managed data**: **DynamoDB** for dedup, using **TTL** to auto-expire stale state (no cron cleanup).
- **IaC**: **Terraform**, split into a bootstrap tier (remote S3 state + lock) and an app tier.
- **CI/CD to AWS**: **GitHub Actions** assuming an IAM role via **OIDC** — no long-lived credentials.
- **Secrets**: **SSM Parameter Store** SecureStrings, read by the Lambda at runtime; never in code or state.
- **Operational judgment**: kept production on its proven GitHub Actions cron; built AWS as an isolated, destroyable lab.

(Monitoring & alerting — CloudWatch alarms + SNS — are added in Plan 2.)
