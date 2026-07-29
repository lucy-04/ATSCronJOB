# Dedup state table. Partition = source key, sort = job_id (or the "#SOURCE" marker).
# expires_at is the TTL attribute; DynamoDB auto-deletes items not refreshed within grace_days,
# which is how the poller's 14-day prune is implemented (no manual delete).
resource "aws_dynamodb_table" "state" {
  name         = "ats-poller-state"
  billing_mode = "PAY_PER_REQUEST" # on-demand: zero idle cost
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}
