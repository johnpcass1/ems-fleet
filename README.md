# GEMA Fleet

Fleet maintenance for the Guyana EMS ambulance program (GEMA). It tracks which ambulances are in service, what is due for preventive maintenance (PM), problems reported by crews, work orders, parts, and costs (in Guyanese dollars, G$).

It runs entirely on Cloudflare: the Worker (API and web pages), a D1 database, and R2 file storage. It is built to fit Cloudflare's free plan for a fleet of about 20 to 50 ambulances and 50 to 100 users. See [docs/DEPLOY.md](docs/DEPLOY.md).

**Not included on purpose:** fuel tracking, GPS, email or text *alerts* (email for account setup and password reset is optional: see [docs/EMAIL.md](docs/EMAIL.md)), and offline mode. See [docs/HANDOVER.md](docs/HANDOVER.md) for ideas that could be added later.

## What people can do

| Role | What they can do |
| --- | --- |
| System administrator | Everything a fleet manager can do, plus backups; manages fleet managers and below |
| Fleet manager | Whole fleet: units, status, work orders and approvals, parts, setup, users |
| Base supervisor | Their own bases: status, moving units, work orders, parts, reports |
| Mechanic | Work orders assigned to them; log hours and report problems |
| Crew | Report problems and log hours for their bases |
| Dispatcher | The Dispatch screen only (which units are available), no costs or notes |
| Viewer | Read only |

Roles are only the starting point. A **super user** (set in code, see [docs/HANDOVER.md](docs/HANDOVER.md)) has every permission and controls site-wide **Features**, and a super user, system administrator or fleet manager can switch individual permissions on or off for the people below them (Users screen, **Permissions**). **Photo and PDF uploads are turned off** site-wide until the super user turns them on in Setup > Features; the upload buttons stay visible but disabled so people know the capability exists.

These rules are enforced by the server, not just hidden in the screen. People log in with an email and password. There is no public sign-up: a fleet manager or system administrator creates each account and either chooses the person's password (and hands it over) or, once email is set up, sends an invite link so the person chooses their own. With email set up there is also a "Forgot password?" link on the login page. See [docs/EMAIL.md](docs/EMAIL.md).

## Quick start on your own computer

You need Node.js 22 or newer.

```bash
npm install
npm run dev                                  # builds the site, creates a local database, starts it on http://localhost:8787
npm run seed:demo                            # (optional) loads a demo fleet, in another terminal
npm run create-admin -- --email you@example.org --name "Your Name"
```

The last command prints a temporary password. Open http://localhost:8787, log in, and choose your own password. (Add `--password-prompt` to type the password at a hidden prompt instead, or `--invite` to get a set-password link.)

Nothing in this project talks to Cloudflare until you deploy it yourself. The local database lives in the `.wrangler` folder and can be deleted at any time.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Build and run locally with a local database and file store |
| `npm test` | Unit tests (the 34 maintenance-logic tests) and API tests with a real local database |
| `npm run build` | Type-check everything and build the website into `dist/` |
| `npm run e2e` | Browser walk-through at phone and desktop sizes, light and dark, saving screenshots |
| `npm run deploy` / `deploy:staging` | Build and deploy to Cloudflare (see DEPLOY.md) |
| `npm run db:migrate` | Apply database changes locally (`:remote` and `:staging` for Cloudflare) |
| `npm run seed:demo` | Load the demo fleet (marked as sample data) |
| `npm run import:prototype -- <folder>` | Import data exported from the earlier prototype |
| `npm run create-admin -- --email ... --name ... [--password-prompt \| --invite] [--remote]` | Create a system administrator (temporary password, hidden password prompt, or set-password link) |

## How it is built

```
src/shared/   Rules used by both the browser and the server (PM due dates, availability, permissions, costs)
src/worker/   The API (Hono): login, data sync, business rules, files, backups, nightly cron
src/client/   The website (Vite + TypeScript), ported from the prototype
migrations/   Database tables (D1 / SQLite)
scripts/      create-admin, seed, import, local dev, browser tests
test/         Unit and API tests
docs/         Deploy, hand-over, security and restore guides
```

How data reaches the browser: the browser asks `GET /api/sync?since=<cursor>` about every 20 seconds (15 seconds on the Dispatch screen) and whenever the window is focused again. The server returns only what changed since the cursor, including deletions. Every change goes through an action endpoint (for example "start this work order") where the server checks the person's role, validates the input, applies all related changes in one database batch, and writes an audit log row.

The website's look and behaviour is the same as the prototype. Differences: there is a login page, a Users screen, a Backups panel, no role switcher, and no "Load sample data" button (administrators can still "Remove sample data").
