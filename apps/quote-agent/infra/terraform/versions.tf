terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # Remote state: create the bucket and lock table once, then
  #   terraform init -backend-config=backend.hcl
  # with backend.hcl holding bucket, key, region, dynamodb_table, encrypt = true.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Application = "quote-agent"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }

locals {
  name       = "quote-agent-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  azs        = slice(data.aws_availability_zones.available.names, 0, 2)
  image      = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
}
