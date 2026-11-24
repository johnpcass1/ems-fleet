# Security notes

## Tenant isolation (agencies)

Several agencies share one database, one Worker and one R2 bucket. The server keeps them apart; nothing depends on the browser.

- **Every agency-owned row has `agency_id`** (all tables except `counter`, `auth_throttle`, `backup_jobs`). The rule for every statement: a SELECT filters on `agency_id`; an INSERT sets it; an UPDATE or DELETE adds `AND agency_id = ?`. Guards inside a transaction compare ids that were already looked up in the agency.
- **The request's agency is decided in one place: `requireAuth`** (`src/worker/auth.ts`). It takes the session, the user's own row and (for the super user only) the agency their session is viewing, and sets `actor.agencyId`. The browser never names the agency it wants: the `agency` parameter on sync is only a hint that makes the server send a full copy when the browser's cached agency is stale. A session is bound to the agency of its account (`sessions.agency_id`); an inactive agency's sessions are deleted and its people cannot sign in.
- **Ids from another agency are "not found".** `agencyRow` and `inAgency` (`src/worker/db.ts`) look an id up inside the agency; a record that exists elsewhere gives the same 404 or 400 as an id that does not exist at all. Records named in a request body (a vehicle on a new work order, a base in a move, a part on a line, a mechanic, a base on a user) are checked the same way.
- **Writes** go through `Tx` (`src/worker/db.ts`), which carries the agency and stamps it on the audit and tombstone rows. **Reads for the screens** go through `loadDocs`/`loadDoc` (`src/worker/docs.ts`) and `syncSince` (`src/worker/sync.ts`); Activity history and its CSV filter in `fetchRows` (`src/worker/activity.ts`). Settings, features, role changes and work order numbers are per agency.
- **Sign-in.** Agency ID plus email. Every failure (wrong or unknown Agency ID, inactive agency, wrong email, wrong password) gives the same message and costs the same time. The lock counter is per agency and email, including for a code that is not an agency. A failed sign-in is written to the history of the agency it was tried in; for a code that is not an agency nothing is written. Reset and invite tokens belong to an agency and are refused for any other. Forgot password is throttled by a hash of agency and email.
- **The super user** is an email in `SUPERUSER_EMAILS` on an account in the home agency (`SUPERUSER_AGENCY`, default `GEMA`), checked by `isSuperuserAccount` (`src/worker/env.ts`). The same email in another agency is an ordinary account, and no one can create, edit or invite an account with such an email outside the home agency. The super user's session can act in another agency (Agencies > Open) only if that agency is active; this is stored on the session (`acting_agency_id`) and every use is audit-logged under the super user's own email in that agency. Agency management endpoints answer 403 to everyone else.
- **Files.** New uploads are stored as `attachments/<AGENCY>/<id>`. Downloads and deletes look the attachment up by id **and agency** and use the key stored on that row, so an old key without a prefix still works for its own agency only.
- **Known limits.** The change counter is one number for the whole database, so the cursor a browser holds reveals how many changes the site as a whole has made (not which agency made them). The backup is one file for the whole database (all agencies' data and password hashes) and only the super user can read it. Activity history for "failed sign-in" of an unknown Agency ID is not recorded. All agencies share the Cloudflare account's limits (requests, D1 and R2 storage), so one busy agency can use up the free allowance for all.
- **For developers.** A new query on an agency-owned table must filter on `agency_id`; a new endpoint that takes an id must use `agencyRow`/`inAgency` or an agency-filtered query, and be added to the "ids from the other agency" list in `test/api/agencies.test.ts`. Bus checks (`src/worker/buscheck.ts`) follow the same rule (unit, station, list, person and check ids are all looked up inside the agency, and a base supervisor's reports are further limited to their bases); their two-way isolation tests are in `test/api/buscheck.test.ts`.

## Passwords

- Stored as **PBKDF2-SHA256** with a random 16-byte salt per password, in the form `pbkdf2-sha256$<rounds>$<salt>$<hash>`.
- **Rounds: 20,000.** This is deliberately lower than the 600,000 that OWASP suggests for PBKDF2-SHA256. The free Cloudflare plan allows 10 ms of CPU time for each request. We measured the hash in the Workers runtime: 10,000 rounds took about 1.5 ms, 20,000 about 3 to 3.7 ms, 50,000 about 7.4 ms, and 100,000 about 14 ms (over the limit, so logins would fail). 20,000 leaves headroom for the rest of the login. On the paid plan, set `PBKDF2_ITERATIONS` higher (the code verifies old hashes and re-hashes at next login when the setting rises).
- The weaker hashing is offset by: a minimum length of 10 characters, a lockout after 10 failed attempts for 15 minutes (per email address), temporary passwords from `create-admin` (about 60 bits of randomness, forced change at first login), and the fact that the hash is only ever in the database, never sent anywhere.
- Unknown email addresses still run a dummy hash so response times do not reveal which accounts exist.

- **Passwords chosen by an administrator.** A fleet manager or system administrator can set someone's password (when adding them, or with Set password). The server enforces the same rules as for self-chosen passwords, never logs or returns the password, ends all of that person's sessions, and records only "password set by X" in the audit log. The person is not forced to change it. **Trade-off:** the administrator knows that password. Where this matters, prefer invite links (when email is set up), and suggest that people change theirs with the Password button. Nobody can set their own password through this route, and a fleet manager cannot set a system administrator's password.
- People who were invited and have not yet set a password have no usable password at all: their stored value is `unusable$<random>`, which no password can match. Login treats it like an unknown account (same dummy hash cost).

## Invite and reset links (email)

- Each link carries a random 256-bit secret (base64url). Only its **SHA-256 hash** is stored (`account_tokens`), so reading the database never reveals a working link.
- **Single use**, and a new link of the same kind for a person cancels older unused ones. Invite links expire after **7 days**, reset links after **1 hour**. Using any link cancels all the person's other unused links. A link claimed by two requests at once works for only one (database guard).
- Deactivated accounts cannot use or request links (a link for a deactivated account looks like an invalid one).
- Using a link requires a password that meets the normal rules, sets it, clears any "must change" flag, **deletes every existing session** for that person (and the browser's current one), then starts a new session. Weak passwords are refused without using up the link.
- The link is `APP_URL/set-password#t=<secret>`. The secret is in the **fragment**, so it is not sent in the request line, not in server logs, and not in the `Referer` header. The page reads it, removes it from the address bar, and posts it in the request body. It is never put in the audit log.
- **No account enumeration.** `POST /api/auth/forgot` always answers 200 with the same text, whether or not the address has an account, and everything that depends on the account (lookup, token, sending) happens after the response is sent. Requests are counted per address (hashed): at most **3 emails per address per hour**, and per network address (hashed): at most **10 requests per hour** (further ones get 429, which says nothing about accounts). Unknown addresses are counted too. The endpoint is CSRF-protected like every other POST. Counters are in `auth_throttle` and cleaned up daily.
- The invite email names who invited the person and their role; emails contain no images or tracking. If sending fails, the link is cancelled and the administrator sees the reason.
- The Resend key is a Cloudflare **secret**, not in `wrangler.jsonc`. It is never returned or logged by the app.
- `account_tokens` and `auth_throttle` are **not in the nightly backup**: they hold only hashes of short-lived links and counters, and restored links would be dead anyway. (The `users` table in backups does contain password hashes, as before.)
- The development mail sink (`MAIL_SINK=1`) stores emails in the file bucket and exposes them at `/api/dev/last-mail`. It only works when `APP_URL` is a `localhost` address and the variable is not in `wrangler.jsonc`, so it cannot be active in production. Never set it on a deployed copy.

## Sessions

- A random 256-bit token is set in the `gf_session` cookie (`HttpOnly`, `Secure` on https, `SameSite=Lax`, path `/`). Only a SHA-256 hash of the token is stored, so a copy of the database cannot be used to take over sessions.
- Sessions last 30 days, slide forward as people use the app, and are deleted at logout, password change, a link being used, an administrator setting the password, or deactivation.

## Requests

- **Cross-site request forgery:** every change request must carry the header `X-Requested-With: gema-fleet` and, when the browser sends an `Origin`, it must match the site. A different website cannot add that header to a request without permission.
- **Input checks:** every API input is validated (types, lengths, allowed values) before use. Queries use bound parameters only.
- **Authorisation** is decided on the server for every request, using the role, bases and linked mechanic stored with the account, never values sent by the browser. Base supervisors and crew only reach their own bases' units. Mechanics only see and work on work orders assigned to them, including their files. The dispatcher receives a reduced feed with no parts, costs or notes.
- **Audit log:** every write adds a row (who, when, what, before and after) in the same database batch as the change. See *Audit log and Activity history* below.

## Permissions, the super user and features

- Every permission is decided on the server from the person's row and the agency's settings record on each request, in this order: the super user (from `SUPERUSER_EMAILS` on a home-agency account, set as a Cloudflare secret, never in the database or the browser) has everything; otherwise the person's own override (`users.perm_overrides`); otherwise the role's change (`rolePerms` in the settings record); otherwise the built-in role default (`src/shared/perm.ts`). The browser receives the finished list only to hide buttons.
- **The three admin levels**

  | | Fleet manager | System administrator | Super user |
  | --- | --- | --- | --- |
  | Create accounts / set roles | Base supervisor and below | Fleet manager and below | Anyone (only they create a system administrator) |
  | Passwords, reset links, deactivation | Base supervisor and below | Fleet manager and below | Anyone except themselves |
  | Per-person permissions (`POST /api/users/:id/permissions`) | 403 | Fleet manager and below | Anyone except themselves |
  | Role permissions (`PUT /api/roles/:role/permissions`, `POST /api/roles/:role/reset`) | 403 | All roles except system administrator | Every role |
  | Grant Manage people / Change setup | No | No | Yes |
  | Backups (list, download, run) | 403 | 403 | Yes |
  | Features (`PUT /api/features`) | 403 | 403 | Yes |
  | Read the audit log (Activity history) | No | Yes | Yes |

- Rules for both permission editors, enforced on the server: nobody edits their own permissions or role; an editor can only switch on a permission they hold themselves; only the super user can grant Manage people or Change setup; **Backups can never be granted** to a role or a person (the request is rejected with 400, the key is not in either editor, and any stored value for it is ignored when permissions are computed). Backups (the panel and the list, download and run endpoints) are decided by the super-user check alone. The nightly backup is a scheduled job and does not depend on anyone's permissions. A super user's account can be changed only by a super user, and nothing stored in a role or person record can reduce the super user's access. Every role and person permission change is audit-logged with before and after (`role.permissions`, `role.reset`, `user.permissions`).
- `rolePerms` is part of the settings record that is synced to browsers (it holds no secrets; the dispatcher's reduced feed omits it). Like `features`, it is written only through its own endpoints; the ordinary settings save ignores it.
- Site-wide **features** (currently Photo and PDF uploads) are changed only through `PUT /api/features`, which answers 403 to everyone but the super user. The ordinary settings save ignores `features` (and `rolePerms`), so a crafted request from a fleet manager or system administrator cannot change it.
- Anyone who can edit the code or Cloudflare variables can change who is the super user; protect the repository and the Cloudflare account accordingly.

## Audit log and Activity history

- **What is logged.** Every write (who, when, action, item, before and after as JSON) and sign-in events: `auth.login`, `auth.logout`, `auth.login_failed`, `auth.locked`, `auth.change_password`, `auth.set_password`, `auth.forgot_password`. A failed sign-in stores the **email address that was tried** (lower-cased) and the account's id when that address has an account. The **password is never stored**, and if what was typed in the email box does not look like an email address (people sometimes paste their password there) it is replaced by "(not an email address)". The failure that triggers a lockout also writes `auth.locked` once; attempts refused during a lock write nothing.
- **Nothing secret can reach the log.** Every audit row is written through one function (`auditStmt` in `src/worker/db.ts`, used by `Tx.audit` and by the sign-in code), which first runs the **sanitiser** (`sanitizeAudit` in `src/shared/activity.ts`). It removes, at any depth and inside arrays, every key whose name contains *password*, *passwd*, *passphrase*, *secret*, *token* (so also `token_hash`, `resetToken`), *session*, *hash*, *cookie*, *authorization*, *credential* or *api key*, and blanks any `#t=...` invite/reset link secret inside text. It does not depend on callers remembering. The same sanitiser runs again when rows are read, so an older row is also cleaned on the way out. Tests: `test/unit/activity.test.ts` and `test/api/activity.test.ts` (including a caller that passes every kind of secret, and the real sign-in, set-password and change-password flows). Rule for developers: never put a secret in an audit payload; if a new field name contains one of the words above it is dropped.
- **Who can read it.** The super user and system administrators only (`isSuper || role === 'system_admin'`): `GET /api/admin/activity` (also reachable as `GET /api/admin/audit`) and `GET /api/admin/activity/export` answer **403** to everyone else, including fleet managers, and 401 when logged out. The Activity history screen and its sidebar link are hidden for everyone else. The log is **read-only through the app**: nothing edits or deletes rows. It contains people's names, email addresses and the email addresses typed into failed sign-ins (which may be anyone's), so treat exports like personal data: the CSV is built on request, sent with `Cache-Control: private, no-store`, and is limited to the newest 5,000 rows. Text that starts with `=`, `+`, `-` or `@` in an export is prefixed with an apostrophe so a spreadsheet will not run it as a formula.
- **Volume.** Failed sign-ins for unknown addresses each add a row; the per-address lockout does not limit a flood of *different* addresses. The table is indexed (`0004_activity_indexes.sql`) so reading stays cheap, and rows are small, but there is no automatic purge; if the table ever becomes large, export it and delete old rows in the D1 console.

## Files

- Allowed: PDF, JPEG, PNG, WebP up to 20 MB. The server checks the first bytes of the file (not just its name or declared type) and requires the declared type to match.
- Stored in a private R2 bucket under random names. Downloads go through the API, so login and scope checks apply, and are sent with `X-Content-Type-Options: nosniff` and a safe `Content-Disposition`.
- Uploading needs the site-wide uploads feature to be on (off by default; refused with 403 `uploads_disabled` before the file is read, for everyone) and the person's `upload` permission. Viewing existing files is unchanged.
- Only people with the "Remove photos and PDFs" permission (fleet managers and system administrators by default) can delete an attachment.

## Browser protections

`Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'`, plus `Referrer-Policy`, `X-Content-Type-Options: nosniff`, and `Permissions-Policy` (camera, microphone and location off). There are no inline scripts. `unsafe-inline` is allowed for styles only, because the screens use some inline `style` attributes. `'wasm-unsafe-eval'` lets the demo compile its WebAssembly database (see below); it does not allow JavaScript `eval` or inline scripts.

## Demo

The demo (**Try the demo** on the login page) needs no account and never reaches the API: the Worker code runs inside the visitor's own browser tab against an in-memory copy of the sample data, and every request is answered there. It cannot read or change real data, it has no super user, and uploads, the uploads switch, backups, agencies, password changes and email links are refused before the API code sees them. A visitor who changes the demo's code in their browser only changes their own throwaway copy. See [HANDOVER.md](HANDOVER.md), *Demo*.

## What is not covered

- No two-factor login. Consider adding Cloudflare Access in front of the site if the Ministry needs it.
- Email is optional. Without it there is no "forgot password" link and an administrator sets passwords. With it, anyone who can read a person's mailbox can reset that person's password, which is true of most systems; keep mailboxes secure.
- Backups are stored in the same Cloudflare account. Download one now and then and keep it elsewhere.
