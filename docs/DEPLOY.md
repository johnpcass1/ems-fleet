# Deploying GEMA Fleet to Cloudflare

This guide assumes no earlier Cloudflare experience. You do this once. After that, every change merged to the `main` branch deploys itself (GitHub Actions).

Nothing has been deployed by the people who wrote this code. The database id in `wrangler.jsonc` is a placeholder until you complete step 3.

## Will it cost anything?

Designed to run on the **free plan**. Figures below were read from Cloudflare's documentation on the day this guide was written. Cloudflare can change them, so check the links before relying on them.

| Service | Free allowance | What GEMA Fleet uses |
| --- | --- | --- |
| Workers requests | 100,000 per day | The browser checks for changes every 20 s while a page is open (15 s on Dispatch), slowing down when idle. 100 people with a tab open all day is well under the limit. |
| Workers CPU time | 10 ms per request (and per cron run) | Password hashing is tuned to fit (20,000 rounds, about 3 ms). Backups are cut into small steps. |
| D1 rows read / written | 5 million read, 100,000 written per day | Sync reads only changed rows. A busy day writes a few thousand rows. |
| D1 storage | 5 GB total, 500 MB per database | A fleet this size is a few megabytes. |
| D1 queries per request | 50 | Business actions use one batch (counted as one query). |
| D1 Time Travel (point-in-time restore) | 7 days on the free plan | See [RESTORE.md](RESTORE.md). |
| R2 storage and operations | 10 GB, 1 million writes, 10 million reads per month | Photos are shrunk to 1600 px in the browser before upload. Egress (downloads) is free. |
| Cron triggers | 5 per account | Uses 1 (the nightly backup). |

Sources:
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/

If the free daily request limit is ever reached, the site stops answering until the next day. The paid Workers plan (about US$5 per month at the time of writing) removes that worry and gives longer time limits and 30 days of Time Travel.

## One-time setup

You need: a free Cloudflare account, a GitHub account with this repository, and Node.js 22 on a computer.

1. **Log in from your computer.**
   ```bash
   npm install
   npx wrangler login
   ```
2. **Create the file storage bucket** (names are in `wrangler.jsonc`):
   ```bash
   npx wrangler r2 bucket create gema-fleet-files
   ```
   (R2 asks for a payment card on the free plan. You are not charged inside the free allowance.)
3. **Create the database** and copy the `database_id` it prints into `wrangler.jsonc` (the `d1_databases` block):
   ```bash
   npx wrangler d1 create gema-fleet
   ```
4. **Create the tables:**
   ```bash
   npm run db:migrate:remote
   ```
5. **Deploy:**
   ```bash
   npm run deploy
   ```
   Wrangler prints the address, like `https://gema-fleet.<your-name>.workers.dev`. Put it in `APP_URL` in `wrangler.jsonc` and deploy again. (`APP_URL` is used for the same-site security check and, if you set up email, for the links in emails.)
6. **Create the first administrator** (this writes to the live database):
   ```bash
   npm run create-admin -- --email you@example.org --name "Your Name" --remote
   ```
   It prints a temporary password once. Open the site, log in, and choose your own password. (Or add `--password-prompt` to type a password at a hidden prompt, or `--invite` to get a set-password link.)
7. **Add the real people** in the app under **Users**. For each person you choose a password and hand it to them yourself (in person or by phone); they can change it any time with the **Password** button. To let people choose their own passwords by email and reset forgotten ones, set up email after going live (next section).

### Optional: email for account setup and password reset

Once the app is live you can add email invites and a "Forgot password?" link. It needs a domain you control and a free Resend account, and takes about half an hour. Follow [EMAIL.md](EMAIL.md). Until then everything works with passwords chosen by an administrator.

### Optional: your own address

In the Cloudflare dashboard, open the Worker, then Settings, then Domains and Routes, and add a custom domain. Update `APP_URL` to match.

## Automatic deploys from GitHub

`.github/workflows/deploy.yml` runs the tests, applies database changes, then deploys:

- push to `main` goes to production
- push to `staging` goes to the staging copy (its own database and bucket, for trying changes)

Add two repository secrets (GitHub: Settings, Secrets and variables, Actions):

- `CLOUDFLARE_ACCOUNT_ID`: shown in the Cloudflare dashboard sidebar.
- `CLOUDFLARE_API_TOKEN`: create at My Profile, API Tokens, "Create Token". Give it only these permissions: Account / Workers Scripts: Edit, Account / D1: Edit, Account / Workers R2 Storage: Edit. Limit it to your one account.

### Checking a change before it goes live

Every pull request to `main` runs the tests first; GitHub shows a green tick or a red cross on the pull request before you merge. Nothing goes live until you merge.

Once the staging copy below is set up, each pull request is also published to the staging copy (its own database and files, never the live ones), so you can click through the change first. The address is shown in the run's summary on the **Actions** tab.

### Staging copy (optional)

```bash
npx wrangler r2 bucket create gema-fleet-files-staging
npx wrangler d1 create gema-fleet-staging         # copy the id into env.staging in wrangler.jsonc
npm run db:migrate:staging
npm run deploy:staging
npm run create-admin -- --email you@example.org --name "Your Name" --remote --env staging
```

## Updating the database later

Release 0003 (`migrations/0003_user_permissions.sql`) adds one column to `users` for per-person permissions. The GitHub workflow applies it on deploy. If you deploy from Terminal, run `npm run db:migrate:remote` (and `npm run db:migrate:staging` for staging) before `npm run deploy`. Set the super user's address in `SUPERUSER_EMAILS` in `wrangler.jsonc` first (see [HANDOVER.md](HANDOVER.md)).


Database changes are numbered files in `migrations/`. They are applied automatically by the GitHub workflow and never edited after release; a change is always a new file.

## Checking that it works

- `https://<your address>/api/health` shows `{"ok":true}`.
- After the first night (around 03:00 Guyana time), log in as the system administrator, open **Users**, and look at the Backups panel. You can also press **Back up now**.
