# --- Scheduled jobs (EventBridge Scheduler -> ECS RunTask) ------------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name = "run-job-task"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = ["${aws_ecs_task_definition.job.arn_without_revision}:*"]
        Condition = { ArnLike = { "ecs:cluster" = aws_ecs_cluster.main.arn } }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.execution.arn, aws_iam_role.job.arn]
      },
    ]
  })
}

locals {
  schedules = merge(
    { "reap-stale-runs" = "rate(5 minutes)" },
    var.enable_gmail_watch_schedule ? { "gmail-watch" = "rate(1 day)" } : {},
  )
}

resource "aws_scheduler_schedule" "job" {
  for_each            = local.schedules
  name                = "${local.name}-${each.key}"
  schedule_expression = each.value
  flexible_time_window { mode = "OFF" }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn
    input = jsonencode({
      containerOverrides = [{ name = "job", command = [each.key] }]
    })
    retry_policy {
      maximum_retry_attempts = each.key == "gmail-watch" ? 3 : 0
    }
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.job.arn_without_revision
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.tasks.id]
        assign_public_ip = false
      }
    }
  }
}

# --- Alarms ------------------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# Every log line at ERROR (failed runs, failed jobs, unparseable input) becomes a metric.
resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each       = aws_cloudwatch_log_group.app
  name           = "${local.name}-${each.key}-errors"
  log_group_name = each.value.name
  pattern        = "{ $.level = \"ERROR\" }"
  metric_transformation {
    name      = "AppErrors"
    namespace = "QuoteAgent/${var.environment}"
    value     = "1"
  }
}

locals {
  alarms = {
    dlq-not-empty = {
      description = "Jobs failed 5 times and were dead-lettered. Inspect, fix, then redrive the DLQ."
      namespace   = "AWS/SQS", metric = "ApproximateNumberOfMessagesVisible", statistic = "Maximum"
      dimensions  = { QueueName = aws_sqs_queue.dlq.name }, threshold = 0, periods = 1
    }
    jobs-backlog-age = {
      description = "Oldest queued job is over 5 minutes old: workers are down or not keeping up."
      namespace   = "AWS/SQS", metric = "ApproximateAgeOfOldestMessage", statistic = "Maximum"
      dimensions  = { QueueName = aws_sqs_queue.jobs.name }, threshold = 300, periods = 2
    }
    alb-5xx = {
      description = "API returned 5xx responses."
      namespace   = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", statistic = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }, threshold = 10, periods = 1
    }
    alb-unhealthy = {
      description = "API targets failing /ready."
      namespace   = "AWS/ApplicationELB", metric = "UnHealthyHostCount", statistic = "Maximum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
      threshold   = 0, periods = 3
    }
    app-errors = {
      description = "Application logged errors (failed workflow runs, failed jobs)."
      namespace   = "QuoteAgent/${var.environment}", metric = "AppErrors", statistic = "Sum"
      dimensions  = {}, threshold = 5, periods = 1
    }
    db-cpu = {
      description = "Database CPU high."
      namespace   = "AWS/RDS", metric = "CPUUtilization", statistic = "Average"
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }, threshold = 80, periods = 3
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "main" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  dimensions          = each.value.dimensions
  period              = 300
  evaluation_periods  = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${local.name}-db-free-storage"
  alarm_description   = "Database free storage below 5 GB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  period              = 300
  evaluation_periods  = 1
  threshold           = 5 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
