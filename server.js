const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const db = require("./db");
const { buildWeeklySummaryPdf } = require("./invoice-pdf");
const { COGS_BY_SHOP } = require("./cogs-data");
const {
  SHOP_INTEGRATIONS,
  buildDailyShopReport,
  formatDailyReportEmail,
  buildCookieSalesReport,
  buildItemSalesSearch,
  formatSalesSearchEmail,
  buildNaturalSearch,
  formatNaturalSearchEmail,
  buildCateringOrders,
} = require("./shop-reports");

const app = express();
const PORT = process.env.PORT || 3000;

// Keep the server alive even if a background email send throws asynchronously.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (ignored, server still running):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (ignored, server still running):", reason);
});

const EMAIL_TO = process.env.ORDER_EMAIL_TO || "qtrcentralkitchen@gmail.com";
const DAILY_REPORT_EMAIL_TO = process.env.DAILY_REPORT_EMAIL_TO || "thecoffeeqtr@gmail.com";
const ORDER_CUTOFF_HOUR = 14; // 2:00 PM

// Kitchen prep stations, in the order the food order email lists them —
// matches how the kitchen physically works through an order, not the
// shop-facing ordering menu's browsing categories.
const KITCHEN_SECTION_ORDER = ["toasties", "muffins_burgers", "wraps", "baked_goods", "grab_n_go", "juices", "extras"];
const KITCHEN_SECTION_LABELS = {
  toasties: "Toasties",
  muffins_burgers: "Egg Muffins & Burgers",
  wraps: "Wraps",
  baked_goods: "Homemade Baked Goods",
  grab_n_go: "Grab n Go",
  juices: "Juices",
  extras: "Extras",
};

// Every email in the app sends through Gmail (an App Password on
// qtrcentralkitchen@gmail.com), not Resend — Resend's sandbox mode only
// delivers to one pre-verified address until a domain is verified there,
// which blocked sending reports to a second inbox. Gmail has no such limit.
const GMAIL_USER = process.env.GMAIL_USER || "qtrcentralkitchen@gmail.com";
const mailTransport = process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
  : null;

async function sendEmail({ to, subject, text, attachments }) {
  if (!mailTransport) throw new Error("GMAIL_APP_PASSWORD is missing");
  await mailTransport.sendMail({
    from: `QTR Kitchen Ordering <${GMAIL_USER}>`,
    to,
    subject,
    text,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      encoding: "base64",
    })),
  });
}

// Orders are due by 2:00 PM Melbourne time each day for next-day delivery.
function isLateSubmission() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute >= ORDER_CUTOFF_HOUR * 60;
}

// Fire-and-forget: never block the order-submit response on email delivery.
// Sent via Resend's HTTPS API (not raw SMTP) since cloud hosts commonly block
// outbound SMTP ports for spam prevention.
function sendOrderEmail(shop, deliveryDateLabel, orderedItems, customNotes, isLate, isEdit, areaLabel) {
  if (!process.env.GMAIL_APP_PASSWORD) return;

  // Grouped by kitchen prep station, in KITCHEN_SECTION_ORDER, so the
  // kitchen can work straight down the email station by station instead of
  // hunting through one flat list.
  const bySection = {};
  for (const i of orderedItems) {
    const section = KITCHEN_SECTION_ORDER.includes(i.kitchenSection) ? i.kitchenSection : "extras";
    if (!bySection[section]) bySection[section] = [];
    bySection[section].push(i);
  }

  const lines = [];
  for (const section of KITCHEN_SECTION_ORDER) {
    const items = bySection[section];
    if (!items || !items.length) continue;
    if (lines.length) lines.push("");
    lines.push(`${KITCHEN_SECTION_LABELS[section]}:`);
    items.forEach((i) => lines.push(`  - ${i.quantity} x ${i.name} (${i.unit})`));
  }
  if (customNotes.length) {
    lines.push("", "Custom requests:");
    customNotes.forEach((note) => lines.push(`  - ${note}`));
  }
  if (!orderedItems.length && !customNotes.length) {
    lines.push("  (no items selected)");
  }

  const editNotice = isEdit
    ? "THIS IS AN EDITED ORDER! Disregard the last order for this date — the list below replaces it entirely.\n\n"
    : "";
  const lateNotice = isLate
    ? `This order was submitted after the ${ORDER_CUTOFF_HOUR}:00 cutoff.\n\n`
    : "";
  const label = areaLabel ? `${areaLabel} order` : "New order";
  const text = `${editNotice}${lateNotice}${label} from ${shop.name} for delivery ${deliveryDateLabel}\n\n${lines.join("\n")}\n`;
  const subjectPrefix = isEdit
    ? "THIS IS AN EDITED ORDER! Disregard the last order — "
    : isLate
    ? "LATE ORDER! "
    : "";
  const subjectArea = areaLabel ? `${areaLabel} order` : "Order";
  const subject = `${subjectPrefix}${subjectArea} from ${shop.name} — delivery ${deliveryDateLabel}`;

  sendEmail({ to: EMAIL_TO, subject, text })
    .then(() => console.log(`Order email sent for ${shop.name}`))
    .catch((err) => console.error("Failed to send order email:", err.message));
}

function melbourneDateString() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function melbourneHour() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    hourCycle: "h23",
    hour: "2-digit",
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour").value);
}

// Emails a full copy of the database (as an attachment) once a day, so order
// history survives even if the Railway volume is ever lost or corrupted.
// Uses better-sqlite3's safe .backup() rather than reading the live file
// directly, to avoid grabbing an inconsistent snapshot mid-write.
async function sendDailyBackupIfDue() {
  if (!process.env.GMAIL_APP_PASSWORD) return;
  const today = melbourneDateString();
  const already = db.prepare("SELECT 1 FROM backup_log WHERE backup_date = ?").get(today);
  if (already) return;
  if (melbourneHour() < 3) return; // wait for a quiet early-morning window

  const tempPath = path.join(os.tmpdir(), `qtr-backup-${Date.now()}.sqlite`);
  try {
    await db.backup(tempPath);
    const fileBuffer = fs.readFileSync(tempPath);

    await sendEmail({
      to: DAILY_REPORT_EMAIL_TO,
      subject: `Daily backup — ${today}`,
      text: `Automatic daily backup of the QTR Kitchen Ordering database for ${today}. Keep this email in case data ever needs to be restored.`,
      attachments: [
        {
          filename: `qtr-kitchen-backup-${today}.sqlite`,
          content: fileBuffer.toString("base64"),
        },
      ],
    });

    db.prepare("INSERT INTO backup_log (backup_date) VALUES (?)").run(today);
    console.log(`Daily backup emailed for ${today}`);
  } catch (err) {
    console.error("Daily backup failed:", err.message);
  } finally {
    fs.rm(tempPath, { force: true }, () => {});
  }
}

// Shared by the Monday auto-email and the on-demand admin PDF view.
function buildWeeklyInvoiceData(shopId, weekStart, weekEnd) {
  const dailyRows = db
    .prepare(
      `SELECT o.delivery_date, oi.name, oi.unit, SUM(oi.quantity) AS quantity, MAX(i.price) AS price
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN items i ON i.id = oi.item_id
       WHERE o.shop_id = ? AND o.delivery_date BETWEEN ? AND ? AND oi.item_id IS NOT NULL
       GROUP BY o.delivery_date, oi.name, oi.unit
       ORDER BY o.delivery_date, oi.name`
    )
    .all(shopId, weekStart, weekEnd);

  const dailyBreakdown = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    dailyBreakdown.push({
      dateLabel: formatDate(date),
      items: dailyRows
        .filter((r) => r.delivery_date === date)
        .map((r) => ({ name: r.name, unit: r.unit, quantity: r.quantity, price: r.price })),
    });
  }

  const weeklyTotalsMap = {};
  for (const r of dailyRows) {
    const key = `${r.name}|${r.unit}`;
    if (!weeklyTotalsMap[key]) {
      weeklyTotalsMap[key] = { name: r.name, unit: r.unit, quantity: 0, price: r.price };
    }
    weeklyTotalsMap[key].quantity += r.quantity;
  }
  const weeklyTotals = Object.values(weeklyTotalsMap).sort((a, b) => a.name.localeCompare(b.name));

  return { dailyBreakdown, weeklyTotals };
}

async function sendWeeklySummaryIfDue() {
  if (!process.env.GMAIL_APP_PASSWORD) return;
  const today = melbourneDateString();
  const todayDow = new Date(today + "T00:00:00").getDay(); // 0 = Sunday
  if (todayDow !== 0) return;
  if (melbourneHour() < 5) return; // Sunday 5:00 AM Melbourne time

  // The invoiced week runs Monday-Sunday by DELIVERY date: Monday's
  // delivery (from last Sunday's order) through TODAY's own delivery (from
  // yesterday/Saturday's order, already locked in by 5am). A full 7 days.
  // The order placed later today (Sunday, after this invoice goes out) is
  // for tomorrow's Monday delivery, which deliberately falls outside this
  // window — it starts next week's invoice instead, not this one.
  const weekStart = addDays(today, -6);
  const weekEnd = today;

  const shops = db.prepare("SELECT * FROM users WHERE role = 'shop'").all();

  for (const shop of shops) {
    const already = db
      .prepare("SELECT 1 FROM invoice_log WHERE week_start_date = ? AND shop_id = ?")
      .get(weekStart, shop.id);
    if (already) continue;

    try {
      const { dailyBreakdown, weeklyTotals } = buildWeeklyInvoiceData(shop.id, weekStart, weekEnd);

      const pdfBuffer = await buildWeeklySummaryPdf(
        shop,
        formatDate(weekStart),
        formatDate(weekEnd),
        dailyBreakdown,
        weeklyTotals
      );

      await sendEmail({
        to: DAILY_REPORT_EMAIL_TO,
        subject: `Weekly Invoice — ${shop.name} — ${weekStart} to ${weekEnd}`,
        text: `Attached: itemised weekly invoice for ${shop.name} covering ${weekStart} to ${weekEnd}.`,
        attachments: [
          {
            filename: `weekly-invoice-${shop.slug}-${weekStart}.pdf`,
            content: pdfBuffer.toString("base64"),
          },
        ],
      });

      db.prepare(
        "INSERT INTO invoice_log (week_start_date, shop_id) VALUES (?, ?)"
      ).run(weekStart, shop.id);
      console.log(`Weekly summary emailed for ${shop.name}, week of ${weekStart}`);
    } catch (err) {
      console.error(`Weekly summary failed for ${shop.name}:`, err.message);
    }
  }
}

