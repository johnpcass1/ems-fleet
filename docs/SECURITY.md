# Security notes

## Passwords

- Stored as **PBKDF2-SHA256** with a random 16-byte salt per password, in the form `pbkdf2-sha256$<rounds>$<salt>$<hash>`.
- **Rounds: 20,000.** This is deliberately lower than the 600,000 that OWASP suggests for PBKDF2-SHA256. The free Cloudflare plan allows 10 ms of CPU time for each request. We measured the hash in the Workers runtime: 10,000 rounds took about 1.5 ms, 20,000 about 3 to 3.7 ms, 50,000 about 7.4 ms, and 100,000 about 14 ms (over the limit, so logins would fail). 20,000 leaves headroom for the rest of the login. On the paid plan, set `PBKDF2_ITERATIONS` higher (the code verifies old hashes and re-hashes at next login when the setting rises).
- The weaker hashing is offset by: a minimum length of 10 characters, a lockout after 10 failed attempts for 15 minutes (per email address), generated temporary passwords with about 60 bits of randomness, forced change at first login and after every reset, and the fact that the hash is only ever in the database, never sent anywhere.
- Unknown email addresses still run a dummy hash so response times do not reveal which accounts exist.

## Sessions

- A random 256-bit token is set in the `gf_session` cookie (`HttpOnly`, `Secure` on https, `SameSite=Lax`, path `/`). Only a SHA-256 hash of the token is stored, so a copy of the database cannot be used to take over sessions.
- Sessions last 30 days, slide forward as people use the app, and are deleted at logout, password change, reset, or deactivation.

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

`Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'`, plus `Referrer-Policy`, `X-Content-Type-Options: nosniff`, and `Permissions-Policy` (camera, microphone and location off). There are no inline scripts. `unsafe-inline` is allowed for styles only, because the screens use some inline `style` attributes.

## What is not covered

- No two-factor login. Consider adding Cloudflare Access in front of the site if the Ministry needs it.
- No email, so there is no "forgot password" link; an administrator resets passwords.
- Backups are stored in the same Cloudflare account. Download one now and then and keep it elsewhere.
