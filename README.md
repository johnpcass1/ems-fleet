# EMS Fleet

Free, open-source fleet maintenance and ambulance readiness software for emergency medical services.

## Why this exists

Commercial fleet maintenance and EMS readiness software is priced and built for well-funded agencies in high-income countries. Many EMS systems in low- and middle-income countries, and under-resourced services anywhere, can't pay those licence fees, so they track ambulance maintenance, repairs and daily equipment checks on paper or in spreadsheets, if at all. When an ambulance is out of service for maintenance that could have been planned, or leaves the station missing equipment, patients wait longer for care.

EMS Fleet is meant to close that gap. Any agency can run a modern, secure system that it owns outright:

- **Free to use and adapt.** MIT licensed, with no licence fees, per-user charges or vendor lock-in.
- **Cheap to run.** It runs on Cloudflare and is sized to fit Cloudflare's free plan for a fleet of about 20 to 50 ambulances and 50 to 100 users. See [docs/DEPLOY.md](docs/DEPLOY.md).
- **Works on the phones crews already carry.** It's a website, so there's nothing to install, and every screen works at phone size.
- **The agency owns its data.** Each agency hosts its own copy, with nightly backups it controls.

## Who it's for

National and regional EMS authorities, ministries of health, municipal and volunteer ambulance services, and NGOs that run ambulance fleets, especially where commercial software isn't affordable. It was first built for Guyana's national EMS ambulance program, which is why the sample fleet and demo use Guyanese stations. Nothing in it is specific to one country: each agency sets its own stations, vehicles, maintenance schedules, inspection checklists, roles and currency.

## What it does

- **Fleet status:** which ambulances are in service, limited, in reserve or out (for service, repairs or parts), with a Dispatch screen showing only what's available
- **Preventive maintenance:** what's due or overdue, by engine hours, days or distance
- **Problems, work orders and repairs:** crews report problems from their phones, which become work orders with approvals, parts, labour and costs
- **Shift-start bus checks:** a full ambulance inspection on a phone, with equipment shortages tracked until they are restocked
- **People and permissions:** seven roles with adjustable permissions, a full activity history, and several agencies on one site, kept completely separate

**Not included on purpose:** fuel tracking, GPS, email or text *alerts* (email for account setup and password reset is optional: see [docs/EMAIL.md](docs/EMAIL.md)), and offline mode. See [docs/HANDOVER.md](docs/HANDOVER.md) for ideas that could be added later.

## Using it for your agency

1. Try the demo first. Click **Try the demo** on the login page of a running copy to use it with sample data and no account.
2. Fork this repository, or use it as a template.
3. Follow [docs/DEPLOY.md](docs/DEPLOY.md) to set up your own copy on a free Cloudflare account.
4. Read [docs/HANDOVER.md](docs/HANDOVER.md) for running it day to day, and [docs/SECURITY.md](docs/SECURITY.md) for how accounts and data are protected.

## Contributing

Issues and pull requests are welcome, especially from people who run or support EMS fleets in low-resource settings. Ideas, bug reports and notes on what does or doesn't fit how your service works are all useful.

## What people can do

| Role | What they can do |
| --- | --- |
| System administrator | Everything a fleet manager can do, plus changing what roles and individual people can do; manages fleet managers and below. No backups |
| Fleet manager | Whole fleet: units, status, work orders and approvals, parts, setup, users |
| Base supervisor | Their own bases: status, moving units, work orders, parts, reports |
| Mechanic | Work orders assigned to them; log hours and report problems |
| Crew | Report problems and log hours for their bases |
| Dispatcher | The Dispatch screen only (which units are available), no costs or notes |
| Viewer | Read only |

Roles are only the starting point, and there are three levels of administrator:

| | Fleet manager | System administrator | Super user |
| --- | --- | --- | --- |
| Add people and set roles | Base supervisor and below | Fleet manager and below | Anyone (including system administrators) |
| Change what one person can do (Users > **Permissions**) | No | Fleet manager and below | Anyone |
| Change what a role can do by default (**Roles & permissions**) | No | Fleet manager and below (not system administrator) | Every role |
| Grant Manage people or Change setup | No | No | Yes |
| Backups (panel, list, download, run) | No | No | Yes (the nightly backup runs for everyone) |
| Features (Photo and PDF uploads) | No | No | Yes |
| **Activity history** (who changed what, and when, including sign-ins) | No | Yes | Yes |

The **super user** is set by a Cloudflare secret, `SUPERUSER_EMAILS` (see [docs/HANDOVER.md](docs/HANDOVER.md)) and has every permission. The **Roles & permissions** screen (Admin group in the sidebar) is a matrix of what each role can do by default, with a "Changed" marker against the built-in defaults, **Reset to default**, one **Save changes** button at the top right for all edits, and a confirmation that says how many people a change affects. A person's own changes beat their role's, which beat the built-in default. Each switch in the per-person drawer says whether it comes from the role default, a role change or a personal change. **Photo and PDF uploads are turned off** site-wide until the super user turns them on in Setup > Features; the upload buttons stay visible but disabled so people know the capability exists.