const DAILY_SHOP_REPORT_HOUR = 17; // 5:00 PM Melbourne time

// Persists the computed daily report as one row of history the AI search
// can later query as a trend — the report itself was previously computed
// once and emailed, then thrown away.
function saveShopSnapshot(shopSlug, report) {
  db.prepare(
    `INSERT INTO daily_shop_snapshots
       (shop_slug, report_date, net_sales_cents, transaction_count, avg_spend_cents, discounts_cents,
        target_cents, labour_hours, labour_cost_cents, labour_pct, cogs_cents, cogs_pct, prime_cost_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(shop_slug, report_date) DO UPDATE SET
       net_sales_cents=excluded.net_sales_cents, transaction_count=excluded.transaction_count,
       avg_spend_cents=excluded.avg_spend_cents, discounts_cents=excluded.discounts_cents,
       target_cents=excluded.target_cents, labour_hours=excluded.labour_hours,
       labour_cost_cents=excluded.labour_cost_cents, labour_pct=excluded.labour_pct,
       cogs_cents=excluded.cogs_cents, cogs_pct=excluded.cogs_pct, prime_cost_pct=excluded.prime_cost_pct,
       saved_at=CURRENT_TIMESTAMP`
  ).run(
    shopSlug,
    report.dateStr,
    Math.round(report.netSales * 100),
    report.transactionCount,
    Math.round(report.avgSpend * 100),
    Math.round(report.discounts * 100),
    report.targetDollars !== null ? Math.round(report.targetDollars * 100) : null,
    report.labourHours,
    report.labourCost !== null ? Math.round(report.labourCost * 100) : null,
    report.labourPct,
    Math.round(report.cogsDollars * 100),
    report.cogsPct,
    report.primeCostPct
  );
}

// One-time (re-runnable) backfill so trend/report questions work for past
// days too, not just going forward from when daily_shop_snapshots started
// being written to. Square/Tanda still have the underlying history for any
// past date (buildDailyShopReport already supports an overrideDateStr) —
// today's live $ labour cost just never applies to a backfilled past day,
// same limit the daily report itself already has. Sequential, not
// parallel, and gated by the same kind of lock as the search box — this
// hits Square/Tanda once per shop per day and running it alongside a
// live search is exactly the kind of overlap that crashed the app before.
let backfillInProgress = false;

async function backfillShopSnapshots(days) {
  if (backfillInProgress) throw new Error("A backfill is already running");
  backfillInProgress = true;
  const actualTodayStr = melbourneDateString();
  let saved = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const [shopSlug, config] of Object.entries(SHOP_INTEGRATIONS)) {
      for (let i = 1; i <= days; i++) {
        const dateStr = addDays(actualTodayStr, -i);
        const already = db
          .prepare("SELECT 1 FROM daily_shop_snapshots WHERE shop_slug = ? AND report_date = ?")
          .get(shopSlug, dateStr);
        if (already) {
          skipped++;
          continue;
        }
        try {
          const report = await buildDailyShopReport(db, shopSlug, config.displayName, addDays, dateStr);
          if (!report) continue; // missing Square/Tanda credentials
          saveShopSnapshot(shopSlug, report);
          saved++;
        } catch (err) {
          failed++;
          console.error(`Backfill failed for ${shopSlug} ${dateStr}:`, err.message);
        }
      }
    }
  } finally {
    backfillInProgress = false;
  }

  return { days, saved, skipped, failed };
}

async function sendDailyShopReportsIfDue() {
  if (!process.env.GMAIL_APP_PASSWORD) return;
  if (melbourneHour() < DAILY_SHOP_REPORT_HOUR) return;
  const today = melbourneDateString();

  for (const [shopSlug, config] of Object.entries(SHOP_INTEGRATIONS)) {
    const already = db
      .prepare("SELECT 1 FROM daily_report_log WHERE report_date = ? AND shop_slug = ?")
      .get(today, shopSlug);
    if (already) continue;

    try {
      const report = await buildDailyShopReport(db, shopSlug, config.displayName, addDays);
      if (!report) continue; // missing Square/Tanda credentials

      await sendEmail({
        to: DAILY_REPORT_EMAIL_TO,
        subject: `Daily Report — ${config.displayName} — ${today}`,
        text: formatDailyReportEmail(report),
      });

      db.prepare("INSERT INTO daily_report_log (report_date, shop_slug) VALUES (?, ?)").run(
        today,
        shopSlug
      );
      saveShopSnapshot(shopSlug, report);
      console.log(`Daily shop report emailed for ${config.displayName}, ${today}`);
    } catch (err) {
      console.error(`Daily shop report failed for ${shopSlug}:`, err.message);
    }
  }
}

const COOKIE_BAKE_HOUR = 16; // 4:00 PM Melbourne time — baking for tomorrow morning

// One combined cookie-baking total (not split by shop) for the central
// kitchen, sent once daily. Quarter Two isn't included — it bakes its own;
// this covers the 3 shops that get next-day-delivered baked goods
// (Essendon, Highpoint, and QTR Moonee Ponds, which isn't its own connected
// shop yet so it borrows Highpoint's figures — see cookie_bake_targets).
// bakeDate: the morning being baked for (tomorrow, for the real scheduled
// send; any date for a manual test send).
function buildCookieBakeEmail(bakeDate) {
  const weekday = new Date(bakeDate + "T00:00:00").getDay();
  const target = db
    .prepare("SELECT chocchip_qty, mnm_qty FROM cookie_bake_targets WHERE weekday = ?")
    .get(weekday);
  if (!target) return null;

  const weekdayName = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    weekday: "long",
  }).format(new Date(bakeDate + "T12:00:00Z"));

  const text = [
    `Cookie baking list — for ${weekdayName} ${bakeDate} morning`,
    ``,
    `  ${target.chocchip_qty} x Choc Chip`,
    `  ${target.mnm_qty} x M&M`,
    ``,
    `Combined total for Essendon, Highpoint and QTR Moonee Ponds — no store breakdown needed.`,
  ].join("\n");

  return { subject: `Cookie baking list — ${weekdayName} ${bakeDate}`, text };
}

async function sendCookieBakeListIfDue() {
  if (!process.env.GMAIL_APP_PASSWORD) return;
  if (melbourneHour() < COOKIE_BAKE_HOUR) return;
  const today = melbourneDateString();

  const already = db.prepare("SELECT 1 FROM cookie_bake_log WHERE report_date = ?").get(today);
  if (already) return;

  try {
    const bakeDate = tomorrow();
    const email = buildCookieBakeEmail(bakeDate);
    if (!email) return;

    await sendEmail({ to: EMAIL_TO, subject: email.subject, text: email.text });

    db.prepare("INSERT INTO cookie_bake_log (report_date) VALUES (?)").run(today);
    console.log(`Cookie baking list emailed for ${bakeDate}`);
  } catch (err) {
    console.error("Cookie baking list failed:", err.message);
  }
}

// One shop's EOD cash report — sent the moment that shop submits (or
// resubmits) its cash sheet for a date, not on a delayed daily schedule.
function buildEodCashReportEmail(shopName, reportDate, sheet, isUpdate) {
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const lines = [
    `EOD Cash Report — ${shopName} — ${reportDate}`,
    ``,
    `  Till Amount:  ${money(sheet.till_amount_cents)}`,
    `  EFTPOS:       ${money(sheet.eftpos_sales_cents)}`,
    `  Uber:         ${money(sheet.uber_sales_cents)}`,
    `  Cash Sales:   ${money(sheet.cash_sales_cents)}`,
    `  Cash Amount:  ${money(sheet.cash_amount_cents)}`,
    `  Discrepancy:  ${money(sheet.discrepancy_cents)}`,
  ];

  return {
    subject: `${isUpdate ? "UPDATED " : ""}EOD Cash Report — ${shopName} — ${reportDate}`,
    text: lines.join("\n"),
  };
}

setInterval(sendDailyBackupIfDue, 1000 * 60 * 60); // check hourly
setInterval(sendWeeklySummaryIfDue, 1000 * 60 * 60);
setInterval(sendDailyShopReportsIfDue, 1000 * 60 * 60);
setInterval(sendCookieBakeListIfDue, 1000 * 60 * 60);
sendDailyBackupIfDue();
sendWeeklySummaryIfDue();
sendDailyShopReportsIfDue();
sendCookieBakeListIfDue();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1); // one hop to Railway's edge — only used for secure-cookie detection, not for rate limiting (see below)
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    store: new SqliteStore({
      client: db,
      expired: { clear: true, intervalMs: 1000 * 60 * 60 }, // prune expired sessions hourly
    }),
    secret: process.env.SESSION_SECRET || "qtr-kitchen-ordering-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12, secure: "auto" },
  })
);

