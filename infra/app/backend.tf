terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
  backend "s3" {
    key            = "ats-poller/app.tfstate"
    dynamodb_table = "ats-poller-tf-lock"
    # bucket + region are supplied at init time:
    #   terraform init -backend-config="bucket=<state_bucket_name>" -backend-config="region=ap-south-1"
  }
}

provider "aws" {
  region = var.region
}
