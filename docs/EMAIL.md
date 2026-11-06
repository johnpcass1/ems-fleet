# Email: let people set up and reset their own passwords

This page is optional. GEMA Fleet works without it. Without email, a fleet manager or system administrator **chooses a password for each person** on the Users screen and hands it over (in person, by phone, or by message). People can change their own password afterwards with the **Password** button.

With email switched on, you get three extra things:

1. **Invite by email.** When you add a person, choose "Email an invite link" instead of typing a password. They get a short email with a link, choose their own password, and are logged in. You never see or know their password.
2. **Forgot password?** A link on the login page. The person types their email address and gets a link to choose a new password. No administrator needed.
3. **Send reset link** and **Resend invite** buttons on the Users screen, for when someone is stuck or an invite was missed.

The emails are plain and short. They contain no images and no tracking. They are only sent for these two things. Email alerts about reported problems are not part of this.

## What you need

- **A domain name you control**, for example `gema.gov.gy` or `fleet-gema.org`. Email providers will only send email to everyone from an address on a domain you have proven you own. This is what stops anyone from sending email pretending to be you. If GEMA or the Ministry already has a domain, ask whoever looks after it for access to its DNS settings (the list of records that belong to the domain).
- **If you have no domain**, you can buy one. Cloudflare Registrar sells domains at the registry's own price with no markup ([Cloudflare Registrar](https://developers.cloudflare.com/registrar/)). Third-party price listings put a `.com` at roughly US$10 to 11 a year; search for the exact price at <https://domains.cloudflare.com/> before buying, because I could not confirm it from Cloudflare's own documentation. Not every ending (for example `.gy`) is necessarily sold there.
- A **free Resend account** (the email service this app uses), signed up with a shared GEMA email address, not a personal one.
- The computer you used to deploy the app (see [DEPLOY.md](DEPLOY.md)).

## Setting it up, step by step

1. **Create the Resend account** at <https://resend.com>. Use a shared GEMA address so the account is not tied to one person.
2. **Add your domain in Resend** (Domains, then Add Domain). Resend suggests using a subdomain such as `mail.yourdomain.org` for sending, so that the main domain's reputation is kept separate; either works. Leave "open tracking" and "click tracking" **off**.
3. **Add the DNS records Resend shows you.** It lists a few records to copy into the domain's DNS settings. If the domain is on Cloudflare, Resend may be able to add them for you automatically (follow its prompts); otherwise open the domain in the Cloudflare dashboard, go to DNS, and add each record exactly as shown. Then press Verify in Resend. It can take from a few minutes to a day for the records to be noticed.
4. **Create an API key** in Resend (API Keys, then Create). Choose the permission that only allows **sending** email, and limit it to your domain if it offers that. Copy the key (it starts with `re_`). Resend shows it only once.
5. **Give the key to the app** from your computer, in the project folder. It is stored as a Cloudflare secret, never in a file:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
   Paste the key when asked. (For the staging copy add `--env staging`.)
6. **Set the sender address.** In `wrangler.jsonc`, change `MAIL_FROM` to an address on your verified domain, keeping the name in front, for example:
   ```
   "MAIL_FROM": "GEMA Fleet <no-reply@mail.yourdomain.org>"
   ```
   (It appears in two places: the main settings and `env.staging`.)
7. **Set the real address of the app.** `APP_URL` in `wrangler.jsonc` must be the address people actually open (for example `https://fleet.yourdomain.org` or the `workers.dev` address). Every link in the emails is built from it. If it is wrong, the links will not work.
8. **Deploy:** `npm run deploy`
9. **Test it.** Open the app, log out, press **Forgot password?**, and enter your own email address. The email should arrive within a minute (check spam the first time). Then try adding a test person with "Email an invite link" using an address you can read.

The Users screen tells you which mode you are in: the note at the top says "Email isn't set up..." until both the key and the sender are present.

## What the free plan allows

Resend's free plan (checked on the Resend pricing page): **3,000 emails a month and 100 emails a day**, up to 3 domains. A daily limit is counted per UTC day and resets at midnight UTC (that is 8 pm in Guyana). If the limit is reached, Resend refuses further emails until it resets; the app then shows "Couldn't send the email: ..." to the administrator. For a team of 50 to 100 people this is far more than needed. Resend also limits requests to 10 per second, which this app never approaches.

Sources:
- Pricing and free-plan limits: <https://resend.com/pricing>
- Daily, monthly and per-second limits: <https://resend.com/docs/api-reference/rate-limit>
- Sending API and error names: <https://resend.com/docs/api-reference/emails/send-email> and <https://resend.com/docs/api-reference/errors>

Plans and prices can change, so check these pages if it matters.

## How the links behave

- An **invite** link works once and expires after **7 days**. A **reset** link works once and expires after **1 hour**.
- Sending a new link cancels the older one of the same kind.
- Deactivated accounts cannot use links or ask for them.
- Using a link logs the person out of every other device and logs them in on this one.
- The "Forgot password?" form always shows the same message, whether or not the address has an account, so nobody can use it to find out who has an account. It sends at most 3 emails per address and 10 requests per network address per hour.
- Sending a reset link from the Users screen does **not** change the person's current password. It keeps working until they use the link.

## If email stops working

Nothing else in the app depends on email. If the Resend key is lost, the domain lapses, or the daily limit is reached:

- On the Users screen, **Set password** lets you choose a password for anyone, and they can log in straight away.
- If nobody can log in as administrator, from a computer with this project and a Cloudflare login:
  ```bash
  npm run create-admin -- --email you@example.org --name "Your Name" --remote --invite
  ```
  This prints a set-password link to open in your browser (no email involved). Or use `--password-prompt` to type a password at a hidden prompt, or leave both off to get a one-time temporary password.
- To switch email off completely, delete the secret: `npx wrangler secret delete RESEND_API_KEY`, then deploy. The app goes back to "you choose people's passwords".

## Cloudflare's own email service

Cloudflare has its own Email Service that can send email from a Worker without a separate provider. When this was written it was in **public beta** and listed for the **Workers Paid plan** (about US$5 a month), and Cloudflare's documentation says that before a sending domain is set up it can only send to addresses you have verified in your account. Details and limits may have changed: see <https://developers.cloudflare.com/email-service/> and <https://developers.cloudflare.com/changelog/post/2026-04-16-email-sending-public-beta/>. This app uses Resend because its free plan can send to anyone. Switching later would only mean replacing `src/worker/mail.ts`.

## For developers

- Settings: secret `RESEND_API_KEY`, variable `MAIL_FROM`, variable `APP_URL`. Email is "on" only when both `RESEND_API_KEY` and `MAIL_FROM` are set (`emailEnabled()` in `src/worker/mail.ts`).
- Links look like `APP_URL/set-password#t=<token>`. The secret is after the `#`, so browsers do not send it to the server or in the Referer header; the page reads it, removes it from the address bar, and posts it to `/api/auth/set-password`.
- **Local testing without sending anything:** run the Worker with `MAIL_SINK=1`, `RESEND_API_KEY` and `MAIL_FROM` set to any dummy values and `APP_URL` set to a `localhost` address (for example `wrangler dev --var MAIL_SINK:1 --var RESEND_API_KEY:x --var 'MAIL_FROM:GEMA Fleet <no-reply@gema.test>' --var APP_URL:http://localhost:8787`). Messages are then saved to the file bucket instead of sent, and `GET /api/dev/last-mail?to=<address>` returns the latest one. The sink does nothing unless `APP_URL` is `localhost`, and `MAIL_SINK` is not in `wrangler.jsonc`, so it cannot be switched on by accident in production. `npm run e2e` uses it.
