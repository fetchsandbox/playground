# --- PostgreSQL (RDS) ------------------------------------------------------------
# The master password is generated and rotated by RDS in Secrets Manager; it
# never appears in Terraform state.

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = local.name
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "main" {
  identifier                            = local.name
  engine                                = "postgres"
  engine_version                        = "16"
  instance_class                        = var.db_instance_class
  allocated_storage                     = var.db_allocated_storage_gb
  max_allocated_storage                 = var.db_allocated_storage_gb * 4
  storage_type                          = "gp3"
  storage_encrypted                     = true
  db_name                               = "quote_agent"
  username                              = "quote_agent"
  manage_master_user_password           = true
  db_subnet_group_name                  = aws_db_subnet_group.main.name
  vpc_security_group_ids                = [aws_security_group.db.id]
  parameter_group_name                  = aws_db_parameter_group.main.name
  multi_az                              = var.db_multi_az
  publicly_accessible                   = false
  backup_retention_period               = var.db_backup_retention_days
  backup_window                         = "03:00-04:00"
  maintenance_window                    = "sun:04:30-sun:05:30"
  auto_minor_version_upgrade            = true
  deletion_protection                   = var.db_deletion_protection
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${local.name}-final"
  copy_tags_to_snapshot                 = true
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql"]
}

# --- Job queue (SQS) ---------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days to investigate
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${local.name}-jobs"
  visibility_timeout_seconds = 180 # > worst-case job (provider retries honour Retry-After)
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}

# --- Application secrets -------------------------------------------------------------
# Terraform creates the container only. Populate it once (and on rotation):
#   aws secretsmanager put-secret-value --secret-id <arn> --secret-string file://secrets.json
# Every key in var.app_secret_keys must exist (an empty string is fine for unused providers),
# otherwise ECS cannot start the task.

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  description             = "quote-agent provider credentials and admin token (JSON)"
  recovery_window_in_days = 7
}
