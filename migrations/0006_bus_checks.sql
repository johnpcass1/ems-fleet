-- Bus checks: the start-of-shift ambulance inspection.
--
--   bus_check_lists  the requirement lists (what a crew checks, for which unit types). Small; sent to the browser by the normal sync, like bases.
--   bus_checks       one row per submitted check. Many; read through paged API calls, not sync. A submitted check is never changed.
--   issues           three new nullable columns tie a problem to the check that found it (see below).
--
-- Both new tables carry agency_id like every other agency-owned table (docs/SECURITY.md, "Tenant isolation"); every index starts with it.
-- Nothing is seeded here: an agency gets the standard list only when its administrator presses "Start from the standard list".
-- Only new tables, new columns and new indexes, so this is safe on a database with data in it.

CREATE TABLE bus_check_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit_types TEXT NOT NULL DEFAULT '[]',   -- JSON array of vehicles.type values. Empty = the default for any unit whose type no other list covers.
  active INTEGER NOT NULL DEFAULT 1,
  sections TEXT NOT NULL DEFAULT '[]',     -- JSON: [{ id, title, items: [{ id, code, name, kind, min, unit, note }] }]
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  agency_id TEXT NOT NULL
);
CREATE INDEX idx_bus_check_lists_agency_seq ON bus_check_lists (agency_id, seq);

CREATE TABLE bus_checks (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  list_id TEXT NOT NULL,                   -- the list used (it may be edited or made inactive later; this check keeps its own copy in `snapshot`)
  list_name TEXT NOT NULL DEFAULT '',
  base_id TEXT,                            -- the station: the unit's base at the time, or the base the crew chose
  submitted_at TEXT NOT NULL,
  submitted_by TEXT,
  crew TEXT NOT NULL DEFAULT '{}',         -- JSON: { emt1: {userId, name}, emt2: {userId, name}, driver: {userId, name} | null }
  mileage_km REAL NOT NULL,
  engine_hours REAL NOT NULL,
  reading_id TEXT,                         -- the meter reading saved with this check (source 'bus_check')
  reading_flagged INTEGER NOT NULL DEFAULT 0,
  shortages INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL,                  -- JSON: the list exactly as it was when the check was submitted
  answers TEXT NOT NULL,                   -- JSON: { itemId: answer }
  shortage_items TEXT NOT NULL DEFAULT '[]', -- JSON: one entry per shortage (item, what was found, severity, problem id)
  problems TEXT NOT NULL DEFAULT '[]',     -- JSON: the problems this check created, joined, or the crew reported: [{ issueId, kind, itemId }]
  attestation TEXT NOT NULL,               -- the sentence the person agreed to
  client_ref TEXT,                         -- sent by the browser so a retry after a lost connection cannot save the check twice
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  agency_id TEXT NOT NULL
);
CREATE INDEX idx_bus_checks_vehicle ON bus_checks (agency_id, vehicle_id, submitted_at);
CREATE INDEX idx_bus_checks_agency_at ON bus_checks (agency_id, submitted_at);
CREATE UNIQUE INDEX idx_bus_checks_client_ref ON bus_checks (agency_id, client_ref) WHERE client_ref IS NOT NULL;

-- A problem knows where it came from:
--   bus_check_id  the check that created it
--   source        'bus_check' = a shortage found by a check (source_ref is the list item's id); 'bus_check_report' = a problem the crew reported inside a check
--   source_ref    the list item id for a shortage
ALTER TABLE issues ADD COLUMN bus_check_id TEXT;
ALTER TABLE issues ADD COLUMN source TEXT;
ALTER TABLE issues ADD COLUMN source_ref TEXT;
CREATE INDEX idx_issues_bus_check ON issues (agency_id, bus_check_id) WHERE bus_check_id IS NOT NULL;
-- One open problem per unit and list item: a later check that finds the same shortage joins the open problem instead of adding another.
-- Also guards two crews submitting at the same moment (the second one is retried by the Worker and joins the first one's problem).
CREATE UNIQUE INDEX idx_issues_bus_check_open ON issues (agency_id, vehicle_id, source_ref) WHERE source = 'bus_check' AND status IN ('open', 'in_work_order');
