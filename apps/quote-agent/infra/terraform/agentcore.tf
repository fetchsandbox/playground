# Amazon Bedrock AgentCore Runtime: what the runtime needs from this stack.
#
# AgentCore runs the `agentcore` image target (linux/arm64, port 8080) in
# per-session microVMs. This file creates the pieces it needs to run inside
# this VPC next to the database:
#   - an execution role AgentCore assumes (pull the image, write logs, read the app and DB secrets, use SQS)
#   - a security group for the runtime's network interfaces, allowed into PostgreSQL and the VPC endpoints
#
# The runtime itself is created by infra/agentcore/deploy.py (boto3,
# bedrock-agentcore-control). The pinned AWS provider (~> 5.70) has no
# AgentCore resources. The script takes this file's outputs.

variable "agentcore_enabled" {
  description = "Create the AgentCore Runtime execution role and security group."
  type        = bool
  default     = false
}

locals {
  agentcore = var.agentcore_enabled ? toset(["this"]) : toset([])
}

resource "aws_security_group" "agentcore" {
  for_each    = local.agentcore
  name        = "${local.name}-agentcore"
  description = "AgentCore Runtime network interfaces"
  vpc_id      = aws_vpc.main.id
  egress {
    description = "Providers (HubSpot, Stripe, Resend, Slack, Gmail, Claude) via NAT, and AWS endpoints"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_iam_policy_document" "agentcore_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock-agentcore:${var.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "agentcore" {
  for_each           = local.agentcore
  name               = "${local.name}-agentcore"
  assume_role_policy = data.aws_iam_policy_document.agentcore_assume.json
}

data "aws_iam_policy_document" "agentcore" {
  statement {
    sid       = "PullImage"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"]
  }
  statement {
    sid       = "Secrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn, local.db_secret_arn]
  }
  statement {
    sid       = "JobsQueue"
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.jobs.arn]
  }
  statement {
    sid       = "Telemetry"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "cloudwatch:PutMetricData"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "agentcore" {
  for_each = local.agentcore
  name     = "agentcore-runtime"
  role     = aws_iam_role.agentcore[each.key].id
  policy   = data.aws_iam_policy_document.agentcore.json
}

output "agentcore" {
  description = "Inputs for infra/agentcore/deploy.py (null when agentcore_enabled = false)."
  value = var.agentcore_enabled ? {
    role_arn           = aws_iam_role.agentcore["this"].arn
    security_group_ids = [aws_security_group.agentcore["this"].id]
    subnet_ids         = aws_subnet.private[*].id
    ecr_repository_url = aws_ecr_repository.app.repository_url
    app_secret_arn     = aws_secretsmanager_secret.app.arn
    db_secret_arn      = local.db_secret_arn
    db_host            = aws_db_instance.main.address
    db_port            = tostring(aws_db_instance.main.port)
    db_name            = aws_db_instance.main.db_name
    jobs_queue_url     = aws_sqs_queue.jobs.url
    region             = var.region
    environment        = var.environment
  } : null
}
