resource "google_firestore_database" "default" {
  provider                = google-beta
  project                 = var.gcp_project_id
  name                    = "(default)"
  location_id             = var.gcp_region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  depends_on              = [google_firebase_project.default]
}

resource "google_project_service" "firestore" {
  project = var.gcp_project_id
  service = "firestore.googleapis.com"
}

resource "google_project_service" "cloudfunctions" {
  project = var.gcp_project_id
  service = "cloudfunctions.googleapis.com"
}

resource "google_project_service" "cloudbuild" {
  project = var.gcp_project_id
  service = "cloudbuild.googleapis.com"
}

resource "google_project_service" "cloudrun" {
  project = var.gcp_project_id
  service = "run.googleapis.com"
}

resource "google_project_service" "artifactregistry" {
  project = var.gcp_project_id
  service = "artifactregistry.googleapis.com"
}

resource "google_project_service" "secretmanager" {
  project = var.gcp_project_id
  service = "secretmanager.googleapis.com"
}
