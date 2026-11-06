-- GEMA Fleet: initial schema.
-- Conventions
--   * Every entity row has created_at / updated_at (ISO 8601, UTC).
--   * Synced tables also have `seq`: the value of the global change counter when the row last changed.
--     The browser asks for "everything with seq > my cursor", so polling stays cheap.
--   * `sample` = 1 marks demo rows so they can be removed in one step.
--   * Deleted rows leave a row in `tombstones` so deletes reach every browser.

CREATE TABLE counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  v  INTEGER NOT NULL
);
INSERT INTO counter (id, v) VALUES (1, 0);

CREATE TABLE tombstones (
  coll TEXT NOT NULL,
  id   TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE INDEX idx_tombstones_seq ON tombstones (seq);

CREATE TABLE bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  min_units INTEGER NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bases_seq ON bases (seq);

CREATE TABLE pm_programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT '',
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pm_programs_seq ON pm_programs (seq);

CREATE TABLE pm_tasks (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES pm_programs (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  grp TEXT NOT NULL DEFAULT 'General',
  interval_hours REAL,
  interval_days REAL,
  interval_km REAL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pm_tasks_program ON pm_tasks (program_id, sort);

CREATE TABLE mechanics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shop TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mechanics_seq ON mechanics (seq);

CREATE TABLE parts (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  description TEXT NOT NULL,
  fits TEXT NOT NULL DEFAULT '',
  on_hand REAL NOT NULL DEFAULT 0,
  reorder_point REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_parts_seq ON parts (seq);

CREATE TABLE settings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}',
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_settings_seq ON settings (seq);

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  plate TEXT NOT NULL DEFAULT '',
  vin TEXT NOT NULL DEFAULT '',
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  year INTEGER,
  type TEXT NOT NULL DEFAULT '',
  base_id TEXT,
  home_base_id TEXT,
  temp_until TEXT,
  temp_from_base_id TEXT,
  in_service_date TEXT,
  status TEXT NOT NULL DEFAULT 'in_service',
  status_reason TEXT NOT NULL DEFAULT '',
  status_since TEXT,
  expected_return TEXT,
  engine_hours REAL NOT NULL DEFAULT 0,
  odometer_km REAL NOT NULL DEFAULT 0,
  pm_program_id TEXT,
  warranty_end TEXT,
  notes TEXT NOT NULL DEFAULT '',
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_vehicles_unit ON vehicles (lower(unit));
CREATE INDEX idx_vehicles_base ON vehicles (base_id);
CREATE INDEX idx_vehicles_seq ON vehicles (seq);

CREATE TABLE vehicle_pm (
  vehicle_id TEXT NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  last_hours REAL,
  last_km REAL,
  last_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vehicle_id, task_id)
);
CREATE INDEX idx_vehicle_pm_task ON vehicle_pm (task_id);

CREATE TABLE meter_readings (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  at TEXT NOT NULL,
  hours REAL,
  km REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  by_user TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_readings_vehicle ON meter_readings (vehicle_id, at);
CREATE INDEX idx_readings_seq ON meter_readings (seq);

CREATE TABLE status_events (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  by_user TEXT,
  wo_id TEXT,
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_status_events_vehicle ON status_events (vehicle_id, at);
CREATE INDEX idx_status_events_seq ON status_events (seq);

CREATE TABLE moves (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  from_base_id TEXT,
  to_base_id TEXT,
  at TEXT NOT NULL,
  by_user TEXT,
  reason TEXT NOT NULL DEFAULT '',
  temp_until TEXT,
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_moves_vehicle ON moves (vehicle_id, at);
CREATE INDEX idx_moves_seq ON moves (seq);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reported_at TEXT NOT NULL,
  by_user TEXT,
  wo_id TEXT,
  hours REAL,
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_issues_vehicle ON issues (vehicle_id, reported_at);
CREATE INDEX idx_issues_status ON issues (status);
CREATE INDEX idx_issues_seq ON issues (seq);

CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  hold_reason TEXT,
  mechanic_id TEXT,
  opened_at TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  closed_at TEXT,
  hours_at_open REAL,
  hours_at_complete REAL,
  km_at_complete REAL,
  notes TEXT NOT NULL DEFAULT '',
  approval_needed INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  by_user TEXT,
  overdue_at_open INTEGER NOT NULL DEFAULT 0,
  hold_log TEXT NOT NULL DEFAULT '[]',
  sample INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_work_orders_number ON work_orders (number);
CREATE INDEX idx_work_orders_vehicle ON work_orders (vehicle_id, opened_at);
CREATE INDEX idx_work_orders_status ON work_orders (status);
CREATE INDEX idx_work_orders_mechanic ON work_orders (mechanic_id);
CREATE INDEX idx_work_orders_seq ON work_orders (seq);

CREATE TABLE work_order_lines (
  wo_id TEXT NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  repair_code TEXT NOT NULL DEFAULT 'Other',
  qty REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  part_id TEXT,
  warranty INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (wo_id, id)
);
CREATE INDEX idx_wo_lines_part ON work_order_lines (part_id);

CREATE TABLE wo_issue_links (
  wo_id TEXT NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wo_id, issue_id)
);
CREATE INDEX idx_wo_issue_links_issue ON wo_issue_links (issue_id);

CREATE TABLE wo_pm_tasks (
  wo_id TEXT NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wo_id, task_id)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('issue', 'work_order')),
  entity_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX idx_attachments_entity ON attachments (entity_type, entity_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system_admin','fleet_manager','base_supervisor','mechanic','crew','dispatcher','viewer')),
  base_ids TEXT NOT NULL DEFAULT '[]',
  mechanic_id TEXT,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_seq ON users (seq);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- SHA-256 (hex) of the cookie token; the token itself is never stored
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_email ON login_attempts (email, at_ms);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  user_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_at ON audit_log (at);

CREATE TABLE backup_jobs (
  id TEXT PRIMARY KEY,            -- the backup date, YYYY-MM-DD
  status TEXT NOT NULL,           -- running | done
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
