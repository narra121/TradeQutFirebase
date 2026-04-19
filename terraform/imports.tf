# One-time imports of existing resources into this Terraform state.
# These resources were previously managed by JournalAWSSetup/terraform/gcp/
# with state prefix "gcp-wif". This repo uses prefix "firebase".
# After successful import (first apply), remove this file.

import {
  to = google_firebase_project.default
  id = "projects/gen-lang-client-0672520490"
}

import {
  to = google_firebase_web_app.tradequt
  id = "gen-lang-client-0672520490/1:256912042505:web:1634f72e12d870bcdf26d8"
}

import {
  to = google_project_service.firebase
  id = "gen-lang-client-0672520490/firebase.googleapis.com"
}

import {
  to = google_project_service.generativelanguage
  id = "gen-lang-client-0672520490/generativelanguage.googleapis.com"
}

import {
  to = google_project_service.identitytoolkit
  id = "gen-lang-client-0672520490/identitytoolkit.googleapis.com"
}

import {
  to = google_identity_platform_config.default
  id = "projects/gen-lang-client-0672520490/config"
}

