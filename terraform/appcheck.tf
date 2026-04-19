resource "google_project_service" "recaptcha_enterprise" {
  project = var.gcp_project_id
  service = "recaptchaenterprise.googleapis.com"
}

resource "google_recaptcha_enterprise_key" "app_check" {
  display_name = "TradeQut ${var.environment}"
  project      = var.gcp_project_id

  web_settings {
    integration_type  = "SCORE"
    allowed_domains   = var.allowed_domains
  }

  depends_on = [google_project_service.recaptcha_enterprise]
}

resource "google_firebase_app_check_recaptcha_enterprise_config" "default" {
  provider  = google-beta
  project   = var.gcp_project_id
  app_id    = google_firebase_web_app.tradequt.app_id
  site_key  = google_recaptcha_enterprise_key.app_check.key_id
  token_ttl = "3600s"

  depends_on = [google_firebase_project.default]
}
