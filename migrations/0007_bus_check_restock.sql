-- Bus check equipment shortages are no longer vehicle problems: they are restocked, not repaired.
--
--   issues.restocked_at / restocked_by  when a shortage (issues.source = 'bus_check') was marked restocked, and by whom. Its status becomes 'restocked'.
--
-- A restocked shortage leaves the partial unique index idx_issues_bus_check_open (it only covers 'open' and 'in_work_order'), so the next check that
-- finds the same item short starts a NEW shortage. Only new columns and a new index: safe on a database with data in it. Earlier migrations are untouched.

ALTER TABLE issues ADD COLUMN restocked_at TEXT;
ALTER TABLE issues ADD COLUMN restocked_by TEXT;
-- The Equipment tab and the crew's "Known shortages" panel: the shortages of one agency by status and unit.
CREATE INDEX idx_issues_shortages ON issues (agency_id, status, vehicle_id) WHERE source = 'bus_check';
