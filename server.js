const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { buildWeeklySummaryPdf } = require("./invoice-pdf");
const { SHOP_INTEGRATIONS, buildDailyShopReport, formatDailyReportEmail } = require("./shop-reports");

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
  if (!process.env.RESEND_API_KEY) return;

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

  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "QTR Kitchen Ordering <onboarding@resend.dev>",
      to: EMAIL_TO,
      subject,
      text,
    }),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      console.log(`Order email sent for ${shop.name}`);
    })
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
  if (!process.env.RESEND_API_KEY) return;
  const today = melbourneDateString();
  const already = db.prepare("SELECT 1 FROM backup_log WHERE backup_date = ?").get(today);
  if (already) return;
  if (melbourneHour() < 3) return; // wait for a quiet early-morning window

  const tempPath = path.join(os.tmpdir(), `qtr-backup-${Date.now()}.sqlite`);
  try {
    await db.backup(tempPath);
    const fileBuffer = fs.readFileSync(tempPath);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "QTR Kitchen Ordering <onboarding@resend.dev>",
        to: EMAIL_TO,
        subject: `Daily backup — ${today}`,
        text: `Automatic daily backup of the QTR Kitchen Ordering database for ${today}. Keep this email in case data ever needs to be restored.`,
        attachments: [
          {
            filename: `qtr-kitchen-backup-${today}.sqlite`,
            content: fileBuffer.toString("base64"),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    db.prepare("INSERT INTO backup_log (backup_date) VALUES (?)").run(today);
    console.log(`Daily backup emailed for ${today}`);
  } catch (err) {
    console.error("Daily backup failed:", err.message);
  } finally {
    fs.rm(tempPath, { force: true }, () => {});
  }
}

async function sendWeeklySummaryIfDue() {
  if (!process.env.RESEND_API_KEY) return;
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
        .all(shop.id, weekStart, weekEnd);

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

      const pdfBuffer = await buildWeeklySummaryPdf(
        shop,
        formatDate(weekStart),
        formatDate(weekEnd),
        dailyBreakdown,
        weeklyTotals
      );

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "QTR Kitchen Ordering <onboarding@resend.dev>",
          to: EMAIL_TO,
          subject: `Weekly Invoice — ${shop.name} — ${weekStart} to ${weekEnd}`,
          text: `Attached: itemised weekly invoice for ${shop.name} covering ${weekStart} to ${weekEnd}.`,
          attachments: [
            {
              filename: `weekly-invoice-${shop.slug}-${weekStart}.pdf`,
              content: pdfBuffer.toString("base64"),
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

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
  if (!process.env.RESEND_API_KEY) return;
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

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "QTR Kitchen Ordering <onboarding@resend.dev>",
          to: DAILY_REPORT_EMAIL_TO,
          subject: `Daily Report — ${config.displayName} — ${today}`,
          text: formatDailyReportEmail(report),
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

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

setInterval(sendDailyBackupIfDue, 1000 * 60 * 60); // check hourly
setInterval(sendWeeklySummaryIfDue, 1000 * 60 * 60);
setInterval(sendDailyShopReportsIfDue, 1000 * 60 * 60);
sendDailyBackupIfDue();
sendWeeklySummaryIfDue();
sendDailyShopReportsIfDue();

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
    const landing = req.session.user.slug === "essendon" ? "/choose-ordering" : "/order/select-date";
    return res.redirect(landing);
  }
  const shops = db
    .prepare("SELECT * FROM users WHERE role = 'shop' ORDER BY name")
    .all();
  const kitchen = db.prepare("SELECT * FROM users WHERE role = 'kitchen'").get();
  res.render("home", { shops, kitchen });
});

app.get("/choose-ordering", requireAuth, requireRole("shop"), (req, res) => {
  if (req.session.user.slug !== "essendon") return res.redirect("/order/select-date");
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

app.get("/kitchen", requireAuth, requireRole("kitchen"), (req, res) => {
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

  if (!config || !process.env.RESEND_API_KEY) {
    return res.redirect(
      `/kitchen/reports?error=1&msg=${encodeURIComponent("Shop not connected, or RESEND_API_KEY is missing")}`
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

    const res2 = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "QTR Kitchen Ordering <onboarding@resend.dev>",
        to: (to || "").trim() || DAILY_REPORT_EMAIL_TO,
        subject: `TEST Daily Report — ${config.displayName} — ${report.dateStr}`,
        text: formatDailyReportEmail(report),
      }),
    });
    if (!res2.ok) throw new Error(`${res2.status} ${await res2.text()}`);

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
