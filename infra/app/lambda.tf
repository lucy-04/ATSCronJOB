# Package the esbuild output + config files into the Lambda zip.
# `dist/` is produced by `npm run bundle` (runs `prebundle` to copy sources.json/roles.json),
# so it contains: lambda.mjs, sources.json, roles.json. Run the bundle BEFORE terraform apply.
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../../dist"
  output_path = "${path.module}/.build/lambda.zip"
}

resource "aws_iam_role" "lambda" {
  name = "ats-poller-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Least-privilege: only this table, only the two SSM params, KMS decrypt for the SecureStrings.
resource "aws_iam_role_policy" "lambda_inline" {
  name = "ats-poller-lambda-inline"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.state.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [aws_ssm_parameter.bot_token.arn, aws_ssm_parameter.chat_id.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_lambda_function" "poller" {
  function_name    = "ats-poller"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "lambda.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      STATE_TABLE = aws_dynamodb_table.state.name
    }
  }
}

# CloudWatch log group with a short retention (monitoring/alarms come in Plan 2).
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${aws_lambda_function.poller.function_name}"
  retention_in_days = 14
}
