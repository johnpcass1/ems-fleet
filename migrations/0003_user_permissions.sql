-- Per-person permission changes.
--   perm_overrides: JSON object, permission key -> true/false. Only the differences from the person's role defaults are stored.
--   '{}' (the default) means "exactly what the role allows", so nothing changes for anyone until an administrator sets one.
ALTER TABLE users ADD COLUMN perm_overrides TEXT NOT NULL DEFAULT '{}';
