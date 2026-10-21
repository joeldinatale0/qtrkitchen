# QTR Kitchen Ordering

Internal ordering system between the four QTR shops and the central kitchen
(Moonee Ponds). Each shop logs in, enters quantities for what they need
delivered the next morning, and submits before end of day. The kitchen logs
in to see all shop orders combined, a per-shop breakdown, and can print a
packing slip per shop.

## Running it locally

This folder has its own local copy of Node.js in `.tools/` so you don't need
to install anything system-wide. From inside this folder:

```bash
.tools/node/bin/node server.js
```

Then open http://localhost:3000 in a browser.

If you install Node.js yourself later (recommended for actually deploying
this), you can just run `npm install` once and then `npm start` instead.

## Logins

The database seeds these accounts the first time it runs (see `db.js`):

| Shop | Username | Password |
|---|---|---|
| QTR Essendon | `essendon` | `essendon2026` |
| QTR Highpoint | `highpoint` | `highpoint2026` |
| QTR Moonee Ponds | `mooneeponds` | `mooneeponds2026` |
| QTR Melbourne Central | `melbournecentral` | `melbournecentral2026` |
| Central Kitchen | `kitchen` | `kitchen2026` |

**Change these before going live.** There's no self-service password reset
yet — to change one, edit the seed list in `db.js` (or ask me to add a
password-change screen) and delete `data.sqlite` to reseed, or update the
row directly in the database.

## Managing the item catalog

Log in as `kitchen` and go to "Manage Items" to add, retire, or delete items
within each category (Food, Grab n Go Cans, Juices, Pastries/Cakes, Paper
Goods). The six categories themselves are fixed in `db.js`. "Other" is
always a free-text box on the order form, not a catalog list.

## How orders work

- A shop's order is always "for tomorrow" — there's no date picker on the
  shop side, to keep it simple.
- A shop can resubmit any time before the kitchen preps; resubmitting
  replaces their order for that date rather than adding a second one.
- The kitchen dashboard defaults to tomorrow's date but has a date picker to
  look back at any previous day's orders.
- There's no hard cutoff enforced yet (e.g. locking orders at 3pm) — it's
  just a convention for now. Easy to add later if needed.

## Data storage

Everything is stored in a local SQLite file, `data.sqlite`, created
automatically on first run. It's not checked into git (see `.gitignore`).
**Back this file up if you deploy this somewhere** — losing it loses order
history.

## Deploying so all 4 shops can reach it

Right now this only runs on this computer at `localhost:3000`, which only
you can reach. To make it usable by all shops over the internet, it needs
to run on a hosting service with persistent storage. When you're ready for
that, come back and we'll set up a hosting account together (e.g. Railway
or Render) — a few clicks on your end, and I'll wire up the deployment.
