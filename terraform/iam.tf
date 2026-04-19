resource "google_project_iam_member" "cicd_functions_developer" {
  project = var.gcp_project_id
  role    = "roles/cloudfunctions.developer"
  member  = "serviceAccount:${var.cicd_service_account}"
}

resource "google_project_iam_member" "cicd_firebase_admin" {
  project = var.gcp_project_id
  role    = "roles/firebase.admin"
  member  = "serviceAccount:${var.cicd_service_account}"
}

resource "google_project_iam_member" "functions_firestore" {
  project = var.gcp_project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${var.gcp_project_id}@appspot.gserviceaccount.com"
}
