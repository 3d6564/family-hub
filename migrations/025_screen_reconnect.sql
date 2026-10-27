ALTER TABLE display_pairings ADD COLUMN reconnect_session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE display_pairings ADD COLUMN reconnect_token_hash TEXT;
