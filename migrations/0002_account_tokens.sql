-- Email-based account setup and password reset.
--   account_tokens: one row per invite or reset link. Only a SHA-256 hash of the link's secret is stored,
--   so reading the database never reveals a working link. Links are single use and expire.
--   auth_throttle: counts "forgot password" requests per email address and per network address
--   (both stored as hashes) so the public form cannot be used to flood anyone's inbox.
-- Neither table is part of the nightly backup (see docs/SECURITY.md); restoring them would only bring back dead links.

CREATE TABLE account_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  token_hash TEXT NOT NULL,       -- SHA-256 (hex) of the secret in the link
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT                 -- the administrator who triggered it; NULL when the person asked for it themselves
);
CREATE UNIQUE INDEX idx_account_tokens_hash ON account_tokens (token_hash);
CREATE INDEX idx_account_tokens_user ON account_tokens (user_id, purpose);

CREATE TABLE auth_throttle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- 'forgot_email' | 'forgot_ip'
  k TEXT NOT NULL,                -- SHA-256 (hex) of the email or address
  at_ms INTEGER NOT NULL
);
CREATE INDEX idx_auth_throttle ON auth_throttle (kind, k, at_ms);
