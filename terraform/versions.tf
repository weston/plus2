terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Use local state by default - can switch to S3 backend later
  # This keeps it isolated from other projects
}
