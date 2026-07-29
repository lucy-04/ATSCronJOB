# SecureString parameters created EMPTY. The operator sets the real values out-of-band:
#   aws ssm put-parameter --name /ats-poller/telegram-bot-token --type SecureString --value <token> --overwrite
#   aws ssm put-parameter --name /ats-poller/telegram-chat-id   --type SecureString --value <chatid> --overwrite
# lifecycle.ignore_changes[value] means Terraform never reads, manages, or echoes the secret in state.
resource "aws_ssm_parameter" "bot_token" {
  name  = "/ats-poller/telegram-bot-token"
  type  = "SecureString"
  value = "PLACEHOLDER-set-via-cli"
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "chat_id" {
  name  = "/ats-poller/telegram-chat-id"
  type  = "SecureString"
  value = "PLACEHOLDER-set-via-cli"
  lifecycle {
    ignore_changes = [value]
  }
}
