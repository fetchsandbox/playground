# Copy to <env>.tfvars and fill in. Secrets do NOT go here (see app_secret_arn output).
environment            = "staging"
region                 = "us-east-1"
image_tag              = "replace-with-git-sha"
domain_certificate_arn = "arn:aws:acm:us-east-1:111111111111:certificate/replace-me"
alarm_email            = "oncall@example.com"
single_nat_gateway     = true  # staging: save cost
db_multi_az            = false # staging: save cost
db_deletion_protection = false

app_config = {
  SLACK_MANAGER_CHANNEL  = "C0123456789"
  SLACK_MANAGER_USER_IDS = "U0123456789"
  SLACK_INTAKE_CHANNELS  = ""
  GMAIL_ADDRESS          = "sales@example.com"
  GMAIL_PUBSUB_TOPIC     = "projects/my-gcp-project/topics/gmail-quotes"
  HUBSPOT_PIPELINE       = "default"
  HUBSPOT_DEAL_STAGE     = "presentationscheduled"
  COMPANY_NAME           = "Northwind"
}

# Amazon Bedrock AgentCore Runtime: execution role + security group (runtime via infra/agentcore/deploy.py)
agentcore_enabled = false