// Keyed by the submitted username rather than IP: Railway's edge has a
// variable number of proxy hops, which makes IP-based keys unreliable (and
// trusting the full X-Forwarded-For chain is trivially spoofable). There are
// only 5 known accounts here, so limiting guesses per-account is both safer
// and more directly relevant than per-IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Please wait 15 minutes and try again.",
  keyGenerator: (req) => (req.body.username || "unknown").trim().toLowerCase(),
});

// Pure calendar-date arithmetic, anchored in UTC on both ends so the result
// never shifts by a day depending on what timezone the server's system
// clock happens to be set to (this bit us: .toISOString() after local-time
// Date construction silently loses a day whenever local time != UTC).
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function tomorrow() {
  return addDays(melbourneDateString(), 1);
}

function isWeekendDate(isoDate) {
  const day = new Date(isoDate + "T00:00:00").getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

function effectivePar(parRow, isoDate) {
  if (isWeekendDate(isoDate) && parRow.par_level_weekend !== null) {
    return parRow.par_level_weekend;
  }
  return parRow.par_level;
}

function isValidFutureDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || "")) return false;
  return isoDate >= tomorrow();
}

function formatDate(isoDate) {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/");
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).send("Forbidden");
    }
    next();
  };
}


app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.formatDate = formatDate;
  next();
});

// ---------- Home / Auth ----------

app.get("/", (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === "kitchen") return res.redirect("/kitchen");
    return res.redirect("/choose-ordering");
  }
  const shops = db
    .prepare("SELECT * FROM users WHERE role = 'shop' ORDER BY name")
    .all();
  const kitchen = db.prepare("SELECT * FROM users WHERE role = 'kitchen'").get();
  res.render("home", { shops, kitchen });
});

app.get("/choose-ordering", requireAuth, requireRole("shop"), (req, res) => {
  res.render("choose-ordering");
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.redirect("/");
});

app.get("/login/:slug", (req, res) => {
  if (req.session.user) return res.redirect("/");
  const storeUser = db.prepare("SELECT * FROM users WHERE slug = ?").get(req.params.slug);
  if (!storeUser) return res.redirect("/");
  res.render("login", { error: null, storeUser });
});

app.post("/login", loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const lookupUsername = (username || "").trim().toLowerCase();
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(lookupUsername);

  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    const storeUser = db.prepare("SELECT * FROM users WHERE username = ?").get(lookupUsername);
    return res.render("login", {
      error: "Incorrect password. Please try again.",
      storeUser: storeUser || null,
    });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    slug: user.slug,
    role: user.role,
  };
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ---------- Shop: pick a delivery date, then place order ----------

app.get("/order/select-date", requireAuth, requireRole("shop"), (req, res) => {
  const upcoming = db
    .prepare(
      `SELECT delivery_date, is_late, status FROM orders
       WHERE shop_id = ? AND delivery_date >= ?
       ORDER BY delivery_date ASC`
    )
    .all(req.session.user.id, tomorrow());

  res.render("order-select-date", {
    minDate: tomorrow(),
    upcoming,
    area: "food",
  });
});

// ---------- Shop: EOD cash sheet ----------

app.get("/eod-cash", requireAuth, requireRole("shop"), (req, res) => {
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : melbourneDateString();
  const shopSlug = req.session.user.slug;

  const existing = db
    .prepare("SELECT * FROM eod_cash_sheets WHERE shop_slug = ? AND report_date = ?")
    .get(shopSlug, reportDate);
  const floatSetting = db.prepare("SELECT float_cents FROM shop_float_settings WHERE shop_slug = ?").get(shopSlug);
  const floatCents = floatSetting ? floatSetting.float_cents : 50000;

  const recent = db
    .prepare(
      "SELECT * FROM eod_cash_sheets WHERE shop_slug = ? ORDER BY report_date DESC LIMIT 14"
    )
    .all(shopSlug);

  res.render("eod-cash", {
    reportDate,
    today: melbourneDateString(),
    floatCents,
    existing,
    recent,
    saved: req.query.saved === "1",
  });
});

app.post("/eod-cash", requireAuth, requireRole("shop"), (req, res) => {
  const shopSlug = req.session.user.slug;
  const reportDate = req.body.report_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate || "")) return res.redirect("/eod-cash");

  const toCents = (v) => Math.round((Number(v) || 0) * 100);
  const tillAmountCents = toCents(req.body.till_amount);
  const eftposSalesCents = toCents(req.body.eftpos_sales);
  const uberSalesCents = toCents(req.body.uber_sales);
  const cashSalesCents = toCents(req.body.cash_sales);
  // Cash Amount is entered directly by the team for now rather than
  // auto-calculated from till amount minus float — that is planned for
  // later, not yet turned on.
  const cashAmountCents = toCents(req.body.cash_amount);

  const floatSetting = db.prepare("SELECT float_cents FROM shop_float_settings WHERE shop_slug = ?").get(shopSlug);
  const floatCents = floatSetting ? floatSetting.float_cents : 50000;

  const discrepancyCents = cashAmountCents - cashSalesCents;

  const isUpdate = Boolean(
    db.prepare("SELECT 1 FROM eod_cash_sheets WHERE shop_slug = ? AND report_date = ?").get(shopSlug, reportDate)
  );

  db.prepare(
    `INSERT INTO eod_cash_sheets
       (shop_slug, report_date, till_amount_cents, eftpos_sales_cents, uber_sales_cents, cash_sales_cents, float_cents, cash_amount_cents, discrepancy_cents, submitted_by, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(shop_slug, report_date) DO UPDATE SET
       till_amount_cents = excluded.till_amount_cents,
       eftpos_sales_cents = excluded.eftpos_sales_cents,
       uber_sales_cents = excluded.uber_sales_cents,
       cash_sales_cents = excluded.cash_sales_cents,
       float_cents = excluded.float_cents,
       cash_amount_cents = excluded.cash_amount_cents,
       discrepancy_cents = excluded.discrepancy_cents,
       submitted_by = excluded.submitted_by,
       submitted_at = CURRENT_TIMESTAMP`
  ).run(
    shopSlug,
    reportDate,
    tillAmountCents,
    eftposSalesCents,
    uberSalesCents,
    cashSalesCents,
    floatCents,
    cashAmountCents,
    discrepancyCents,
    req.session.user.name
  );

  // Fire-and-forget: the submitting shop should not wait on email delivery.
  if (process.env.GMAIL_APP_PASSWORD) {
    const email = buildEodCashReportEmail(
      req.session.user.name,
      reportDate,
      {
        till_amount_cents: tillAmountCents,
        eftpos_sales_cents: eftposSalesCents,
        uber_sales_cents: uberSalesCents,
        cash_sales_cents: cashSalesCents,
        cash_amount_cents: cashAmountCents,
        discrepancy_cents: discrepancyCents,
      },
      isUpdate
    );
    sendEmail({ to: DAILY_REPORT_EMAIL_TO, subject: email.subject, text: email.text }).catch((err) =>
      console.error("EOD cash report email failed:", err.message)
    );
  }

  res.redirect(`/eod-cash?date=${reportDate}&saved=1`);
});

app.get("/order", requireAuth, requireRole("shop"), (req, res) => {
  const deliveryDate = req.query.date;
  if (!isValidFutureDate(deliveryDate)) return res.redirect("/order/select-date");

  const categories = db
    .prepare("SELECT * FROM categories WHERE is_custom = 0 AND slug != 'paper' ORDER BY sort_order")
    .all();
  const items = db
    .prepare(
      "SELECT * FROM items WHERE active = 1 AND (shop_id IS NULL OR shop_id = ?) ORDER BY sort_order"
    )
    .all(req.session.user.id);

  const existingOrder = db
    .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
    .get(req.session.user.id, deliveryDate);

  const parRows = db
    .prepare("SELECT item_id, par_level, par_level_weekend FROM shop_item_pars WHERE shop_id = ?")
    .all(req.session.user.id);
  const parByItemId = {};
  parRows.forEach((p) => (parByItemId[p.item_id] = effectivePar(p, deliveryDate)));

  const existingQuantities = {};
  const existingStock = {};
  let existingCustomNotes = [];
  if (existingOrder) {
    const orderItems = db
      .prepare("SELECT * FROM order_items WHERE order_id = ?")
      .all(existingOrder.id);
    for (const oi of orderItems) {
      if (oi.item_id) {
        existingQuantities[oi.item_id] = oi.quantity;
        if (oi.current_stock !== null) existingStock[oi.item_id] = oi.current_stock;
      } else {
        existingCustomNotes.push(oi.note);
      }
    }
  }

  categories.forEach((cat) => {
    cat.items = items.filter((i) => i.category_id === cat.id);
  });

  const isLateNow = deliveryDate === tomorrow() && isLateSubmission();

  res.render("order", {
    deliveryDate,
    categories,
    parByItemId,
    existingQuantities,
    existingStock,
    existingCustomNotes: existingCustomNotes.join("\n"),
    submitted: !!existingOrder,
    isLateNow,
    cutoffHour: ORDER_CUTOFF_HOUR,
    area: "food",
  });
});

