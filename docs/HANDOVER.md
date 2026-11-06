# Hand-over notes

For whoever looks after GEMA Fleet next.

## Who can do what

- **Users screen** (fleet manager and system administrator): add a person, change role or bases, reset a password, deactivate. Only a system administrator can create or change system administrator accounts.
- **Temporary passwords** are shown once on screen. The administrator gives them to the person directly. The system never emails or texts them. People must choose their own password at first login.
- **Locked out?** After 10 wrong passwords an account is locked for 15 minutes. A forgotten password is fixed by an administrator with **Reset password**.
- **Nobody can log in as administrator?** Create one from a computer that has this repository and is logged into Cloudflare: `npm run create-admin -- --email ... --name ... --remote`.

## Routine care

| Task | How often | How |
| --- | --- | --- |
| Check that the nightly backup ran | Weekly | Users screen, Backups panel (system administrator) |
| Download a backup and keep it somewhere else | Monthly | Same panel, Download |
| Review sample data | Once | Setup screen, **Remove sample data**, if any was loaded |
| Update software packages | A few times a year | `npm update`, then `npm test` and `npm run build` |

Every change a person makes is recorded in the `audit_log` table (who, what, before and after). Administrators can read it from `GET /api/admin/audit` while logged in.

## Where things live

- Business rules (what a status change or work order action does): `src/worker/rules.ts`
- Who is allowed to do what: `src/shared/perm.ts`
- PM due dates, availability, costs: `src/shared/pure.ts` (covered by unit tests)
- Screens: `src/client/views-*.ts`; forms and buttons: `src/client/ui.ts`
- Database tables: `migrations/`

## Choices worth knowing

- **Sample data** is marked in the database (`sample = 1`) so it can be removed in one step without touching real records.
- **Settings** hold the approval threshold (work orders over this need a fleet manager), the PM "due soon" window and the comeback window.
- **Password hashing** is set to 20,000 rounds to fit the free plan. See [SECURITY.md](SECURITY.md). If the account is upgraded to a paid plan, raise `PBKDF2_ITERATIONS` in `wrangler.jsonc` to 100000 or more; existing passwords are upgraded automatically at each person's next login.
- **Restoring** is in [RESTORE.md](RESTORE.md).

## Possible later additions

Not built, and not needed to run the program today:

- **Email alerts**, for example when a critical problem is reported. The hook already exists: `notifyIssueReported` in `src/worker/notify.ts` is called whenever a problem is reported and currently does nothing.
- **A daily PM summary email** to fleet managers (what is overdue or due soon).
- Fuel logging, GPS or telematics, offline use on tablets.
- A custom domain and single sign-on, if the Ministry has an identity provider.
