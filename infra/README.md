# Terraform — ATS Poller AWS lab

Two tiers. **Isolated lab on the `aws-deploy` branch — the production poller stays on the GitHub Actions cron (`main`), untouched.** Full step-by-step in [`../docs/aws-deployment.md`](../docs/aws-deployment.md).

- **`bootstrap/`** — applied **once, locally, with admin creds**. Creates the S3 remote-state bucket + DynamoDB lock table, the GitHub Actions OIDC provider (or references an existing one via `create_oidc_provider`), and the `ats-poller-deploy` role GitHub Actions assumes. Uses **local** state.
- **`app/`** — the application stack (S3 **remote** backend). DynamoDB state table (TTL prune), the Lambda (from `dist/`), the hourly EventBridge rule, SSM SecureString params, the Lambda execution role, and the log group. Applied by the `deploy-aws` GitHub workflow (manual) or locally.

Everything is pay-per-use with **zero idle cost** (no VPC/RDS/NAT). Tear down with `terraform destroy` in `app/` then `bootstrap/`.
