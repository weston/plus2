variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "plus2"
}

variable "environment" {
  description = "Environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "db_username" {
  description = "Database master username"
  type        = string
  default     = "plus2admin"
  sensitive   = true
}

variable "db_password" {
  description = "Database master password"
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT secret for API authentication"
  type        = string
  sensitive   = true
}

# OAuth credentials (optional — empty = that provider stays disabled / returns 503).
# Set the real values in terraform.tfvars (gitignored) or via TF_VAR_*.
variable "google_client_id" {
  description = "Google OAuth client ID"
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "wca_client_id" {
  description = "WCA OAuth application UID"
  type        = string
  default     = ""
}

variable "wca_client_secret" {
  description = "WCA OAuth application secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "api_image_tag" {
  description = "Docker image tag for API"
  type        = string
  default     = "latest"
}

# Cost optimization settings
variable "api_cpu" {
  description = "Fargate CPU units (256 = 0.25 vCPU)"
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory in MB"
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "Number of API tasks to run"
  type        = number
  default     = 1
}

variable "use_fargate_spot" {
  description = "Use Fargate Spot for cost savings"
  type        = bool
  default     = true
}