app.post("/order", requireAuth, requireRole("shop"), (req, res) => {
  const deliveryDate = req.body.delivery_date;
  if (!isValidFutureDate(deliveryDate)) return res.redirect("/order/select-date");

  const shopId = req.session.user.id;
  const isLate = deliveryDate === tomorrow() && isLateSubmission();

  // Paper Goods is its own separate ordering area (see /order/paper-goods)
  // sharing the same orders/order_items tables keyed by delivery date — so
  // this must only ever touch food-category items, never delete a paper
  // goods line that was already submitted for the same date.
  const items = db
    .prepare(
      `SELECT i.* FROM items i JOIN categories c ON c.id = i.category_id
       WHERE i.active = 1 AND (i.shop_id IS NULL OR i.shop_id = ?) AND c.slug != 'paper'`
    )
    .all(shopId);
  const parRows = db
    .prepare("SELECT item_id FROM shop_item_pars WHERE shop_id = ?")
    .all(shopId);
  const parItemIds = new Set(parRows.map((p) => p.item_id));

  let order = db
    .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
    .get(shopId, deliveryDate);
  const isEdit = !!order;

  if (order) {
    db.prepare(
      `DELETE FROM order_items WHERE order_id = ? AND (item_id IS NULL OR item_id IN (
         SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.slug != 'paper'
       ))`
    ).run(order.id);
    db.prepare(
      "UPDATE orders SET updated_at = CURRENT_TIMESTAMP, is_late = ? WHERE id = ?"
    ).run(isLate ? 1 : 0, order.id);
  } else {
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO orders (shop_id, delivery_date, is_late) VALUES (?, ?, ?)"
      )
      .run(shopId, deliveryDate, isLate ? 1 : 0);
    order = { id: lastInsertRowid };
  }

  const insertOrderItem = db.prepare(
    "INSERT INTO order_items (order_id, item_id, name, unit, quantity, current_stock, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  const orderedItems = [];
  for (const item of items) {
    const raw = req.body[`item_${item.id}`];
    const qty = parseFloat(raw);
    let stock = null;
    if (parItemIds.has(item.id)) {
      const rawStock = req.body[`stock_${item.id}`];
      if (rawStock !== undefined && rawStock !== "") stock = parseInt(rawStock, 10);
    }
    if (qty && qty > 0) {
      insertOrderItem.run(order.id, item.id, item.name, item.unit, qty, stock, null);
      orderedItems.push({ name: item.name, unit: item.unit, quantity: qty, kitchenSection: item.kitchen_section });
    }
  }

  const customNotes = (req.body.custom_notes || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const note of customNotes) {
    insertOrderItem.run(order.id, null, "Custom request", "", 1, null, note);
  }

  sendOrderEmail(req.session.user, formatDate(deliveryDate), orderedItems, customNotes, isLate, isEdit);

  res.redirect(`/order/complete?date=${deliveryDate}`);
});

// Sends a sample order email with one item per kitchen section, so the
// grouped layout can be checked without touching real order data (nothing
// here is written to orders/order_items).
app.post("/kitchen/admin/test-order-email", requireAuth, requireRole("kitchen"), (req, res) => {
  if (!process.env.GMAIL_APP_PASSWORD) return res.status(400).json({ error: "GMAIL_APP_PASSWORD is missing" });

  const sampleItems = [
    { name: "Ham Cheese Toastie", unit: "ea", quantity: 9, kitchenSection: "toasties" },
    { name: "Egg & Bacon Muffin", unit: "ea", quantity: 11, kitchenSection: "muffins_burgers" },
    { name: "Egg & Bacon Wrap", unit: "ea", quantity: 12, kitchenSection: "wraps" },
    { name: "Carrot Cake", unit: "cake", quantity: 2, kitchenSection: "baked_goods" },
    { name: "Oats - Nutella", unit: "ea", quantity: 15, kitchenSection: "grab_n_go" },
    { name: "Watermelon Juice", unit: "2L", quantity: 1, kitchenSection: "juices" },
    { name: "Ham", unit: "ea", quantity: 1, kitchenSection: "extras" },
  ];
  sendOrderEmail({ name: "TEST Shop" }, "Friday 6 November 2026 (TEST — sample order, ignore)", sampleItems, [
    "Sample custom request — ignore",
  ], false, false);

  res.json({ ok: true, to: EMAIL_TO });
});

app.get("/order/complete", requireAuth, requireRole("shop"), (req, res) => {
  const deliveryDate = req.query.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate || "")) return res.redirect("/order/select-date");

  const order = db
    .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
    .get(req.session.user.id, deliveryDate);

  if (!order) return res.redirect("/order/select-date");

  const orderItems = db
    .prepare(
      `SELECT oi.* FROM order_items oi WHERE oi.order_id = ? AND (oi.item_id IS NULL OR oi.item_id IN (
         SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.slug != 'paper'
       )) ORDER BY oi.id`
    )
    .all(order.id);

  res.render("order-complete", { deliveryDate, orderItems, isLate: !!order.is_late, area: "food" });
});

// ---------- Shop: Paper Goods — its own ordering area, not part of Food Order ----------
// Shares the same orders/order_items tables as food (keyed by shop_id +
// delivery_date), scoped strictly to the 'paper' category on every read,
// write and delete so the two areas never touch each other's lines.

app.get("/order/paper-goods/select-date", requireAuth, requireRole("shop"), (req, res) => {
  const upcoming = db
    .prepare(
      `SELECT delivery_date, is_late, status FROM orders
       WHERE shop_id = ? AND delivery_date >= ?
       ORDER BY delivery_date ASC`
    )
    .all(req.session.user.id, tomorrow());

  res.render("order-select-date", { minDate: tomorrow(), upcoming, area: "paper" });
});

app.get("/order/paper-goods", requireAuth, requireRole("shop"), (req, res) => {
  const deliveryDate = req.query.date;
  if (!isValidFutureDate(deliveryDate)) return res.redirect("/order/paper-goods/select-date");

  const categories = db.prepare("SELECT * FROM categories WHERE slug = 'paper' ORDER BY sort_order").all();
  const items = db
    .prepare("SELECT * FROM items WHERE active = 1 AND (shop_id IS NULL OR shop_id = ?) ORDER BY sort_order")
    .all(req.session.user.id);

  const existingOrder = db
    .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
    .get(req.session.user.id, deliveryDate);

  const parRows = db
    .prepare("SELECT item_id, par_level, par_level_weekend FROM shop_item_pars WHERE shop_id = ?")
    .all(req.session.user.id);
  const parByItemId = {};
  parRows.forEach((p) => (parByItemId[p.item_id] = effectivePar(p, deliveryDate)));

  const existingQuantities = {};
  const existingStock = {};
  if (existingOrder) {
    const orderItems = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(existingOrder.id);
    for (const oi of orderItems) {
      if (oi.item_id) {
        existingQuantities[oi.item_id] = oi.quantity;
        if (oi.current_stock !== null) existingStock[oi.item_id] = oi.current_stock;
      }
    }
  }

  categories.forEach((cat) => {
    cat.items = items.filter((i) => i.category_id === cat.id);
  });

  const submitted = categories.some((cat) => cat.items.some((i) => existingQuantities[i.id] !== undefined));
  const isLateNow = deliveryDate === tomorrow() && isLateSubmission();

  res.render("order", {
    deliveryDate,
    categories,
    parByItemId,
    existingQuantities,
    existingStock,
    existingCustomNotes: "",
    submitted,
    isLateNow,
    cutoffHour: ORDER_CUTOFF_HOUR,
    area: "paper",
  });
});

app.post("/order/paper-goods", requireAuth, requireRole("shop"), (req, res) => {
  const deliveryDate = req.body.delivery_date;
  if (!isValidFutureDate(deliveryDate)) return res.redirect("/order/paper-goods/select-date");

  const shopId = req.session.user.id;
  const isLate = deliveryDate === tomorrow() && isLateSubmission();

  const items = db
    .prepare(
      `SELECT i.* FROM items i JOIN categories c ON c.id = i.category_id
       WHERE i.active = 1 AND (i.shop_id IS NULL OR i.shop_id = ?) AND c.slug = 'paper'`
    )
    .all(shopId);
  const parRows = db.prepare("SELECT item_id FROM shop_item_pars WHERE shop_id = ?").all(shopId);
  const parItemIds = new Set(parRows.map((p) => p.item_id));

  let order = db.prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?").get(shopId, deliveryDate);
  const isEdit = !!order;

  if (order) {
    db.prepare(
      `DELETE FROM order_items WHERE order_id = ? AND item_id IN (
         SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.slug = 'paper'
       )`
    ).run(order.id);
    db.prepare("UPDATE orders SET updated_at = CURRENT_TIMESTAMP, is_late = ? WHERE id = ?").run(
      isLate ? 1 : 0,
      order.id
    );
  } else {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO orders (shop_id, delivery_date, is_late) VALUES (?, ?, ?)")
      .run(shopId, deliveryDate, isLate ? 1 : 0);
    order = { id: lastInsertRowid };
  }

  const insertOrderItem = db.prepare(
    "INSERT INTO order_items (order_id, item_id, name, unit, quantity, current_stock, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  const orderedItems = [];
  for (const item of items) {
    const raw = req.body[`item_${item.id}`];
    const qty = parseFloat(raw);
    let stock = null;
    if (parItemIds.has(item.id)) {
      const rawStock = req.body[`stock_${item.id}`];
      if (rawStock !== undefined && rawStock !== "") stock = parseInt(rawStock, 10);
    }
    if (qty && qty > 0) {
      insertOrderItem.run(order.id, item.id, item.name, item.unit, qty, stock, null);
      orderedItems.push({ name: item.name, unit: item.unit, quantity: qty, kitchenSection: item.kitchen_section });
    }
  }

  sendOrderEmail(req.session.user, formatDate(deliveryDate), orderedItems, [], isLate, isEdit, "Paper Goods");

  res.redirect(`/order/paper-goods/complete?date=${deliveryDate}`);
});

app.get("/order/paper-goods/complete", requireAuth, requireRole("shop"), (req, res) => {
  const deliveryDate = req.query.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate || "")) return res.redirect("/order/paper-goods/select-date");

  const order = db
    .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
    .get(req.session.user.id, deliveryDate);

  if (!order) return res.redirect("/order/paper-goods/select-date");

  const orderItems = db
    .prepare(
      `SELECT oi.* FROM order_items oi WHERE oi.order_id = ? AND oi.item_id IN (
         SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.slug = 'paper'
       ) ORDER BY oi.id`
    )
    .all(order.id);

  res.render("order-complete", { deliveryDate, orderItems, isLate: !!order.is_late, area: "paper" });
});

