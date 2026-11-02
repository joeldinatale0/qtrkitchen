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
const { SHOP_INTEGRATIONS, buildDailyShopReport, formatDailyReportEmail, buildCookieSalesReport } = require("./shop-reports");

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
function sendOrderEmail(shop, deliveryDateLabel, orderedItems, customNotes, isLate, isEdit) {
  if (!process.env.GMAIL_APP_PASSWORD) return;

  const lines = orderedItems.map((i) => `  - ${i.quantity} x ${i.name} (${i.unit})`);
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
  const text = `${editNotice}${lateNotice}New order from ${shop.name} for delivery ${deliveryDateLabel}\n\n${lines.join("\n")}\n`;
  const subjectPrefix = isEdit
    ? "THIS IS AN EDITED ORDER! Disregard the last order — "
    : isLate
    ? "LATE ORDER! "
    : "";
  const subject = `${subjectPrefix}Order from ${shop.name} — delivery ${deliveryDateLabel}`;

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
  const todayDow = new Date(today + "T00:00:00").getDay(); // 1 = Monday
  if (todayDow !== 1) return;
  if (melbourneHour() < 5) return; // Monday 5:00 AM Melbourne time

  const { weekStart, weekEnd } = weekBounds(addDays(today, -1)); // the week that just ended (yesterday = Sunday)

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

// Mon-Sun week containing isoDate; returns { weekStart, weekEnd } as ISO date strings.
function weekBounds(isoDate) {
  const day = new Date(isoDate + "T00:00:00").getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day; // distance back to Monday
  const weekStart = addDays(isoDate, mondayOffset);
  const weekEnd = addDays(weekStart, 6);
  return { weekStart, weekEnd };
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

function requireShopSlug(slug) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.slug !== slug) {
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
    .prepare("SELECT * FROM categories WHERE is_custom = 0 ORDER BY sort_order")
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
  });
});

app.post("/order", requireAuth, requireRole("shop"), (req, res) => {
  const deliveryDate = req.body.delivery_date;
  if (!isValidFutureDate(deliveryDate)) return res.redirect("/order/select-date");

  const shopId = req.session.user.id;
  const isLate = deliveryDate === tomorrow() && isLateSubmission();

  const items = db
    .prepare("SELECT * FROM items WHERE active = 1 AND (shop_id IS NULL OR shop_id = ?)")
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
    db.prepare("DELETE FROM order_items WHERE order_id = ?").run(order.id);
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
      orderedItems.push({ name: item.name, unit: item.unit, quantity: qty });
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

app.get("/order/complete", requireAuth, requireRole("shop"), (req, res) => {
  const deliveryDate = req.query.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate || "")) return res.redirect("/order/select-date");

  const order = db
    .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
    .get(req.session.user.id, deliveryDate);

  if (!order) return res.redirect("/order/select-date");

  const orderItems = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(order.id);

  res.render("order-complete", { deliveryDate, orderItems, isLate: !!order.is_late });
});

// ---------- Shop: Del Re supplier ordering (separate from the kitchen flow) ----------

app.get("/delre/order", requireAuth, requireRole("shop"), requireShopSlug("essendon"), (req, res) => {
  const categories = db
    .prepare("SELECT * FROM delre_categories ORDER BY sort_order")
    .all();
  const items = db
    .prepare("SELECT * FROM delre_items WHERE active = 1 ORDER BY sort_order")
    .all();
  categories.forEach((cat) => {
    cat.items = items.filter((i) => i.category_id === cat.id);
  });

  res.render("delre-order", { categories });
});

app.post("/delre/order", requireAuth, requireRole("shop"), requireShopSlug("essendon"), (req, res) => {
  const items = db.prepare("SELECT * FROM delre_items WHERE active = 1").all();

  const { lastInsertRowid: orderId } = db
    .prepare("INSERT INTO delre_orders (shop_id) VALUES (?)")
    .run(req.session.user.id);

  const insertOrderItem = db.prepare(
    "INSERT INTO delre_order_items (order_id, item_id, name, unit, current_stock, quantity) VALUES (?, ?, ?, ?, ?, ?)"
  );

  for (const item of items) {
    const rawQty = req.body[`order_${item.id}`];
    const qty = parseInt(rawQty, 10);
    if (!qty || qty <= 0) continue;
    const rawStock = req.body[`stock_${item.id}`];
    const stock = rawStock !== undefined && rawStock !== "" ? parseInt(rawStock, 10) : null;
    insertOrderItem.run(orderId, item.id, item.name, item.unit, stock, qty);
  }

  res.redirect(`/delre/order/complete?id=${orderId}`);
});

