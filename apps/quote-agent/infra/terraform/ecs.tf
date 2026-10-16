# One image, three task definitions:
#   api    - webhooks behind the ALB; enqueues jobs
#   worker - consumes the SQS job queue, runs the workflow
#   job    - scheduled one-off commands (reap-stale-runs, gmail-watch)
# api and worker run `migrate` as an init container before starting, guarded by
# a Postgres advisory lock, so a deploy applies pending migrations exactly once.
# Migrations must stay backward compatible with the previous release (expand,
# then contract in a later release), because old tasks keep running during a
# rolling deploy.

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker", "job"])
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

locals {
  db_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn

  base_env = merge(var.app_config, {
    ENVIRONMENT   = var.environment
    LOG_FORMAT    = "json"
    AUTO_MIGRATE  = "false"
    QUEUE_BACKEND = "sqs"
    SQS_QUEUE_URL = aws_sqs_queue.jobs.url
    AWS_REGION    = var.region
    DB_HOST       = aws_db_instance.main.address
    DB_PORT       = tostring(aws_db_instance.main.port)
    DB_NAME       = aws_db_instance.main.db_name
    DB_SSLMODE    = "require"
  })
  environment = [for k in sort(keys(local.base_env)) : { name = k, value = local.base_env[k] }]

  secrets = concat(
    [for k in var.app_secret_keys : { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }],
    [
      { name = "DB_USER", valueFrom = "${local.db_secret_arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${local.db_secret_arn}:password::" },
    ],
  )

  container_base = {
    image                  = local.image
    environment            = local.environment
    secrets                = local.secrets
    readonlyRootFilesystem = true
    user                   = "10001:10001"
    linuxParameters        = { initProcessEnabled = true }
  }

  migrate_container = merge(local.container_base, {
    name      = "migrate"
    command   = ["migrate"]
    essential = false
  })
}

# --- IAM ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.app.arn, local.db_secret_arn]
    }]
  })
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "api" {
  name = "enqueue-jobs"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.jobs.arn }]
  })
}

resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "worker" {
  name = "consume-jobs"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
      Resource = aws_sqs_queue.jobs.arn
    }]
  })
}

resource "aws_iam_role" "job" {
  name               = "${local.name}-job"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# --- Task definitions ----------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([
    merge(local.migrate_container, { logConfiguration = local.log["api"] }),
    merge(local.container_base, {
      name             = "api"
      command          = ["api"]
      essential        = true
      portMappings     = [{ containerPort = 8000, protocol = "tcp" }]
      dependsOn        = [{ containerName = "migrate", condition = "SUCCESS" }]
      logConfiguration = local.log["api"]
      healthCheck = {
        command     = ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
    }),
  ])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([
    merge(local.migrate_container, { logConfiguration = local.log["worker"] }),
    merge(local.container_base, {
      name             = "worker"
      command          = ["worker"]
      essential        = true
      stopTimeout      = 120 # finish the in-flight batch on SIGTERM
      dependsOn        = [{ containerName = "migrate", condition = "SUCCESS" }]
      logConfiguration = local.log["worker"]
    }),
  ])
}

resource "aws_ecs_task_definition" "job" {
  family                   = "${local.name}-job"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.job.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([
    merge(local.container_base, {
      name             = "job"
      command          = ["reap-stale-runs"] # overridden per schedule
      essential        = true
      logConfiguration = local.log["job"]
    }),
  ])
}

locals {
  log = { for k, g in aws_cloudwatch_log_group.app : k => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = g.name
      awslogs-region        = var.region
      awslogs-stream-prefix = k
    }
  } }
}

# --- Services ------------------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60
  propagate_tags                     = "SERVICE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8000
  }
  lifecycle {
    ignore_changes = [desired_count] # owned by autoscaling
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker_min_count
  launch_type                        = "FARGATE"
  propagate_tags                     = "SERVICE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  lifecycle {
    ignore_changes = [desired_count]
  }
}

# --- Autoscaling ----------------------------------------------------------------------

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = var.api_desired_count * 3
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.worker_min_count
  max_capacity       = var.worker_max_count
}

resource "aws_appautoscaling_policy" "worker_backlog" {
  name               = "${local.name}-worker-backlog"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value       = 20 # visible jobs waiting
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    customized_metric_specification {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      statistic   = "Average"
      dimensions {
        name  = "QueueName"
        value = aws_sqs_queue.jobs.name
      }
    }
  }
}