// ---------- Kitchen: dashboard ----------

// Admin hub: pick a shop to drill into, or jump to today's combined prep list.
app.get("/kitchen", requireAuth, requireRole("kitchen"), (req, res) => {
  const shops = db
    .prepare("SELECT * FROM users WHERE role = 'shop' ORDER BY name")
    .all();
  const reportingShops = Object.entries(SHOP_INTEGRATIONS).map(([slug, config]) => ({
    slug,
    name: config.displayName,
  }));
  res.render("kitchen-hub", { shops, reportingShops, msg: req.query.msg || null, error: req.query.error || null });
});

app.get("/kitchen/shop/:slug", requireAuth, requireRole("kitchen"), (req, res) => {
  const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(req.params.slug);
  if (!shop) return res.status(404).send("Shop not found");
  res.render("kitchen-shop-hub", { shop, hasReports: Boolean(SHOP_INTEGRATIONS[shop.slug]) });
});

app.get("/kitchen/shop/:slug/orders", requireAuth, requireRole("kitchen"), (req, res) => {
  const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(req.params.slug);
  if (!shop) return res.status(404).send("Shop not found");

  const dates = db
    .prepare(
      `SELECT o.delivery_date, o.status, o.is_late,
              SUM(CASE WHEN oi.item_id IS NOT NULL THEN oi.quantity ELSE 0 END) AS total_items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.shop_id = ?
       GROUP BY o.id
       ORDER BY o.delivery_date DESC`
    )
    .all(shop.id);

  let selected = null;
  if (req.query.date) {
    const order = db
      .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
      .get(shop.id, req.query.date);
    if (order) {
      const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(order.id);
      selected = { order, items };
    }
  }

  res.render("kitchen-shop-orders", { shop, dates, selected, selectedDate: req.query.date || null });
});

app.get("/kitchen/shop/:slug/eod-cash", requireAuth, requireRole("kitchen"), (req, res) => {
  const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(req.params.slug);
  if (!shop) return res.status(404).send("Shop not found");

  const sheets = db
    .prepare("SELECT * FROM eod_cash_sheets WHERE shop_slug = ? ORDER BY report_date DESC")
    .all(shop.slug);

  res.render("kitchen-shop-eod-cash", { shop, sheets });
});

app.get("/kitchen/shop/:slug/invoices", requireAuth, requireRole("kitchen"), (req, res) => {
  const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(req.params.slug);
  if (!shop) return res.status(404).send("Shop not found");

  const weeks = db
    .prepare("SELECT week_start_date, sent_at FROM invoice_log WHERE shop_id = ? ORDER BY week_start_date DESC")
    .all(shop.id);

  res.render("kitchen-shop-invoices", { shop, weeks });
});

