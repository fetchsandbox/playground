output "load_balancer_dns" {
  description = "Point your DNS record (matching the ACM certificate) at this."
  value       = aws_lb.main.dns_name
}

output "webhook_paths" {
  description = "Configure these on https://<your domain>."
  value = {
    slack_events       = "/webhooks/slack/events"
    slack_interactions = "/webhooks/slack/interactions"
    gmail_push         = "/webhooks/gmail?token=<GMAIL_PUSH_TOKEN>"
  }
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "app_secret_arn" {
  description = "Populate with the JSON keys in var.app_secret_keys."
  value       = aws_secretsmanager_secret.app.arn
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "jobs_queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "dead_letter_queue_url" {
  value = aws_sqs_queue.dlq.url
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