app.get("/delre/order/complete", requireAuth, requireRole("shop"), requireShopSlug("essendon"), (req, res) => {
  const order = db
    .prepare("SELECT * FROM delre_orders WHERE id = ? AND shop_id = ?")
    .get(req.query.id, req.session.user.id);
  if (!order) return res.redirect("/delre/order");

  const orderItems = db
    .prepare("SELECT * FROM delre_order_items WHERE order_id = ? ORDER BY id")
    .all(order.id);

  const itemLines = orderItems.map((oi) => `${oi.name} x${oi.quantity} ${oi.unit}`).join("\n");
  const greeting = `Can I please place an order for Coffee ${req.session.user.name}`;
  const textList = `${greeting}\n\n${itemLines}`;

  res.render("delre-order-complete", { order, orderItems, textList });
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
  res.render("kitchen-hub", { shops, reportingShops });
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
      const { weekStart, weekEnd } = weekBounds(req.params.weekStart);
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

  const ordersByShopId = {};
  for (const order of orders) {
    const orderItems = db
      .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
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

app.get("/kitchen/delre", requireAuth, requireRole("kitchen"), (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.id, o.created_at, u.name AS shop_name,
              SUM(oi.quantity) AS total_items
       FROM delre_orders o
       JOIN users u ON u.id = o.shop_id
       LEFT JOIN delre_order_items oi ON oi.order_id = o.id
       GROUP BY o.id
       ORDER BY o.created_at DESC`
    )
    .all();

  res.render("kitchen-delre-history", { orders, cleared: req.query.cleared === "1" });
});

app.post("/kitchen/delre/clear", requireAuth, requireRole("kitchen"), (req, res) => {
  db.prepare("DELETE FROM delre_order_items").run();
  db.prepare("DELETE FROM delre_orders").run();
  res.redirect("/kitchen/delre?cleared=1");
});

app.get("/kitchen/delre/:orderId", requireAuth, requireRole("kitchen"), (req, res) => {
  const order = db
    .prepare(
      `SELECT o.id, o.created_at, u.name AS shop_name
       FROM delre_orders o
       JOIN users u ON u.id = o.shop_id
       WHERE o.id = ?`
    )
    .get(req.params.orderId);
  if (!order) return res.redirect("/kitchen/delre");

  const orderItems = db
    .prepare("SELECT * FROM delre_order_items WHERE order_id = ? ORDER BY id")
    .all(order.id);

  res.render("kitchen-delre-order", { order, orderItems });
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
  res.render("admin-items", { categories, shops, saved: req.query.saved === "1" });
});

app.post("/kitchen/items", requireAuth, requireRole("kitchen"), (req, res) => {
  const { category_id, name, unit, price, shop_id } = req.body;
  if (name && name.trim() && category_id) {
    const maxOrder = db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE category_id = ?")
      .get(category_id).m;
    const priceVal = price && price.trim() !== "" ? parseFloat(price) : null;
    const shopIdVal = shop_id && shop_id.trim() !== "" ? parseInt(shop_id, 10) : null;
    db.prepare(
      "INSERT INTO items (category_id, name, unit, sort_order, price, shop_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      category_id,
      name.trim(),
      (unit || "ea").trim(),
      maxOrder + 1,
      isNaN(priceVal) ? null : priceVal,
      isNaN(shopIdVal) ? null : shopIdVal
    );
  }
  res.redirect("/kitchen/items?saved=1");
});

app.post("/kitchen/items/:id/update", requireAuth, requireRole("kitchen"), (req, res) => {
  const { name, unit, price, shop_id } = req.body;
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
  if (item && name && name.trim()) {
    const priceVal = price && price.trim() !== "" ? parseFloat(price) : null;
    const shopIdVal = shop_id && shop_id.trim() !== "" ? parseInt(shop_id, 10) : null;
    db.prepare("UPDATE items SET name = ?, unit = ?, price = ?, shop_id = ? WHERE id = ?").run(
      name.trim(),
      (unit || "ea").trim(),
      isNaN(priceVal) ? null : priceVal,
      isNaN(shopIdVal) ? null : shopIdVal,
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