app.get(
  "/kitchen/shop/:slug/invoices/:weekStart.pdf",
  requireAuth,
  requireRole("kitchen"),
  async (req, res) => {
    const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(req.params.slug);
    if (!shop) return res.status(404).send("Shop not found");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.weekStart)) return res.status(400).send("Invalid week");

    try {
      // weekStart here is already an authoritative week-start value as
      // stored in invoice_log — Monday for older invoices, Sunday going
      // forward — never re-snap it to a canonical weekday, just take the
      // 7-day window starting there, exactly as it was actually invoiced.
      const weekStart = req.params.weekStart;
      const weekEnd = addDays(weekStart, 6);
      const { dailyBreakdown, weeklyTotals } = buildWeeklyInvoiceData(shop.id, weekStart, weekEnd);
      const pdfBuffer = await buildWeeklySummaryPdf(
        shop,
        formatDate(weekStart),
        formatDate(weekEnd),
        dailyBreakdown,
        weeklyTotals
      );
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `inline; filename="weekly-invoice-${shop.slug}-${weekStart}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      res.status(500).send(`Failed to build invoice: ${err.message}`);
    }
  }
);

// Rebuilds and re-emails an already-sent weekly invoice — e.g. after
// fixing item prices, so the PDF reflects the correction. Independent of
// invoice_log (which only gates the automatic Sunday send), so this can be
// triggered any time without affecting that schedule.
app.post("/kitchen/shop/:slug/invoices/:weekStart/resend", requireAuth, requireRole("kitchen"), async (req, res) => {
  const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(req.params.slug);
  if (!shop) return res.status(404).json({ error: "Shop not found" });
  if (!process.env.GMAIL_APP_PASSWORD) return res.status(400).json({ error: "GMAIL_APP_PASSWORD is missing" });

  try {
    const weekStart = req.params.weekStart;
    const weekEnd = addDays(weekStart, 6);
    const { dailyBreakdown, weeklyTotals } = buildWeeklyInvoiceData(shop.id, weekStart, weekEnd);
    const pdfBuffer = await buildWeeklySummaryPdf(shop, formatDate(weekStart), formatDate(weekEnd), dailyBreakdown, weeklyTotals);

    const to = (req.body && req.body.to) || DAILY_REPORT_EMAIL_TO;
    await sendEmail({
      to,
      subject: `RESENT Weekly Invoice — ${shop.name} — ${weekStart} to ${weekEnd}`,
      text: `Re-sent: itemised weekly invoice for ${shop.name} covering ${weekStart} to ${weekEnd}.`,
      attachments: [{ filename: `weekly-invoice-${shop.slug}-${weekStart}.pdf`, content: pdfBuffer.toString("base64") }],
    });

    res.json({ ok: true, to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/kitchen/shop/:slug/cogs", requireAuth, requireRole("kitchen"), (req, res) => {
  const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(req.params.slug);
  if (!shop) return res.status(404).send("Shop not found");

  const cogsMap = COGS_BY_SHOP[shop.slug] || {};
  const items = Object.entries(cogsMap)
    .map(([name, cents]) => ({ name, dollars: cents / 100 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.render("kitchen-shop-cogs", { shop, items });
});

// Placeholder — not built yet, needs real quantities/formulas from Joel the
// same way the cookie baking list was set up.
app.get("/kitchen/shop/:slug/chia-oats-prep", requireAuth, requireRole("kitchen"), (req, res) => {
  const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(req.params.slug);
  if (!shop) return res.status(404).send("Shop not found");
  res.render("kitchen-shop-placeholder", {
    shop,
    title: "Chia & Oats Prep",
    message: "Not set up yet — needs real prep quantities before this can show anything useful.",
  });
});

// Combined cookie-baking schedule (choc chip / M&M per weekday) — one total
// across Essendon, Highpoint and QTR Moonee Ponds, not split per shop,
// which is why this lives at its own path rather than under one shop.
app.get("/kitchen/baking-list", requireAuth, requireRole("kitchen"), (req, res) => {
  const targets = db.prepare("SELECT * FROM cookie_bake_targets ORDER BY weekday").all();
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const rows = targets.map((t) => ({
    day: weekdayNames[t.weekday],
    chocchip: t.chocchip_qty,
    mnm: t.mnm_qty,
  }));
  res.render("kitchen-baking-list", { rows });
});

// Today's (or any date's) combined prep list across all shops — the
// kitchen's actual baking/packing list. Formerly lived at bare /kitchen.
app.get("/kitchen/today", requireAuth, requireRole("kitchen"), (req, res) => {
  const deliveryDate = req.query.date || tomorrow();

  const shops = db
    .prepare("SELECT * FROM users WHERE role = 'shop' ORDER BY name")
    .all();

  const orders = db
    .prepare("SELECT * FROM orders WHERE delivery_date = ?")
    .all(deliveryDate);

  // Paper Goods is a separate ordering area, not something the kitchen
  // preps — excluded from this food prep list the same way everywhere else
  // keeps the two areas apart.
  const ordersByShopId = {};
  for (const order of orders) {
    const orderItems = db
      .prepare(
        `SELECT oi.* FROM order_items oi WHERE oi.order_id = ? AND (oi.item_id IS NULL OR oi.item_id IN (
           SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.slug != 'paper'
         )) ORDER BY oi.id`
      )
      .all(order.id);
    ordersByShopId[order.shop_id] = { order, items: orderItems };
  }

  const totals = {};
  for (const order of orders) {
    const orderItems = ordersByShopId[order.shop_id].items;
    for (const oi of orderItems) {
      if (!oi.item_id) continue;
      const key = oi.name;
      if (!totals[key]) totals[key] = { name: oi.name, unit: oi.unit, quantity: 0 };
      totals[key].quantity += oi.quantity;
    }
  }
  const totalsList = Object.values(totals).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  res.render("kitchen", {
    deliveryDate,
    shops,
    ordersByShopId,
    totalsList,
  });
});

app.get("/kitchen/history", requireAuth, requireRole("kitchen"), (req, res) => {
  const dates = db
    .prepare(
      `SELECT o.delivery_date,
              COUNT(DISTINCT o.shop_id) AS shop_count,
              COUNT(DISTINCT CASE WHEN o.status = 'prepared' THEN o.id END) AS prepared_count,
              COUNT(DISTINCT CASE WHEN o.is_late = 1 THEN o.id END) AS late_count,
              SUM(CASE WHEN oi.item_id IS NOT NULL THEN oi.quantity ELSE 0 END) AS total_items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       GROUP BY o.delivery_date
       ORDER BY o.delivery_date DESC`
    )
    .all();

  const totalShops = db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'shop'")
    .get().c;

  res.render("kitchen-history", { dates, totalShops, cleared: req.query.cleared === "1" });
});

app.post("/kitchen/history/clear", requireAuth, requireRole("kitchen"), (req, res) => {
  // No ON DELETE CASCADE enforcement without PRAGMA foreign_keys=ON, so
  // delete order_items explicitly before orders rather than relying on it.
  db.prepare("DELETE FROM order_items").run();
  db.prepare("DELETE FROM orders").run();
  res.redirect("/kitchen/history?cleared=1");
});

app.get(
  "/kitchen/packing-slip/:shopId",
  requireAuth,
  requireRole("kitchen"),
  (req, res) => {
    const deliveryDate = req.query.date || tomorrow();
    const shop = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.shopId);
    const order = db
      .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
      .get(req.params.shopId, deliveryDate);

    const items = order
      ? db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(order.id)
      : [];

    res.render("packing-slip", { shop, deliveryDate, items });
  }
);

app.post(
  "/kitchen/orders/:orderId/status",
  requireAuth,
  requireRole("kitchen"),
  (req, res) => {
    const status = req.body.status === "prepared" ? "prepared" : "submitted";
    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(
      status,
      req.params.orderId
    );
    res.redirect(req.get("Referer") || "/kitchen");
  }
);

// ---------- Kitchen: manage item catalog ----------

app.get("/kitchen/items", requireAuth, requireRole("kitchen"), (req, res) => {
  const categories = db
    .prepare("SELECT * FROM categories WHERE is_custom = 0 ORDER BY sort_order")
    .all();
  const items = db.prepare("SELECT * FROM items ORDER BY category_id, sort_order").all();
  categories.forEach((cat) => {
    cat.items = items.filter((i) => i.category_id === cat.id);
  });
  const shops = db.prepare("SELECT * FROM users WHERE role = 'shop' ORDER BY name").all();
  const kitchenSections = KITCHEN_SECTION_ORDER.map((key) => ({ key, label: KITCHEN_SECTION_LABELS[key] }));
  res.render("admin-items", { categories, shops, kitchenSections, saved: req.query.saved === "1" });
});

app.post("/kitchen/items", requireAuth, requireRole("kitchen"), (req, res) => {
  const { category_id, name, unit, price, shop_id, kitchen_section } = req.body;
  if (name && name.trim() && category_id) {
    const maxOrder = db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE category_id = ?")
      .get(category_id).m;
    const priceVal = price && price.trim() !== "" ? parseFloat(price) : null;
    const shopIdVal = shop_id && shop_id.trim() !== "" ? parseInt(shop_id, 10) : null;
    const sectionVal = KITCHEN_SECTION_ORDER.includes(kitchen_section) ? kitchen_section : "extras";
    db.prepare(
      "INSERT INTO items (category_id, name, unit, sort_order, price, shop_id, kitchen_section) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      category_id,
      name.trim(),
      (unit || "ea").trim(),
      maxOrder + 1,
      isNaN(priceVal) ? null : priceVal,
      isNaN(shopIdVal) ? null : shopIdVal,
      sectionVal
    );
  }
  res.redirect("/kitchen/items?saved=1");
});

app.post("/kitchen/items/:id/update", requireAuth, requireRole("kitchen"), (req, res) => {
  const { name, unit, price, shop_id, kitchen_section } = req.body;
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
  if (item && name && name.trim()) {
    const priceVal = price && price.trim() !== "" ? parseFloat(price) : null;
    const shopIdVal = shop_id && shop_id.trim() !== "" ? parseInt(shop_id, 10) : null;
    const sectionVal = KITCHEN_SECTION_ORDER.includes(kitchen_section) ? kitchen_section : item.kitchen_section;
    db.prepare("UPDATE items SET name = ?, unit = ?, price = ?, shop_id = ?, kitchen_section = ? WHERE id = ?").run(
      name.trim(),
      (unit || "ea").trim(),
      isNaN(priceVal) ? null : priceVal,
      isNaN(shopIdVal) ? null : shopIdVal,
      sectionVal,
      item.id
    );
  }
  res.redirect("/kitchen/items?saved=1");
});

app.post("/kitchen/items/:id/toggle", requireAuth, requireRole("kitchen"), (req, res) => {
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
  if (item) {
    db.prepare("UPDATE items SET active = ? WHERE id = ?").run(item.active ? 0 : 1, item.id);
  }
  res.redirect("/kitchen/items?saved=1");
});

app.post("/kitchen/items/:id/delete", requireAuth, requireRole("kitchen"), (req, res) => {
  db.prepare("DELETE FROM items WHERE id = ?").run(req.params.id);
  res.redirect("/kitchen/items?saved=1");
});

// ---------- Kitchen: daily shop reports (Square + Tanda) ----------

app.get("/kitchen/reports", requireAuth, requireRole("kitchen"), (req, res) => {
  const shops = Object.entries(SHOP_INTEGRATIONS).map(([slug, config]) => ({
    slug,
    name: config.displayName,
  }));
  res.render("kitchen-reports", {
    shops,
    sent: req.query.sent === "1",
    error: req.query.error === "1",
    errorMsg: req.query.msg || "",
  });
});

app.post("/kitchen/reports/send", requireAuth, requireRole("kitchen"), async (req, res) => {
  const { shop_slug, date, to } = req.body;
  const config = SHOP_INTEGRATIONS[shop_slug];

  if (!config || !process.env.GMAIL_APP_PASSWORD) {
    return res.redirect(
      `/kitchen/reports?error=1&msg=${encodeURIComponent("Shop not connected, or GMAIL_APP_PASSWORD is missing")}`
    );
  }

  try {
    const report = await buildDailyShopReport(db, shop_slug, config.displayName, addDays, date || undefined);
    if (!report) {
      return res.redirect(
        `/kitchen/reports?error=1&msg=${encodeURIComponent(
          "SQUARE_ACCESS_TOKEN or TANDA_ACCESS_TOKEN is missing"
        )}`
      );
    }

    await sendEmail({
      to: (to || "").trim() || DAILY_REPORT_EMAIL_TO,
      subject: `TEST Daily Report — ${config.displayName} — ${report.dateStr}`,
      text: formatDailyReportEmail(report),
    });

    res.redirect("/kitchen/reports?sent=1");
  } catch (err) {
    console.error("Test report send failed:", err.message);
    res.redirect(`/kitchen/reports?error=1&msg=${encodeURIComponent(err.message)}`);
  }
});

// Manual correction to a day's labour hours/cost for one shop (e.g. a shift
// logged against the wrong location) — see labour_adjustments in db.js.
app.post("/kitchen/reports/labour-adjustment", requireAuth, requireRole("kitchen"), (req, res) => {
  const { report_date, shop_slug, hours_delta, cost_dollars_delta, note } = req.body;
  if (!report_date || !SHOP_INTEGRATIONS[shop_slug]) {
    return res.status(400).json({ error: "report_date and a valid shop_slug are required" });
  }
  db.prepare(
    "INSERT INTO labour_adjustments (report_date, shop_slug, hours_delta, cost_cents_delta, note) VALUES (?, ?, ?, ?, ?)"
  ).run(
    report_date,
    shop_slug,
    Number(hours_delta) || 0,
    Math.round((Number(cost_dollars_delta) || 0) * 100),
    note || null
  );
  res.json({ ok: true });
});

// Revenue that didn't come through Square (Uber Eats, other off-platform
// income) but should still count toward a day's total sales.
app.post("/kitchen/reports/sales-adjustment", requireAuth, requireRole("kitchen"), (req, res) => {
  const { report_date, shop_slug, amount_dollars_delta, note } = req.body;
  if (!report_date || !SHOP_INTEGRATIONS[shop_slug]) {
    return res.status(400).json({ error: "report_date and a valid shop_slug are required" });
  }
  db.prepare(
    "INSERT INTO sales_adjustments (report_date, shop_slug, amount_cents_delta, note) VALUES (?, ?, ?, ?)"
  ).run(report_date, shop_slug, Math.round((Number(amount_dollars_delta) || 0) * 100), note || null);
  res.json({ ok: true });
});

// Average daily cookie flavour sales (Sun-Sat) across the last N weeks,
// per shop — ad hoc analytics route, JSON only (no view).
app.get("/kitchen/reports/cookie-sales", requireAuth, requireRole("kitchen"), async (req, res) => {
  try {
    const weeks = Number(req.query.weeks) || 8;
    const results = await buildCookieSalesReport(weeks);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Self-service AI search — ask any plain-English sales OR labour question
// ("iced drink sales for the last 30 days, ranked highest to lowest",
// "how many hours did Essendon staff work last week") and Claude resolves
// the intent/shops/date range, looks at the real Square/Tanda data for
// that window, and decides what matches and how to group/rank it. Results
// are emailed (same async pattern as below — a wide search is slow).
app.get("/kitchen/sales-search", requireAuth, requireRole("kitchen"), (req, res) => {
  res.render("kitchen-sales-search", {
    query: "",
    queued: false,
    error: null,
    reportsEmail: DAILY_REPORT_EMAIL_TO,
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

// Pulling every item sold / every shift worked across every shop for a wide
// date range (before Claude narrows it down) is the heaviest thing this app
// does — running two of these at once is what pushed a Render instance over
// its memory limit and crashed the whole app once already. One at a time.
let naturalSearchInProgress = false;

app.post("/kitchen/sales-search", requireAuth, requireRole("kitchen"), (req, res) => {
  const query = (req.body.query || "").trim();

  const renderWith = (error) =>
    res.render("kitchen-sales-search", {
      query,
      queued: false,
      error,
      reportsEmail: DAILY_REPORT_EMAIL_TO,
      aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    });

  if (!query) return renderWith("Type a question to search for.");
  if (!process.env.ANTHROPIC_API_KEY) {
    return renderWith("ANTHROPIC_API_KEY is missing — ask Joel to add it in Render before this can work.");
  }
  if (!process.env.GMAIL_APP_PASSWORD) {
    return renderWith("GMAIL_APP_PASSWORD is missing — cannot email the results.");
  }
  if (naturalSearchInProgress) {
    return renderWith("Another search is already running — wait a minute for it to finish, then try again.");
  }

  naturalSearchInProgress = true;
  buildNaturalSearch(db, query)
    .then((result) => {
      const email = formatNaturalSearchEmail(result);
      return sendEmail({ to: DAILY_REPORT_EMAIL_TO, subject: email.subject, text: email.text });
    })
    .then(() => console.log(`Search emailed for: "${query}"`))
    .catch((err) => {
      console.error("Search failed:", err.message);
      sendEmail({
        to: DAILY_REPORT_EMAIL_TO,
        subject: `Search failed — "${query}"`,
        text: `Your search "${query}" could not be completed.\n\nError: ${err.message}`,
      }).catch((e) => console.error("Search failure email also failed:", e.message));
    })
    .finally(() => {
      naturalSearchInProgress = false;
    });

  res.render("kitchen-sales-search", {
    query,
    queued: true,
    error: null,
    reportsEmail: DAILY_REPORT_EMAIL_TO,
    aiConfigured: true,
  });
});

// Catering orders — its own admin section (not nested under any shop,
// even though the catering checkout happens to post into the Essendon
// Square account under the hood). For checkout orders, the date range
// filters by when the order was PLACED (Square has no event-date filter);
// for manually-entered orders (WhatsApp/phone/email — never create a
// Square order at all) it filters by the EVENT date instead, since that's
// the only date that means anything for those. Everything is sorted by
// event date so upcoming jobs are easy to scan either way.
function getManualCateringOrders(start, end) {
  return db
    .prepare(
      "SELECT * FROM catering_orders_manual WHERE substr(event_date, 1, 10) >= ? AND substr(event_date, 1, 10) <= ? ORDER BY event_date"
    )
    .all(start, end)
    .map((row) => ({
      orderId: `manual-${row.id}`,
      source: "manual",
      state: null,
      createdAt: row.created_at,
      total: row.total_cents !== null ? row.total_cents / 100 : null,
      lineItems: JSON.parse(row.items_json),
      customer: row.customer_name || "",
      phone: row.phone || "",
      email: row.email || "",
      eventDate: row.event_date || "",
      fulfillment: row.fulfillment || "",
      address: row.address || "",
      notes: row.notes || "",
    }));
}

// The Square side of this page pages through EVERY order Essendon takes
// (not just catering ones) before filtering down to the handful that are
// catering — for a shop as busy as Essendon that can take minutes, so the
// page must never block directly on it (that is exactly what froze it).
// Cache the fetched result per date range and refresh it in the
// background; the page always responds instantly, from whatever is
// cached (empty + "fetching" the very first time a range is opened).
const cateringSquareCache = new Map(); // "start|end" -> { orders, error, fetchedAt }
let cateringFetchInProgress = false;
const CATERING_CACHE_TTL_MS = 10 * 60 * 1000;

function startCateringFetch(start, end) {
  if (cateringFetchInProgress) return;
  cateringFetchInProgress = true;
  const key = `${start}|${end}`;
  buildCateringOrders(start, end)
    .then((orders) => {
      cateringSquareCache.set(key, {
        orders: orders.map((o) => ({ ...o, source: "square" })),
        error: null,
        fetchedAt: Date.now(),
      });
    })
    .catch((err) => {
      cateringSquareCache.set(key, { orders: [], error: err.message, fetchedAt: Date.now() });
    })
    .finally(() => {
      cateringFetchInProgress = false;
    });
}

app.get("/kitchen/catering", requireAuth, requireRole("kitchen"), (req, res) => {
  const today = melbourneDateString();
  // Default to recent-past + upcoming — catering browsing is mostly about
  // what's coming up (manual orders filter by event date), not the last
  // month of orders placed, which skews backward-only.
  const start = req.query.start || addDays(today, -14);
  const end = req.query.end || addDays(today, 60);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return res.render("kitchen-catering", {
      start,
      end,
      orders: [],
      error: "Pick a valid start and end date (start must be before end).",
      loading: false,
    });
  }

  const key = `${start}|${end}`;
  const cached = cateringSquareCache.get(key);
  const stale = !cached || Date.now() - cached.fetchedAt > CATERING_CACHE_TTL_MS;
  if (stale) startCateringFetch(start, end);

  const manualOrders = getManualCateringOrders(start, end);
  const squareOrders = cached ? cached.orders : [];
  const orders = [...squareOrders, ...manualOrders].sort((a, b) => (a.eventDate || "").localeCompare(b.eventDate || ""));

  res.render("kitchen-catering", {
    start,
    end,
    orders,
    error: cached && cached.error ? cached.error : null,
    loading: stale,
  });
});

// Manually-taken catering orders never create a Square order (WhatsApp,
// phone, email), so there is nothing to pull live for them — this is
// where one gets entered once, instead of me adding it by hand each time.
app.get("/kitchen/catering/add", requireAuth, requireRole("kitchen"), (req, res) => {
  res.render("kitchen-catering-add", { error: null, values: {} });
});

// Each item line is kept mostly as typed/pasted — a trailing "× N" / "x N"
// is read as the quantity, and the first "$amount" anywhere in the line
// (if any) as that line's price; most lines from a forwarded WhatsApp/email
// order have no per-line price at all, which is fine — the order's own
// Total $ field (optional) is what matters for the dollar figure.
function parseManualCateringItems(text) {
  return (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const qtyMatch = line.match(/[×x]\s*(\d+)\s*$/i);
      const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
      const name = qtyMatch ? line.slice(0, qtyMatch.index).trim() : line;
      const priceMatch = line.match(/\$(\d+(?:\.\d{1,2})?)/);
      const amount = priceMatch ? Number(priceMatch[1]) : 0;
      return { name, qty, amount };
    });
}

app.post("/kitchen/catering/add", requireAuth, requireRole("kitchen"), (req, res) => {
  const { customer_name, phone, email, event_date, fulfillment, address, notes, items_text, total } = req.body;

  if (!event_date || !event_date.trim() || !items_text || !items_text.trim()) {
    return res.render("kitchen-catering-add", {
      error: "Event date and at least one item are required.",
      values: req.body,
    });
  }

  const items = parseManualCateringItems(items_text);
  const totalCents = total && total.trim() !== "" ? Math.round(Number(total) * 100) : null;

  db.prepare(
    `INSERT INTO catering_orders_manual
       (customer_name, phone, email, event_date, fulfillment, address, notes, items_json, total_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    (customer_name || "").trim(),
    (phone || "").trim(),
    (email || "").trim(),
    event_date.trim(),
    (fulfillment || "").trim(),
    (address || "").trim(),
    (notes || "").trim(),
    JSON.stringify(items),
    totalCents
  );

  res.redirect(
    `/kitchen/catering?start=${encodeURIComponent(event_date.trim().slice(0, 10))}&end=${encodeURIComponent(
      event_date.trim().slice(0, 10)
    )}`
  );
});

