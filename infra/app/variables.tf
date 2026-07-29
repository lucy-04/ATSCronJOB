variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "grace_days" {
  type        = number
  description = "Dedup TTL window in days (must match the Lambda's default of 14)."
  default     = 14
}
