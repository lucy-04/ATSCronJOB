variable "region" {
  type    = string
  default = "ap-south-1"
}

# The dedup TTL window (14 days) is owned by the Lambda code (createDynamoStore's
# graceDays default). It is intentionally NOT a Terraform variable here, to avoid a
# silent drift trap where a TF value diverges from the code's actual TTL.