// The original exact-term search — pick shops, item name(s), and a date
// range yourself. Kept as a fallback for precise term matching.
app.get("/kitchen/sales-search/advanced", requireAuth, requireRole("kitchen"), (req, res) => {
  const allShopSlugs = Object.keys(SHOP_INTEGRATIONS);
  const shopOptions = allShopSlugs.map((slug) => ({ slug, name: SHOP_INTEGRATIONS[slug].displayName }));

  res.render("kitchen-sales-search-advanced", {
    shopOptions,
    selectedShops: allShopSlugs,
    termsRaw: "",
    start: "",
    end: "",
    queued: false,
    error: null,
    reportsEmail: DAILY_REPORT_EMAIL_TO,
  });
});

// A wide date range against a high-volume item can take minutes of Square
// pagination — too slow to hold a browser tab open waiting on it (and
// liable to hit a gateway timeout and just look frozen). So this responds
// immediately with a confirmation and runs the actual search in the
// background, emailing the result when it is done.
app.post("/kitchen/sales-search/advanced", requireAuth, requireRole("kitchen"), (req, res) => {
  const allShopSlugs = Object.keys(SHOP_INTEGRATIONS);
  const selectedShops = [].concat(req.body.shops || []).filter((s) => allShopSlugs.includes(s));
  const termsRaw = (req.body.terms || "").trim();
  const start = req.body.start || "";
  const end = req.body.end || "";
  const shopOptions = allShopSlugs.map((slug) => ({ slug, name: SHOP_INTEGRATIONS[slug].displayName }));

  const renderWith = (error) =>
    res.render("kitchen-sales-search-advanced", {
      shopOptions,
      selectedShops,
      termsRaw,
      start,
      end,
      queued: false,
      error,
      reportsEmail: DAILY_REPORT_EMAIL_TO,
    });

  if (!termsRaw || !start || !end || selectedShops.length === 0) {
    return renderWith("Fill in at least one item name, pick a shop, and a date range.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return renderWith("Pick a valid start and end date (start must be before end).");
  }
  if (!process.env.GMAIL_APP_PASSWORD) {
    return renderWith("GMAIL_APP_PASSWORD is missing — cannot email the results.");
  }

  const terms = termsRaw
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);

  buildItemSalesSearch(selectedShops, terms, start, end)
    .then((result) => {
      const email = formatSalesSearchEmail(result);
      return sendEmail({ to: DAILY_REPORT_EMAIL_TO, subject: email.subject, text: email.text });
    })
    .then(() => console.log(`Sales search emailed for terms: ${terms.join(", ")}`))
    .catch((err) => console.error("Sales search failed:", err.message));

  res.render("kitchen-sales-search-advanced", {
    shopOptions,
    selectedShops,
    termsRaw,
    start,
    end,
    queued: true,
    error: null,
    reportsEmail: DAILY_REPORT_EMAIL_TO,
  });
});

