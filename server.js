const path = require("path");
const fs = require("fs");
const os = require("os");
const PDFDocument = require("pdfkit");
const express = require("express");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const db = require("./db");

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
function sendOrderEmail(shop, deliveryDateLabel, orderedItems, customNotes, isLate) {
  if (!process.env.RESEND_API_KEY) return;

  const lines = orderedItems.map((i) => `  - ${i.quantity} x ${i.name} (${i.unit})`);
  if (customNotes.length) {
    lines.push("", "Custom requests:");
    customNotes.forEach((note) => lines.push(`  - ${note}`));
  }
  if (!orderedItems.length && !customNotes.length) {
    lines.push("  (no items selected)");
  }

  const lateNotice = isLate
    ? `This order was submitted after the ${ORDER_CUTOFF_HOUR}:00 cutoff.\n\n`
    : "";
  const text = `${lateNotice}New order from ${shop.name} for delivery ${deliveryDateLabel}\n\n${lines.join("\n")}\n`;
  const subject = `${isLate ? "LATE ORDER! " : ""}Order from ${shop.name} — delivery ${deliveryDateLabel}`;

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

// Builds a one-page-per-nothing-fancy PDF: shop name, week range, and a
// table of total quantity ordered per item across that week. No pricing —
// there's no price data anywhere in this system — just an order summary.
function money(n) {
  return `$${n.toFixed(2)}`;
}

function buildWeeklySummaryPdf(shop, weekStartLabel, weekEndLabel, totalsList) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("QTR Kitchen Ordering", { align: "left" });
    doc.fontSize(14).text(`Weekly Invoice — ${shop.name}`);
    doc.fontSize(11).fillColor("#555").text(`${weekStartLabel} to ${weekEndLabel}`);
    doc.moveDown(1.5);
    doc.fillColor("#000");

    doc.fontSize(12);
    const colItem = 50;
    const colUnit = 270;
    const colQty = 330;
    const colPrice = 400;
    const colSubtotal = 470;
    const rightEdge = 545;
    doc.font("Helvetica-Bold");
    doc.text("Item", colItem, doc.y, { continued: false });
    doc.text("Unit", colUnit, doc.y - doc.currentLineHeight(), { continued: false });
    doc.text("Qty", colQty, doc.y - doc.currentLineHeight(), { continued: false });
    doc.text("Price", colPrice, doc.y - doc.currentLineHeight(), { continued: false });
    doc.text("Subtotal", colSubtotal, doc.y - doc.currentLineHeight());
    doc.moveDown(0.3);
    doc.moveTo(colItem, doc.y).lineTo(rightEdge, doc.y).strokeColor("#ccc").stroke();
    doc.moveDown(0.5);
    doc.font("Helvetica");

    let grandTotal = 0;
    let hasUnpriced = false;

    if (totalsList.length === 0) {
      doc.fillColor("#777").text("No orders were placed this week.");
    } else {
      totalsList.forEach((t) => {
        const y = doc.y;
        const subtotal = t.price !== null ? t.price * t.quantity : null;
        if (subtotal !== null) grandTotal += subtotal;
        else hasUnpriced = true;

        doc.text(t.name, colItem, y, { width: 210 });
        doc.text(t.unit, colUnit, y);
        doc.text(String(t.quantity), colQty, y);
        doc.text(t.price !== null ? money(t.price) : "—", colPrice, y);
        doc.text(subtotal !== null ? money(subtotal) : "—", colSubtotal, y);
        doc.moveDown(0.4);
      });

      doc.moveDown(0.3);
      doc.moveTo(colItem, doc.y).lineTo(rightEdge, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold");
      doc.text("Total", colPrice, doc.y);
      doc.text(money(grandTotal), colSubtotal, doc.y - doc.currentLineHeight());
      doc.font("Helvetica");

      if (hasUnpriced) {
        doc.moveDown(1);
        doc.fontSize(10).fillColor("#777").text(
          "Note: some items don't have a price set yet and are excluded from the total above (shown as —).",
          colItem,
          doc.y,
          { width: rightEdge - colItem }
        );
      }
    }

    doc.end();
  });
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
      const rows = db
        .prepare(
          `SELECT oi.name, oi.unit, SUM(oi.quantity) AS quantity, MAX(i.price) AS price
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN items i ON i.id = oi.item_id
           WHERE o.shop_id = ? AND o.delivery_date BETWEEN ? AND ? AND oi.item_id IS NOT NULL
           GROUP BY oi.name, oi.unit
           ORDER BY oi.name`
        )
        .all(shop.id, weekStart, weekEnd);

      const pdfBuffer = await buildWeeklySummaryPdf(
        shop,
        formatDate(weekStart),
        formatDate(weekEnd),
        rows
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

setInterval(sendDailyBackupIfDue, 1000 * 60 * 60); // check hourly
setInterval(sendWeeklySummaryIfDue, 1000 * 60 * 60);
sendDailyBackupIfDue();
sendWeeklySummaryIfDue();

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

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.formatDate = formatDate;
  next();
});

// ---------- Home / Auth ----------

app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === "kitchen" ? "/kitchen" : "/order/select-date");
  }
  const shops = db
    .prepare("SELECT * FROM users WHERE role = 'shop' ORDER BY name")
    .all();
  const kitchen = db.prepare("SELECT * FROM users WHERE role = 'kitchen'").get();
  res.render("home", { shops, kitchen });
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
    .prepare("SELECT * FROM items WHERE active = 1 ORDER BY sort_order")
    .all();

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

  const items = db.prepare("SELECT * FROM items WHERE active = 1").all();
  const parRows = db
    .prepare("SELECT item_id FROM shop_item_pars WHERE shop_id = ?")
    .all(shopId);
  const parItemIds = new Set(parRows.map((p) => p.item_id));

  let order = db
    .prepare("SELECT * FROM orders WHERE shop_id = ? AND delivery_date = ?")
    .get(shopId, deliveryDate);

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

  sendOrderEmail(req.session.user, formatDate(deliveryDate), orderedItems, customNotes, isLate);

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

  res.render("kitchen-history", { dates, totalShops });
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
  res.render("admin-items", { categories, saved: req.query.saved === "1" });
});

app.post("/kitchen/items", requireAuth, requireRole("kitchen"), (req, res) => {
  const { category_id, name, unit, price } = req.body;
  if (name && name.trim() && category_id) {
    const maxOrder = db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE category_id = ?")
      .get(category_id).m;
    const priceVal = price && price.trim() !== "" ? parseFloat(price) : null;
    db.prepare(
      "INSERT INTO items (category_id, name, unit, sort_order, price) VALUES (?, ?, ?, ?, ?)"
    ).run(category_id, name.trim(), (unit || "ea").trim(), maxOrder + 1, isNaN(priceVal) ? null : priceVal);
  }
  res.redirect("/kitchen/items?saved=1");
});

app.post("/kitchen/items/:id/update", requireAuth, requireRole("kitchen"), (req, res) => {
  const { name, unit, price } = req.body;
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
  if (item && name && name.trim()) {
    const priceVal = price && price.trim() !== "" ? parseFloat(price) : null;
    db.prepare("UPDATE items SET name = ?, unit = ?, price = ? WHERE id = ?").run(
      name.trim(),
      (unit || "ea").trim(),
      isNaN(priceVal) ? null : priceVal,
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
    .prepare("SELECT * FROM items WHERE active = 1 ORDER BY sort_order")
    .all();
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
