# QTR Kitchen Ordering

Internal ordering system between the four QTR shops and the central kitchen
(Moonee Ponds). Each shop logs in, enters quantities for what they need
delivered the next morning, and submits by 2:00 PM (Melbourne time) for
next-day delivery. The kitchen logs in to see all shop orders combined, a
per-shop breakdown, order history, and can print a packing slip per shop.

**Live site:** https://app-production-aab6.up.railway.app
**Code:** https://github.com/joeldinatale0/qtrkitchen (this repo)
**Hosting:** Railway (project `qtr-kitchen-ordering`)

## 🆘 If something breaks — recovery steps

1. **Site seems down or broken:** Log into [railway.com](https://railway.com)
   → `qtr-kitchen-ordering` project → `app` service → click **Restart**.
   Fixes most issues in under a minute.
2. **Need the data and Railway/this laptop is unreachable:** Check
   `qtrcentralkitchen@gmail.com` for an email titled "Daily backup — \<date\>"
   — a full copy of the database is emailed there automatically every day.
3. **Need to redeploy from scratch (new host, new developer, etc.):** This
   repo is a complete, standard Node.js/Express app — nothing exotic. Clone
   it, run `npm install`, then `npm start`. See "Environment variables"
   below for what needs to be set on the new host.
4. **This laptop is lost/dead:** Doesn't matter — the code lives on GitHub
   (link above) and the live site runs on Railway's servers, not this
   laptop. The laptop is only used to push code changes, not to run
   anything.

## Logins

Shop logins are reached via the home page (pick your store, enter just the
password). Current credentials:

| Shop | Username | Password |
|---|---|---|
| QTR Essendon | `essendon` | `QTRESSENDON` |
| QTR Highpoint | `highpoint` | `QTRHP` |
| QTR Moonee Ponds | `mooneeponds` | `QTRMP` |
| QTR Melbourne Central | `melbournecentral` | `QTRMC` |
| Central Kitchen | `kitchenstaff` | `kitchen2026` |

No self-service password reset yet — to change one, run a one-off script
like the examples in `scripts/` against the live database (ask Claude, or
see `scripts/update-passwords-2026-10-20.js` as a template), using
`railway ssh -- node scripts/your-script.js`.

## How orders work

- A shop's order is always "for tomorrow" — no date picker on the shop side.
- Orders are due by **2:00 PM Melbourne time**. Submitting after that is
  automatically flagged as a **late order** (shown on the confirmation page,
  the kitchen dashboard, and in the email subject line as "LATE ORDER!").
- A shop can edit/resubmit any time before the kitchen preps — this replaces
  their order for that date rather than adding a second one.
- Items can have a **par level per shop** (set via "Par Levels" in the
  kitchen nav). If a shop has a par level set for an item, the order form
  shows Current Stock / Suggested / Order fields instead of a plain quantity
  box, auto-calculating the suggestion as `par − stock`.
- The kitchen dashboard shows combined totals + per-shop breakdowns for any
  date, with "Order History" listing every date that's had orders.

## Managing the item catalog

Log in as kitchen staff → "Manage Items" to add, rename, retire, or delete
items within each category (Food, Grab n Go, Juices, Pastries/Cakes, Paper
Goods). "Other" is always a free-text box on the order form, not a catalog
list. Par levels are managed separately under "Par Levels" (per shop, not
per item globally).

## Email notifications

Every order submission emails `qtrcentralkitchen@gmail.com` with the order
details, sent via [Resend](https://resend.com) (HTTPS API, not SMTP — cloud
hosts like Railway block outbound SMTP ports, so a transactional email API
is used instead). The same mechanism sends the daily database backup.

## Environment variables

Set these on whatever host runs this app (currently configured on Railway):

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Random string used to sign session cookies |
| `DB_PATH` | Path to the SQLite file — point this at a persistent volume in production, e.g. `/data/data.sqlite` |
| `RESEND_API_KEY` | API key for sending order/backup emails via Resend |
| `ORDER_EMAIL_TO` | Optional — overrides the email recipient (defaults to `qtrcentralkitchen@gmail.com`) |
| `PORT` | Usually set automatically by the host |

## Data storage & backups

Everything lives in a single SQLite file. In production this sits on a
persistent Railway volume (`/data/data.sqlite`), separate from the app
container, so it survives restarts and redeploys. A full copy is also
emailed daily (see "If something breaks" above) as a true off-platform
backup.

Locally, the file is `data.sqlite` in this folder and is **not** checked
into git (see `.gitignore`) — it's regenerated automatically (with fresh
seed data) if missing.

## Running it locally

This folder has its own local copy of Node.js in `.tools/` so you don't need
to install anything system-wide:

```bash
.tools/node/bin/node server.js
```

Then open http://localhost:3000. Or, if you've installed Node.js yourself,
just run `npm install` once and then `npm start`.

## Reliability notes

- **Session storage:** persisted in SQLite (not in-memory), so logins
  survive app restarts and redeploys.
- **Login rate-limiting:** 10 attempts per username per 15 minutes.
- **Auto-restart:** Railway restarts the app automatically if it ever
  crashes — no manual action needed for transient issues.
- **Uptime monitoring:** not yet set up (planned).
