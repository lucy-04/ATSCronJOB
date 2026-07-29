output "lambda_function_name" {
  value = aws_lambda_function.poller.function_name
}

output "state_table_name" {
  value = aws_dynamodb_table.state.name
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.lambda.name
}
