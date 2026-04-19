variable "environment" {
  description = "Deployment environment (dev or prod)"
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be 'dev' or 'prod'."
  }
}

variable "gcp_project_id" {
  description = "GCP project ID"
  type        = string
}

variable "gcp_project_number" {
  description = "GCP project number"
  type        = string
}

variable "gcp_region" {
  description = "GCP region for resources"
  type        = string
  default     = "us-central1"
}

variable "allowed_domains" {
  description = "Domains allowed for reCAPTCHA Enterprise App Check"
  type        = list(string)
  default     = ["tradequt.com", "www.tradequt.com", "dev.tradequt.com", "localhost"]
}

variable "cicd_service_account" {
  description = "Service account email for CI/CD deployments"
  type        = string
  default     = "tradequt-cicd@gen-lang-client-0672520490.iam.gserviceaccount.com"
}
