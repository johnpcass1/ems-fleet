# Security notes

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
- **Audit log:** every write adds a row (who, when, what, before and after) in the same database batch as the change.

## Files

- Allowed: PDF, JPEG, PNG, WebP up to 20 MB. The server checks the first bytes of the file (not just its name or declared type) and requires the declared type to match.
- Stored in a private R2 bucket under random names. Downloads go through the API, so login and scope checks apply, and are sent with `X-Content-Type-Options: nosniff` and a safe `Content-Disposition`.
- Only fleet managers and system administrators can delete an attachment.

## Browser protections

`Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'`, plus `Referrer-Policy`, `X-Content-Type-Options: nosniff`, and `Permissions-Policy` (camera, microphone and location off). There are no inline scripts. `unsafe-inline` is allowed for styles only, because the screens use some inline `style` attributes.

## What is not covered

- No two-factor login. Consider adding Cloudflare Access in front of the site if the Ministry needs it.
- Email is optional. Without it there is no "forgot password" link and an administrator sets passwords. With it, anyone who can read a person's mailbox can reset that person's password, which is true of most systems; keep mailboxes secure.
- Backups are stored in the same Cloudflare account. Download one now and then and keep it elsewhere.
