-- Activity history: the screen filters the audit log by person, by item and by date, newest first, 50 rows at a time.
-- 0001 already has an index on (at). Added here:
--   (user_id, at)                 "everything this person did"
--   (entity_type, entity_id, at)  "the history of this one item" (a superset of the old (entity_type, entity_id) index, which is dropped)
-- No data changes; safe on a database that already has audit rows.
CREATE INDEX IF NOT EXISTS idx_audit_user_at ON audit_log (user_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_entity_at ON audit_log (entity_type, entity_id, at);
DROP INDEX IF EXISTS idx_audit_entity;
