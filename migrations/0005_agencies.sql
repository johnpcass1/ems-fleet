-- Many agencies on one site.
--
-- Every row that belongs to an agency now carries agency_id, and the Worker filters on it for every read and write
-- (see docs/SECURITY.md, "Tenant isolation"). Existing data becomes the first agency, 'GEMA', through the column default.
-- Nothing is rebuilt or copied: only new columns, new indexes and one new table, so this is safe on a database with data in it.
--
-- Global on purpose (no agency_id):
--   counter       one change counter for the whole database. Every changed row gets the next number ("seq"); each browser asks for
--                 "my agency's rows newer than my cursor", so a shared counter only means the numbers have gaps for each agency.
--   auth_throttle counts "forgot password" requests by a hash of (agency, email) and by a hash of the network address.
--   backup_jobs   the nightly backup covers the whole database (all agencies) and is for the super user only.

CREATE TABLE agencies (
  id TEXT PRIMARY KEY,               -- the agency code people type at sign-in, upper case, e.g. 'GEMA'
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, -- 0: nobody in the agency can sign in and its sessions are deleted
  created_by TEXT,                   -- email of the super user who added it (NULL for the first agency)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (id = upper(id) AND length(id) BETWEEN 2 AND 20 AND id NOT GLOB '*[^A-Z0-9-]*')
);
INSERT INTO agencies (id, name, active, created_by, created_at, updated_at)
VALUES ('GEMA', 'GEMA', 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---- agency_id on every agency-owned table (existing rows are GEMA) ----
ALTER TABLE bases ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE pm_programs ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE pm_tasks ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE mechanics ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE parts ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE settings ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE vehicles ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE vehicle_pm ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE meter_readings ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE status_events ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE moves ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE issues ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE work_orders ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE work_order_lines ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE wo_issue_links ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE wo_pm_tasks ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE attachments ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE users ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE sessions ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';          -- the agency the account belongs to; a session never changes it
ALTER TABLE sessions ADD COLUMN acting_agency_id TEXT;                           -- super user only: the agency being viewed (NULL = their own)
ALTER TABLE audit_log ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE account_tokens ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE tombstones ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';
ALTER TABLE login_attempts ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'GEMA';

-- ---- settings: one row per agency, and its id IS the agency code (GEMA's row was 'main') ----
-- The row gets a new change number so a browser that is already open picks up the renamed record.
UPDATE counter SET v = v + 1 WHERE id = 1;
UPDATE settings SET id = 'GEMA', seq = (SELECT v FROM counter WHERE id = 1) WHERE id = 'main';

-- ---- uniqueness is now per agency ----
DROP INDEX idx_vehicles_unit;
CREATE UNIQUE INDEX idx_vehicles_unit ON vehicles (agency_id, lower(unit));
DROP INDEX idx_work_orders_number;
CREATE UNIQUE INDEX idx_work_orders_number ON work_orders (agency_id, number);
DROP INDEX idx_users_email;
CREATE UNIQUE INDEX idx_users_email ON users (agency_id, email);   -- email is COLLATE NOCASE, so this is case-insensitive too

-- ---- agency_id first, so each agency's reads stay fast however many agencies share the database ----
-- The old "seq" indexes are replaced (not kept) because every index costs a row write on every change.
DROP INDEX idx_bases_seq;          CREATE INDEX idx_bases_agency_seq ON bases (agency_id, seq);
DROP INDEX idx_pm_programs_seq;    CREATE INDEX idx_pm_programs_agency_seq ON pm_programs (agency_id, seq);
DROP INDEX idx_mechanics_seq;      CREATE INDEX idx_mechanics_agency_seq ON mechanics (agency_id, seq);
DROP INDEX idx_parts_seq;          CREATE INDEX idx_parts_agency_seq ON parts (agency_id, seq);
DROP INDEX idx_settings_seq;       CREATE INDEX idx_settings_agency_seq ON settings (agency_id, seq);
DROP INDEX idx_vehicles_seq;       CREATE INDEX idx_vehicles_agency_seq ON vehicles (agency_id, seq);
DROP INDEX idx_readings_seq;       CREATE INDEX idx_readings_agency_seq ON meter_readings (agency_id, seq);
DROP INDEX idx_status_events_seq;  CREATE INDEX idx_status_events_agency_seq ON status_events (agency_id, seq);
DROP INDEX idx_moves_seq;          CREATE INDEX idx_moves_agency_seq ON moves (agency_id, seq);
DROP INDEX idx_issues_seq;         CREATE INDEX idx_issues_agency_seq ON issues (agency_id, seq);
DROP INDEX idx_work_orders_seq;    CREATE INDEX idx_work_orders_agency_seq ON work_orders (agency_id, seq);
DROP INDEX idx_users_seq;          CREATE INDEX idx_users_agency_seq ON users (agency_id, seq);
DROP INDEX idx_tombstones_seq;     CREATE INDEX idx_tombstones_agency_seq ON tombstones (agency_id, seq);
CREATE INDEX idx_vehicles_agency_base ON vehicles (agency_id, base_id);
CREATE INDEX idx_sessions_agency ON sessions (agency_id);
CREATE INDEX idx_sessions_acting ON sessions (acting_agency_id) WHERE acting_agency_id IS NOT NULL;
CREATE INDEX idx_audit_agency_at ON audit_log (agency_id, at);
CREATE INDEX idx_attachments_agency ON attachments (agency_id, entity_type, entity_id);
CREATE INDEX idx_account_tokens_agency ON account_tokens (agency_id, user_id, purpose);
DROP INDEX idx_login_attempts_email;
CREATE INDEX idx_login_attempts_email ON login_attempts (agency_id, email, at_ms);
