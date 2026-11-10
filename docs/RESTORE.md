# Backups and restoring

## What is backed up

- **Nightly backup** to the R2 bucket as `backups/YYYY-MM-DD.json.gz`: every table (including users with their password hashes, and the audit log), as a gzip-compressed JSON file. The last 30 are kept. It starts around 03:00 Guyana time (07:00 UTC) and works in small steps, so it finishes within a few minutes.
- File attachments are not copied into the backup file. They stay in R2 under `attachments/`.
- Only the super user sees the list of backups, with downloads and a **Back up now** button, on the Users screen.
- **D1 Time Travel** lets Cloudflare roll the database back to any minute in the last 7 days (free plan) or 30 days (paid). It is the quickest fix for "someone deleted something an hour ago".

## Option 1: roll back with Time Travel (recent mistakes)

```bash
npx wrangler d1 time-travel info gema-fleet                       # shows the current bookmark
npx wrangler d1 time-travel restore gema-fleet --timestamp="2026-11-05T14:30:00Z"
```

Use a time just before the mistake. The restore replaces the whole database, so changes made after that moment are lost. Wrangler prints a bookmark you can use to undo the restore.

## Option 2: restore from a nightly backup file

Use this if Time Travel is out of range, or the database was lost.

1. Download the backup from the Users screen, or from the R2 bucket in the Cloudflare dashboard.
2. Unzip it and check it: `gunzip -k 2026-11-05.json.gz` should produce readable JSON.
3. Make sure the empty tables exist: `npm run db:migrate:remote`.
4. Clear the existing data and load the backup. Write a SQL file from the backup with this script (it deletes everything, so run it only when you mean to):
   ```bash
   node scripts/restore-from-backup.mjs 2026-11-05.json.gz > restore.sql
   npx wrangler d1 execute DB --remote --file restore.sql --yes
   ```
   Leave off `--remote` from the second command to try it on the local database first.
5. Log in and check the board. Everyone's browser will reload all data on its next check, because the sync cursor is ahead of the restored database.

## Practice once

Do a restore on the **staging** copy (or locally) before you ever need it for real.

## If the R2 bucket is lost

Photos and PDFs live only in R2. Keep a monthly download of the bucket (for example with `rclone`) if they matter to you.
