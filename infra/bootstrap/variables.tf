variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "github_repo" {
  type        = string
  description = "GitHub owner/repo that is allowed to assume the deploy role, e.g. lucy-04/ATSCronJOB"
}

variable "github_branch" {
  type        = string
  description = "Branch the deploy workflow runs from (the isolated AWS lab lives here)."
  default     = "aws-deploy"
}

variable "state_bucket_name" {
  type        = string
  description = "Globally-unique S3 bucket name to hold Terraform remote state."
}

variable "create_oidc_provider" {
  type        = bool
  description = "Set true if the GitHub Actions OIDC provider does NOT already exist in this account."
  default     = false
}