// Manual test send for the 4pm cookie baking list — ignores the hour gate
// and the once-a-day dedup log, so it's safe to trigger any time without
// affecting the real scheduled send.
app.post("/kitchen/reports/cookie-bake/send-test", requireAuth, requireRole("kitchen"), async (req, res) => {
  if (!process.env.GMAIL_APP_PASSWORD) return res.status(400).json({ error: "GMAIL_APP_PASSWORD is missing" });
  try {
    const bakeDate = (req.body && req.body.bake_date) || tomorrow();
    const email = buildCookieBakeEmail(bakeDate);
    if (!email) return res.status(400).json({ error: "No bake target for that date's weekday" });

    const to = (req.body && req.body.to) || EMAIL_TO;
    await sendEmail({ to, subject: email.subject, text: email.text });
    res.json({ ok: true, to, subject: email.subject, text: email.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Kitchen: EOD cash sheets ----------

app.get("/kitchen/eod-cash", requireAuth, requireRole("kitchen"), (req, res) => {
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : melbourneDateString();

  const shops = db.prepare("SELECT * FROM users WHERE role = 'shop' ORDER BY name").all();
  const sheetsByShop = {};
  for (const shop of shops) {
    sheetsByShop[shop.slug] = db
      .prepare("SELECT * FROM eod_cash_sheets WHERE shop_slug = ? AND report_date = ?")
      .get(shop.slug, reportDate);
  }

  const floats = db.prepare("SELECT * FROM shop_float_settings").all();
  const floatByShop = {};
  for (const f of floats) floatByShop[f.shop_slug] = f.float_cents;

  res.render("kitchen-eod-cash", {
    reportDate,
    today: melbourneDateString(),
    shops,
    sheetsByShop,
    floatByShop,
  });
});

app.post("/kitchen/eod-cash/float/:shopSlug", requireAuth, requireRole("kitchen"), (req, res) => {
  const floatCents = Math.round((Number(req.body.float_amount) || 0) * 100);
  db.prepare(
    "INSERT INTO shop_float_settings (shop_slug, float_cents) VALUES (?, ?) ON CONFLICT(shop_slug) DO UPDATE SET float_cents = excluded.float_cents"
  ).run(req.params.shopSlug, floatCents);
  res.redirect(`/kitchen/eod-cash?date=${req.body.report_date || melbourneDateString()}`);
});

app.post("/kitchen/eod-cash/delete/:shopSlug", requireAuth, requireRole("kitchen"), (req, res) => {
  const reportDate = req.body.report_date || melbourneDateString();
  db.prepare("DELETE FROM eod_cash_sheets WHERE shop_slug = ? AND report_date = ?").run(
    req.params.shopSlug,
    reportDate
  );
  res.redirect(`/kitchen/eod-cash?date=${reportDate}`);
});

// Manual re-send of one shop's already-submitted EOD cash report (the real
// one goes out automatically the moment that shop submits — see POST
// /eod-cash — this is just for resending/testing on demand).
app.post("/kitchen/eod-cash/send-test", requireAuth, requireRole("kitchen"), async (req, res) => {
  if (!process.env.GMAIL_APP_PASSWORD) return res.status(400).json({ error: "GMAIL_APP_PASSWORD is missing" });
  try {
    const shopSlug = req.body && req.body.shop_slug;
    const reportDate = (req.body && req.body.report_date) || melbourneDateString();
    const shop = db.prepare("SELECT * FROM users WHERE slug = ? AND role = 'shop'").get(shopSlug);
    if (!shop) return res.status(400).json({ error: "shop_slug is required" });

    const sheet = db
      .prepare("SELECT * FROM eod_cash_sheets WHERE shop_slug = ? AND report_date = ?")
      .get(shopSlug, reportDate);
    if (!sheet) return res.status(400).json({ error: "No cash sheet submitted for that shop/date" });

    const email = buildEodCashReportEmail(shop.name, reportDate, sheet, true);
    const to = (req.body && req.body.to) || DAILY_REPORT_EMAIL_TO;

    await sendEmail({ to, subject: email.subject, text: email.text });
    res.json({ ok: true, to, subject: email.subject, text: email.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Self-service credential update for the currently-logged-in admin/kitchen
// account. No credentials are hardcoded anywhere in source — the new
// values are supplied in the request body only.
app.post("/kitchen/admin/update-credentials", requireAuth, requireRole("kitchen"), (req, res) => {
  const { name, username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password are required" });

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET name = COALESCE(?, name), username = ?, password_hash = ? WHERE id = ?").run(
    name || null,
    username.trim().toLowerCase(),
    hash,
    req.session.user.id
  );
  req.session.destroy(() => {
    res.json({ ok: true, message: "Credentials updated — log in again with the new username and password." });
  });
});

// Backfills daily_shop_snapshots for the last `days` days across every
// shop, so the AI search's "report" domain (COGS %, labour %, prime cost %
// trend) works for the past too, not just going forward. Runs in the
// background and emails a summary when done — for 90 days x 3 shops this
// is ~270 Square/Tanda calls and can take several minutes.
app.post("/kitchen/admin/backfill-snapshots", requireAuth, requireRole("kitchen"), (req, res) => {
  const days = Math.min(Math.max(parseInt(req.body.days, 10) || 90, 1), 365);

  if (backfillInProgress) {
    return res.redirect(`/kitchen?error=1&msg=${encodeURIComponent("A backfill is already running.")}`);
  }

  backfillShopSnapshots(days)
    .then((result) => {
      console.log(`Snapshot backfill done: ${JSON.stringify(result)}`);
      if (process.env.GMAIL_APP_PASSWORD) {
        return sendEmail({
          to: DAILY_REPORT_EMAIL_TO,
          subject: `Report-trend backfill done — ${days} days`,
          text: `Backfilled daily report snapshots for the last ${days} days across every shop.\n\nSaved: ${result.saved}\nAlready had a snapshot (skipped): ${result.skipped}\nFailed: ${result.failed}`,
        });
      }
    })
    .catch((err) => console.error("Snapshot backfill failed:", err.message));

  res.redirect(
    `/kitchen?msg=${encodeURIComponent(
      `Backfilling the last ${days} days in the background — you'll get an email when it's done.`
    )}`
  );
});

// ---------- Kitchen: manage par levels per shop ----------

app.get("/kitchen/pars", requireAuth, requireRole("kitchen"), (req, res) => {
  const shops = db
    .prepare("SELECT * FROM users WHERE role = 'shop' ORDER BY name")
    .all();

  if (!req.query.shop) {
    return res.render("kitchen-pars-select", { shops });
  }

  const shop = db
    .prepare("SELECT * FROM users WHERE role = 'shop' AND slug = ?")
    .get(req.query.shop);
  if (!shop) return res.redirect("/kitchen/pars");

  const categories = db
    .prepare("SELECT * FROM categories WHERE is_custom = 0 ORDER BY sort_order")
    .all();
  const items = db
    .prepare(
      "SELECT * FROM items WHERE active = 1 AND (shop_id IS NULL OR shop_id = ?) ORDER BY sort_order"
    )
    .all(shop.id);
  categories.forEach((cat) => {
    cat.items = items.filter((i) => i.category_id === cat.id);
  });

  const parRows = db
    .prepare("SELECT item_id, par_level, par_level_weekend FROM shop_item_pars WHERE shop_id = ?")
    .all(shop.id);
  const parByItemId = {};
  parRows.forEach((p) => (parByItemId[p.item_id] = p));

  res.render("kitchen-pars", {
    shop,
    categories,
    parByItemId,
    saved: req.query.saved === "1",
  });
});

app.post("/kitchen/pars/:shopSlug", requireAuth, requireRole("kitchen"), (req, res) => {
  const shop = db
    .prepare("SELECT * FROM users WHERE role = 'shop' AND slug = ?")
    .get(req.params.shopSlug);
  if (!shop) return res.redirect("/kitchen/pars");

  const items = db.prepare("SELECT id FROM items").all();
  const upsert = db.prepare(
    `INSERT INTO shop_item_pars (shop_id, item_id, par_level, par_level_weekend) VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_id, item_id) DO UPDATE SET par_level = excluded.par_level, par_level_weekend = excluded.par_level_weekend`
  );
  const clear = db.prepare(
    "DELETE FROM shop_item_pars WHERE shop_id = ? AND item_id = ?"
  );

  for (const item of items) {
    const raw = req.body[`par_${item.id}`];
    const rawWeekend = req.body[`par_weekend_${item.id}`];
    if (raw !== undefined && raw.trim() !== "") {
      const par = parseInt(raw, 10);
      const parWeekend =
        rawWeekend !== undefined && rawWeekend.trim() !== "" ? parseInt(rawWeekend, 10) : null;
      if (!isNaN(par) && par > 0) {
        upsert.run(shop.id, item.id, par, isNaN(parWeekend) ? null : parWeekend);
        continue;
      }
    }
    clear.run(shop.id, item.id);
  }

  res.redirect(`/kitchen/pars?shop=${shop.slug}&saved=1`);
});

app.listen(PORT, () => {
  console.log(`QTR Kitchen Ordering running at http://localhost:${PORT}`);
});
