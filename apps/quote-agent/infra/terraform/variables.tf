variable "region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  description = "staging or production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "image_tag" {
  description = "Image tag in the ECR repository to deploy (CI passes the git SHA)."
  type        = string
}

variable "domain_certificate_arn" {
  description = "ACM certificate ARN for the public HTTPS listener (Slack and Pub/Sub require HTTPS)."
  type        = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "single_nat_gateway" {
  description = "One NAT gateway (cheaper) instead of one per AZ (survives an AZ outage)."
  type        = bool
  default     = false
}

# --- capacity -----------------------------------------------------------------

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_min_count" {
  type    = number
  default = 1
}

variable "worker_max_count" {
  type    = number
  default = 6
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "worker_cpu" {
  type    = number
  default = 512
}

variable "worker_memory" {
  type    = number
  default = 1024
}

# --- database -----------------------------------------------------------------

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "db_backup_retention_days" {
  type    = number
  default = 14
}

# --- application ----------------------------------------------------------------

variable "app_config" {
  description = "Non-secret environment for the app, e.g. SLACK_MANAGER_CHANNEL, SLACK_MANAGER_USER_IDS, GMAIL_ADDRESS, GMAIL_PUBSUB_TOPIC, HUBSPOT_PIPELINE, COMPANY_NAME, DISCOUNT_* thresholds."
  type        = map(string)
  default     = {}
}

variable "app_secret_keys" {
  description = "Keys that must exist in the app secret (JSON). Values are set outside Terraform so they never enter state."
  type        = list(string)
  default = [
    "ANTHROPIC_API_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "HUBSPOT_ACCESS_TOKEN",
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
    "GMAIL_PUSH_TOKEN",
    "QUOTE_AGENT_ADMIN_TOKEN",
    "HANDOFF_API_TOKEN",
    "HANDOFF_HUBSPOT_TOKEN",
    "STRIPE_SECRET_KEY",
    "RESEND_API_KEY",
    "RESEARCH_HUBSPOT_TOKEN",
  ]
}

variable "enable_gmail_watch_schedule" {
  description = "Renew the Gmail push watch daily (needs GMAIL_PUBSUB_TOPIC in app_config)."
  type        = bool
  default     = true
}

# --- operations -----------------------------------------------------------------

variable "alarm_email" {
  description = "Email subscribed to the alarm SNS topic (empty = no subscription)."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "enable_waf" {
  type    = bool
  default = true
}

variable "waf_rate_limit_per_5min" {
  description = "Requests per 5 minutes per IP before WAF blocks."
  type        = number
  default     = 2000
}
