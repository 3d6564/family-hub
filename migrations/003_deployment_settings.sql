CREATE TABLE deployment_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  google_client_id TEXT NOT NULL,
  encrypted_google_client_secret TEXT NOT NULL,
  google_redirect_uri TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