**Agencies.** One site can serve several agencies (organisations). Each has its own vehicles, bases, people, roles, settings, work order numbers, files and activity history, and nobody in one agency can see or change another's. People log in with an **Agency ID** (for example `GEMA`), their email and their password; the same email can be used in two agencies as two separate accounts. The super user adds and manages agencies in **Admin > Agencies** (see [docs/HANDOVER.md](docs/HANDOVER.md), *Agencies*). The first agency is `GEMA`, and existing data belongs to it.

These rules are enforced by the server, not just hidden in the screen. People log in with an Agency ID, an email and a password. There is no public sign-up: a fleet manager or system administrator creates each account and either chooses the person's password (and hands it over) or, once email is set up, sends an invite link so the person chooses their own. With email set up there is also a "Forgot password?" link on the login page. See [docs/EMAIL.md](docs/EMAIL.md).

**Bus checks.** At the start of each shift the crew do a full inspection of their ambulance on their phone (**Operations > Bus check**): the unit and station, who is on the crew, mileage and engine hours, every item on the checklist, and a tick to confirm. Anything short or failed is recorded as an **equipment shortage** (not a vehicle problem: it stays off the Problems page, work orders and a unit's status) for someone to restock, a problem the crew type in goes to maintenance as a vehicle problem, and the mileage and hours are saved as a meter reading. Managers see who has done their check, the open equipment shortages (**Equipment** tab, where **Mark restocked** closes them), the **Shortage report** and the full history at **Admin > Bus checks**, and fleet managers and system administrators can change the checklists there (**Requirements**). Four switches in Roles & permissions control it: *Do bus checks* (crew, base supervisors, fleet managers, system administrators), *View bus check reports* (base supervisors for their own bases, fleet managers, system administrators), *Mark equipment restocked* (the same roles) and *Edit bus check requirements* (fleet managers and system administrators). See [docs/HANDOVER.md](docs/HANDOVER.md).

**Demo.** Anyone can click **Try the demo** under the login form to try the app on the GEMA sample fleet without an account. A menu at the top right switches between one demo person for each role (system administrator, fleet manager, base supervisor, mechanic, crew, dispatcher, viewer), so visitors can see exactly what each type of user sees and can do. Everything works as it does for real, but **the demo never talks to the real server or database**: the app's own API runs inside the visitor's browser on a throwaway copy of the sample data, nothing is saved, and reloading the page (or **Exit demo**) starts again. Photo and PDF uploads are off and cannot be turned on in the demo, and backups, agencies, passwords and email links are left out. See [docs/HANDOVER.md](docs/HANDOVER.md), *Demo*.

## Quick start on your own computer

You need Node.js 22 or newer.

```bash
npm install
npm run dev                                  # builds the site, creates a local database, starts it on http://localhost:8787
npm run seed:demo                            # (optional) loads a demo fleet, in another terminal
npm run create-admin -- --email you@example.org --name "Your Name"
```

The last command prints a temporary password. Open http://localhost:8787, log in with Agency ID `GEMA`, your email and that password, and choose your own password. (Add `--password-prompt` to type the password at a hidden prompt instead, or `--invite` to get a set-password link.)

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
| `npm run create-admin -- --email ... --name ... [--agency CODE] [--password-prompt \| --invite] [--remote]` | Create a system administrator in an agency (default `GEMA`), with a temporary password, a hidden password prompt, or a set-password link |

## How it is built

```
src/shared/   Rules used by both the browser and the server (PM due dates, availability, permissions, costs)
src/worker/   The API (Hono): login, data sync, business rules, agencies, files, backups, nightly cron
src/client/   The website (Vite + TypeScript), ported from the prototype
migrations/   Database tables (D1 / SQLite)
scripts/      create-admin, seed, import, local dev, browser tests
test/         Unit and API tests
docs/         Deploy, hand-over, security and restore guides
```

How data reaches the browser: the browser asks `GET /api/sync?since=<cursor>` about every 20 seconds (15 seconds on the Dispatch screen) and whenever the window is focused again. The server returns only what changed since the cursor, including deletions. Every change goes through an action endpoint (for example "start this work order") where the server checks the person's role, validates the input, applies all related changes in one database batch, and writes an audit log row.

The website's look and behaviour is the same as the prototype. Differences: there is a login page, a Users screen, a Roles & permissions screen, an **Activity history** screen (Admin group; super user and system administrators: searchable, filterable by person, type and date, with before and after for every change, sign-ins and CSV export), a Backups panel (super user only), no role switcher, and no "Load sample data" button (administrators can still "Remove sample data").

## License

EMS Fleet is open source under the [MIT License](LICENSE). Any EMS agency, ministry of health or developer may use, change and host it, as long as the copyright notice is kept.
