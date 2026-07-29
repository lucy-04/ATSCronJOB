# Hourly trigger. Matches the production GitHub Actions cron cadence.
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
