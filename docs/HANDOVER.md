# Hand-over notes

For whoever looks after GEMA Fleet next.

## Who can do what

- **Super user.** One or more email addresses listed in `SUPERUSER_EMAILS` in `wrangler.jsonc` (top level and `env.staging`; comma separated, case does not matter). It is changed **only by a code update**: edit that line, then deploy. A super user has every permission whatever their role, and nobody else can edit, deactivate, change the role or permissions of, set the password of or send reset links to a super user's account. If the variable is empty, nobody is a super user. The account itself is an ordinary user created as usual (for example with `npm run create-admin`); it becomes a super user because its email matches. To hand over: add the new address, deploy, and remove the old one in a later update.
- **Features (super user only).** Setup > **Features** shows a **Photo and PDF uploads** switch. It is **off by default** because file storage is limited. While off, every upload button (Report a problem, problem and work order Attachments) stays on screen but disabled with the note "Photo and PDF uploads are turned off for now.", and the server refuses uploads for everyone, including the super user, with `403 uploads_disabled`. Existing files can still be opened, and fleet managers and system administrators can still remove them. To turn uploads on, open Setup as the super user, tick the switch and press **Save features** (turn it off the same way). The value lives in the settings record under `features.uploads`; a missing value means off, and the ordinary **Save settings** can never change it. When it is on, only people with the **Upload photos and PDFs** permission can upload.
- **The three admin levels.**

  | | Fleet manager | System administrator | Super user |
  | --- | --- | --- | --- |
  | Who | A role (by default: whole fleet, setup, approvals, users) | A role (by default: everything a fleet manager has) | An email in `SUPERUSER_EMAILS`, whatever their role |
  | Add people, set roles, passwords, deactivate | Base supervisor and below | Fleet manager and below | Anyone except themselves |
  | Per-person permissions (Users > Permissions) | **No** (button hidden, API answers 403) | Fleet manager and below | Anyone except themselves |
  | Role permissions (Roles & permissions) | **No** (link hidden, API answers 403) | Fleet manager, base supervisor, mechanic, crew, dispatcher, viewer; the system administrator column is view only | Every role |
  | Grant Manage people or Change setup (to a role or a person) | No | No | Yes |
  | Backups panel, list, download, run | No | **No** | Yes |
  | Features (uploads switch) | No | No | Yes |

  You can only switch ON what you have yourself. **Backups** belongs to the super user alone: no role default includes it, it is not listed in either permission editor, and the server rejects any attempt to grant it by role or person (400); a stray stored value is ignored. The nightly backup runs on a schedule and is unaffected.
- **Roles & permissions.** Admin > **Roles & permissions** (`#roles`, super user and system administrators only) is a matrix: one row per permission (grouped: Units, Problems, Work orders, Parts and mechanics, Admin), one column per role. Columns you cannot edit are greyed and read-only. **Changed** marks a cell that differs from the built-in default (`PERM` in `src/shared/perm.ts`). Ticking boxes changes nothing until you press the one **Save changes** button at the top right of the page: unsaved boxes are highlighted, the header counts them, **Discard changes** puts them back, and the browser warns before you close or reload the tab with unsaved edits. **Save changes** saves every changed role together, all or nothing, after a confirmation that names the roles and how many people they affect. **Reset to default** (under each column) only fills in that role's built-in defaults; it too is kept by **Save changes**. On a phone a role picker shows one column at a time. Changes are stored in the settings record under `rolePerms` ({ role: { key: true/false } }, only differences from the defaults), written only by `PUT /api/roles/permissions` (several roles at once; the page uses this), `PUT /api/roles/:role/permissions` and `POST /api/roles/:role/reset` (audit-logged as `role.permissions` / `role.reset`, one row per changed role, with before and after). The ordinary **Save settings** can never change `rolePerms`, and neither can a crafted request. A change reaches everyone in the role within about 20 seconds with no new login. The order of precedence is: super user (always yes) > the person's own change > the role's change > the built-in default.
- **Per-person permissions.** Users screen > **Permissions** (super user and system administrators only) opens one person's switches (grouped like the matrix). Each switch shows what the person can do now and where that comes from: **Role default**, **Role change** (set on Roles & permissions) or **Personal change** (marked **Changed**), with **Reset to role default** per switch and **Reset all to role default**. Only the differences from the person's role (default plus role change) are stored (`users.perm_overrides`, migration 0003). Changes reach that person's screen within about 20 seconds with no new login. Changing someone's role keeps their personal changes; they are then compared with the new role. Scoping still applies on top: a base supervisor or crew member's rights apply to the units at their bases (crew and others with no base set see every unit), and a mechanic only works on work orders assigned to them. **View reports** only hides the Reports screen; it does not hide data the person can already read.
- **Who can change whom.** The super user: anyone but themselves. A system administrator: fleet managers and every role below. A fleet manager: base supervisors and every role below (accounts and roles only, not permissions). Nobody changes their own role or permissions. The same limits apply when adding people and choosing their role (only the super user can create a system administrator).
- **Users screen** (fleet manager and system administrator): add a person, change role or bases, set a password, deactivate; **Permissions** for system administrators and the super user. Only the super user can create or change system administrator accounts.
- **Adding a person.** Choose **Set a password now** (type one or press Generate, then hand it to them; they are not forced to change it, and the screen does not show it again) or, when email is set up, **Email an invite link** (they choose their own password; the list shows "Invited — not yet set up" until they do, with a **Resend invite** button). You can set a new password for anyone later with **Set password** (it logs them out everywhere). Everyone can change their own password with the **Password** button.
- **Email is optional.** Without it the Users screen says "Email isn't set up, so you choose people's passwords here." With it, people get **Forgot password?** on the login page and you get **Send reset link**. Setup, limits and what to do if it stops working: [EMAIL.md](EMAIL.md).
- **Locked out?** After 10 wrong passwords an account is locked for 15 minutes. A forgotten password is fixed with **Forgot password?** (if email is set up) or by an administrator with **Set password**.
- **Nobody can log in as administrator?** Create one from a computer that has this repository and is logged into Cloudflare: `npm run create-admin -- --email ... --name ... --remote` (add `--invite` for a set-password link, or `--password-prompt` to type a password at a hidden prompt).

## Routine care

| Task | How often | How |
| --- | --- | --- |
| Check that the nightly backup ran | Weekly | Users screen, Backups panel (super user only) |
| Download a backup and keep it somewhere else | Monthly | Same panel, Download |
| Review sample data | Once | Setup screen, **Remove sample data**, if any was loaded |
| Review automatic update pull requests | Weekly (Mondays) | GitHub, **Pull requests**: Dependabot opens them; merge when the checks are green. Security fixes can arrive any day |

Every change a person makes is recorded in the `audit_log` table (who, what, before and after). The super user and system administrators can read it from `GET /api/admin/audit` while logged in.

## Where things live

- Business rules (what a status change or work order action does): `src/worker/rules.ts`
- Who is allowed to do what: `src/shared/perm.ts` (defaults and the effective-permission rule); role changes: `src/worker/roles.ts`, `src/client/roles-ui.ts`
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
- **Email alerts** about reported problems (the hook is `notifyIssueReported` in `src/worker/notify.ts`; sending support already exists in `src/worker/mail.ts`).
- **A daily PM summary email** to fleet managers (what is overdue or due soon).
- Fuel logging, GPS or telematics, offline use on tablets.
- A custom domain and single sign-on, if the Ministry has an identity provider.
