output "deploy_role_arn" {
  description = "Set this as the GitHub Actions repo variable DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}

output "state_bucket_name" {
  description = "Set this as the GitHub Actions repo variable TF_STATE_BUCKET, and pass to `terraform init -backend-config`."
  value       = aws_s3_bucket.tfstate.bucket
}

output "state_lock_table" {
  value = aws_dynamodb_table.tflock.name
}
