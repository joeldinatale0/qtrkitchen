// Read-only MCP (Model Context Protocol) server for the QTR Kitchen Hub,
// mounted at /mcp on the main Express app so Joel can connect it to Claude
// as a custom connector. Stateless Streamable HTTP transport (no session
// tracking needed — every tool call here is a one-shot read), protected by
// a single long bearer token kept in the MCP_ACCESS_TOKEN env var.
//
// Every tool in this file is READ-ONLY. There is no create/update/delete
// tool anywhere, and the one arbitrary-SQL tool (query_database) runs
// against a SEPARATE better-sqlite3 connection opened in `readonly: true`
// mode — a real read-only database handle, not just an app-level check —
// on top of only allowing SELECT/PRAGMA text.
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const db = require("./db");
const { dbPath } = require("./db");
const {
  SHOP_INTEGRATIONS,
  ALL_SHOP_SLUGS,
  ALL_SHOP_NAMES,
  buildCateringOrders,
  SQUARE_API_BASE,
  squareHeaders,
  fetchSquareOrders,
  melbourneDayRangeUtc,
  melbourneHourOf,
  summarizeSquareOrders,
  topProductEntries,
  fetchTandaLiveLabourCost,
  fetchLabourDataForShops,
  formatLabourPart,
  buildCashSearchPart,
  formatCashPart,
  buildReportSearchPart,
  formatReportPart,
  buildInvoiceSearchPart,
  formatInvoicePart,
  mondayOnOrBefore,
  addDaysISO,
  buildCogsSearchPart,
  formatCogsPart,
  buildCateringSearchPart,
  formatCateringPart,
  todayMelbourneStr,
} = require("./shop-reports");

// ---------- Auth ----------

function requireMcpAuth(req, res, next) {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) {
    return res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "MCP server not configured (missing MCP_ACCESS_TOKEN)" },
      id: null,
    });
  }

  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(req.headers["authorization"] || "");
  const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!valid) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  next();
}

// ---------- Shared helpers ----------

// The 4 "ordering" shops (users table, food/paper/grab-n-go orders, invoices,
// stock checks, Del Re, EOD cash) use slugs essendon/highpoint/mooneeponds/
// melbournecentral. Square/Tanda sales & labour reporting (SHOP_INTEGRATIONS)
// use essendon/highpoint/quartertwo instead — same physical shop as
// mooneeponds, different slug, because reporting predates/is independent of
// the ordering system. Every tool here takes the ORDERING-side slugs (one
// vocabulary for the caller); this maps to the reporting slug internally
// only where needed (Square/Tanda/COGS calls).
const SHOP_ALIASES = { quartertwo: "mooneeponds" };
function toReportingSlug(orderingSlug) {
  return orderingSlug === "mooneeponds" ? "quartertwo" : orderingSlug;
}

function resolveShops(input) {
  if (!input || input === "all" || (Array.isArray(input) && input.length === 0)) {
    return [...ALL_SHOP_SLUGS];
  }
  const arr = Array.isArray(input) ? input : [input];
  const resolved = arr
    .map((s) => String(s).trim().toLowerCase())
    .map((s) => SHOP_ALIASES[s] || s)
    .filter((s) => ALL_SHOP_SLUGS.includes(s));
  return resolved.length > 0 ? [...new Set(resolved)] : [...ALL_SHOP_SLUGS];
}

function formatMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return `$${n.toFixed(2)} AUD`;
}

// The reused shop-reports.js formatters (formatCogsPart, formatCashPart,
// formatReportPart, formatInvoicePart, formatLabourPart, formatCateringPart)
// use that file's own `money()` helper internally, which doesn't append a
// currency code — this app's existing emails/PDFs are AUD-only by context,
// so that's fine for them, but this MCP server is a general-purpose
// interface and the brief calls for money shown with currency everywhere.
// Rather than changing `money()` itself (which would alter output in every
// existing email/PDF this file's functions already feed), patch it onto
// just the text this server returns.
function withCurrency(text) {
  return text.replace(/\$(-?\d[\d,]*\.\d{2})(?! AUD)/g, (m) => `${m} AUD`);
}

function melbourneDateStrOf(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function melbourneDateTimeStrOf(date) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDateRange(start, end) {
  return DATE_RE.test(start) && DATE_RE.test(end) && start <= end;
}

function paginate(items, limit, offset) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const page = items.slice(off, off + lim);
  return { page, total: items.length, limit: lim, offset: off, hasMore: off + lim < items.length };
}

function paginationFooter(p) {
  return `\n\n(showing ${p.page.length} of ${p.total}, offset ${p.offset}${p.hasMore ? " — more available, call again with a higher offset" : ""})`;
}

const shopsField = z
  .array(z.string())
  .optional()
  .describe(
    "Shop slugs to include: essendon, highpoint, mooneeponds (= Quarter Two), melbournecentral. Omit or pass [] for all 4. melbournecentral has no Square/Tanda connection."
  );
const startField = z.string().regex(DATE_RE).describe("Start date, YYYY-MM-DD, Melbourne local time");
const endField = z.string().regex(DATE_RE).describe("End date, YYYY-MM-DD, Melbourne local time, inclusive");
const limitField = z.number().int().min(1).max(200).optional().describe("Max rows to return (default 50, max 200)");
const offsetField = z.number().int().min(0).optional().describe("Rows to skip, for paging through a large result");

// ---------- Square sales ----------

async function fetchSalesOrdersForShops(shops, start, end) {
  const { startUtc } = melbourneDayRangeUtc(start);
  const { endUtc } = melbourneDayRangeUtc(end);
  const perShop = {};
  const errors = {};
  await Promise.all(
    shops.map(async (orderingSlug) => {
      const reportingSlug = toReportingSlug(orderingSlug);
      const config = SHOP_INTEGRATIONS[reportingSlug];
      if (!config) {
        errors[orderingSlug] = "Square not connected for this shop";
        return;
      }
      if (!process.env[config.squareTokenEnvVar]) {
        errors[orderingSlug] = "Square access token missing";
        return;
      }
      try {
        perShop[orderingSlug] = await fetchSquareOrders(config.squareTokenEnvVar, config.squareLocationId, startUtc, endUtc);
      } catch (err) {
        errors[orderingSlug] = err.message;
      }
    })
  );
  return { perShop, errors };
}

// Item names at the POS (Square) are not guaranteed to match the kitchen
// ordering catalog's names (e.g. Square might say "Chia blueberry" where the
// kitchen catalog says "Berry Chia") — so matching "Grab n Go" or any
// product group by name needs a loose, multi-keyword OR match, not an
// exact name. Matching happens per LINE ITEM, not per order, since one
// order can mix matching and non-matching products.
function matchesAnyNeedle(name, needles) {
  if (!needles || needles.length === 0) return true;
  const lower = (name || "").toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

function aggregateMatchingLineItems(orders, needles) {
  const byDay = {};
  const byHour = {};
  const byItem = {};
  let totalQty = 0;
  let totalRevenue = 0;
  for (const order of orders) {
    const created = new Date(order.created_at);
    const day = melbourneDateStrOf(created);
    const hour = melbourneHourOf(created);
    for (const li of order.line_items || []) {
      const name = (li.name || "").trim();
      if (!matchesAnyNeedle(name, needles)) continue;
      const qty = Number(li.quantity) || 0;
      const revenue = (li.total_money?.amount || 0) / 100;
      totalQty += qty;
      totalRevenue += revenue;
      if (!byDay[day]) byDay[day] = { qty: 0, revenue: 0 };
      byDay[day].qty += qty;
      byDay[day].revenue += revenue;
      if (!byHour[hour]) byHour[hour] = { qty: 0, revenue: 0 };
      byHour[hour].qty += qty;
      byHour[hour].revenue += revenue;
      if (!byItem[name]) byItem[name] = { qty: 0, revenue: 0 };
      byItem[name].qty += qty;
      byItem[name].revenue += revenue;
    }
  }
  return { byDay, byHour, byItem, totalQty, totalRevenue };
}

async function searchSquareSales({ shops, start, end, groupBy, itemNameContains, limit, offset }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  const { perShop, errors } = await fetchSalesOrdersForShops(resolvedShops, start, end);

  const needles = Array.isArray(itemNameContains) ? itemNameContains.filter(Boolean) : [];
  const lines = [`SQUARE SALES — ${start} to ${end} (Melbourne time)${needles.length ? ` — items matching: ${needles.join(", ")}` : ""}`, ""];
  for (const [slug, msg] of Object.entries(errors)) lines.push(`(${ALL_SHOP_NAMES[slug] || slug}: ${msg})`);
  if (Object.keys(errors).length) lines.push("");

  const allOrders = Object.values(perShop).flat();
  if (allOrders.length === 0) {
    lines.push("No completed sales found for the connected shop(s) in that range.");
    return lines.join("\n");
  }

  const effectiveGroupBy = groupBy || "total";

  if (needles.length > 0) {
    // Item-name-filtered path: every number below is QUANTITY/REVENUE of
    // just the matching line items, never a whole-order total — a shop's
    // "Per-shop totals" (all sales, unfiltered) is still shown first for
    // context, since "how much did Highpoint sell today" vs "how much
    // Grab n Go did Highpoint sell today" are different questions.
    lines.push("Per-shop totals (ALL sales, unfiltered, for context):");
    for (const slug of resolvedShops) {
      const orders = perShop[slug];
      if (!orders) continue;
      const s = summarizeSquareOrders(orders, {});
      lines.push(`  ${ALL_SHOP_NAMES[slug] || slug}: ${formatMoney(s.netSales)} net sales, ${s.transactionCount} transactions`);
    }
    lines.push("");

    if (effectiveGroupBy === "shop") {
      lines.push(`Matching items, by shop:`);
      for (const slug of resolvedShops) {
        const orders = perShop[slug];
        if (!orders) continue;
        const agg = aggregateMatchingLineItems(orders, needles);
        lines.push(`  ${ALL_SHOP_NAMES[slug] || slug}: ${agg.totalQty} sold, ${formatMoney(agg.totalRevenue)}`);
      }
    } else {
      const agg = aggregateMatchingLineItems(allOrders, needles);
      lines.push(`Matching items — total: ${agg.totalQty} sold, ${formatMoney(agg.totalRevenue)}`);
      lines.push("");
      if (effectiveGroupBy === "day") {
        const dayRows = Object.entries(agg.byDay).sort((a, b) => a[0].localeCompare(b[0]));
        const p = paginate(dayRows, limit, offset);
        lines.push("By day:");
        for (const [day, s] of p.page) lines.push(`  ${day}: ${s.qty} sold, ${formatMoney(s.revenue)}`);
        lines.push(paginationFooter(p));
      } else if (effectiveGroupBy === "hour") {
        const hourRows = Object.entries(agg.byHour).sort((a, b) => Number(a[0]) - Number(b[0]));
        lines.push("By hour of day (aggregated across the whole range):");
        for (const [hour, s] of hourRows) lines.push(`  ${String(hour).padStart(2, "0")}:00 — ${s.qty} sold, ${formatMoney(s.revenue)}`);
      } else if (effectiveGroupBy === "item" || effectiveGroupBy === "top_sellers") {
        const itemRows = Object.entries(agg.byItem).sort((a, b) => b[1].qty - a[1].qty);
        const p = paginate(itemRows, limit, offset);
        lines.push("By matching item:");
        p.page.forEach(([name, s], i) => lines.push(`  ${p.offset + i + 1}. ${name} — ${s.qty} sold, ${formatMoney(s.revenue)}`));
        lines.push(paginationFooter(p));
      }
      // effectiveGroupBy === "total" already shown above.
    }
    return lines.join("\n");
  }

  // Per-shop totals always included, regardless of groupBy, for context.
  lines.push("Per-shop totals:");
  for (const slug of resolvedShops) {
    const orders = perShop[slug];
    if (!orders) continue;
    const s = summarizeSquareOrders(orders, {});
    lines.push(
      `  ${ALL_SHOP_NAMES[slug] || slug}: ${formatMoney(s.netSales)} net sales, ${s.transactionCount} transactions, ${formatMoney(s.totalDiscounts)} discounts`
    );
  }
  lines.push("");

  if (effectiveGroupBy === "total") {
    const combined = summarizeSquareOrders(allOrders, {});
    lines.push(
      `Combined total: ${formatMoney(combined.netSales)} net sales across ${combined.transactionCount} transactions, ${formatMoney(combined.totalDiscounts)} discounts.`
    );
  } else if (effectiveGroupBy === "shop") {
    // already covered by the per-shop totals above
    lines.push("(See per-shop totals above.)");
  } else if (effectiveGroupBy === "day") {
    const byDay = {};
    for (const order of allOrders) {
      const day = melbourneDateStrOf(new Date(order.created_at));
      const total = (order.total_money?.amount || 0) / 100;
      if (!byDay[day]) byDay[day] = { netSales: 0, transactionCount: 0 };
      byDay[day].netSales += total;
      byDay[day].transactionCount += 1;
    }
    const dayRows = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
    const p = paginate(dayRows, limit, offset);
    lines.push("By day:");
    for (const [day, s] of p.page) lines.push(`  ${day}: ${formatMoney(s.netSales)} (${s.transactionCount} transactions)`);
    lines.push(paginationFooter(p));
  } else if (effectiveGroupBy === "hour") {
    const combined = summarizeSquareOrders(allOrders, {});
    const hourRows = Object.entries(combined.hourly).sort((a, b) => Number(a[0]) - Number(b[0]));
    lines.push("By hour of day (aggregated across the whole range):");
    for (const [hour, s] of hourRows) {
      lines.push(`  ${String(hour).padStart(2, "0")}:00 — ${formatMoney(s.sales)} (${s.count} transactions)`);
    }
  } else if (effectiveGroupBy === "item" || effectiveGroupBy === "top_sellers") {
    const combined = summarizeSquareOrders(allOrders, {});
    const entries = topProductEntries(combined.productStats, 100000); // already sorted by revenue desc
    const p = paginate(entries, limit, offset);
    lines.push(effectiveGroupBy === "top_sellers" ? "Top sellers (by revenue):" : "By item (sorted by revenue):");
    p.page.forEach(([name, revenue, qty], i) => {
      lines.push(`  ${p.offset + i + 1}. ${name} — ${formatMoney(revenue)}, ${qty} sold`);
    });
    lines.push(paginationFooter(p));
  }

  return lines.join("\n");
}

async function fetchSquareRefunds(tokenEnvVar, locationId, beginTimeIso, endTimeIso) {
  const refunds = [];
  let cursor;
  do {
    const params = new URLSearchParams({ location_id: locationId, begin_time: beginTimeIso, end_time: endTimeIso, sort_order: "ASC" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${SQUARE_API_BASE}/refunds?${params.toString()}`, { headers: squareHeaders(tokenEnvVar) });
    if (!res.ok) throw new Error(`Square refunds failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    refunds.push(...(data.refunds || []));
    cursor = data.cursor;
  } while (cursor);
  return refunds;
}

async function searchSquareRefunds({ shops, start, end, limit, offset }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  const { startUtc } = melbourneDayRangeUtc(start);
  const { endUtc } = melbourneDayRangeUtc(end);

  const lines = [`SQUARE REFUNDS — ${start} to ${end} (Melbourne time)`, ""];
  const allRefunds = [];
  for (const orderingSlug of resolvedShops) {
    const reportingSlug = toReportingSlug(orderingSlug);
    const config = SHOP_INTEGRATIONS[reportingSlug];
    if (!config) {
      lines.push(`(${ALL_SHOP_NAMES[orderingSlug] || orderingSlug}: Square not connected for this shop)`);
      continue;
    }
    if (!process.env[config.squareTokenEnvVar]) {
      lines.push(`(${ALL_SHOP_NAMES[orderingSlug] || orderingSlug}: Square access token missing)`);
      continue;
    }
    try {
      const refunds = await fetchSquareRefunds(config.squareTokenEnvVar, config.squareLocationId, startUtc.toISOString(), endUtc.toISOString());
      for (const r of refunds) {
        allRefunds.push({
          shop: ALL_SHOP_NAMES[orderingSlug] || orderingSlug,
          date: melbourneDateTimeStrOf(new Date(r.created_at)),
          amount: (r.amount_money?.amount || 0) / 100,
          status: r.status,
          reason: r.reason || "(no reason given)",
          orderId: r.order_id || null,
        });
      }
    } catch (err) {
      lines.push(`(${ALL_SHOP_NAMES[orderingSlug] || orderingSlug}: ${err.message})`);
    }
  }
  lines.push("");

  if (allRefunds.length === 0) {
    lines.push("No refunds found in that range.");
    return lines.join("\n");
  }

  const totalRefunded = allRefunds.reduce((s, r) => s + r.amount, 0);
  lines.push(`Total refunded: ${formatMoney(totalRefunded)} across ${allRefunds.length} refund(s).`, "");

  const p = paginate(allRefunds, limit, offset);
  for (const r of p.page) {
    lines.push(`  ${r.date} — ${r.shop} — ${formatMoney(r.amount)} — ${r.status} — ${r.reason}`);
  }
  lines.push(paginationFooter(p));

  return lines.join("\n");
}

// ---------- Labour / roster ----------

async function searchLabour({ shops, start, end, groupBy, employeeName, limit, offset }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  const reportingShops = resolvedShops.map(toReportingSlug);
  const { rows, roster, costToday, incompleteCount, errors } = await fetchLabourDataForShops(reportingShops, start, end);

  let filteredRows = rows;
  if (employeeName && employeeName.trim()) {
    const needle = employeeName.trim().toLowerCase();
    filteredRows = rows.filter((r) => r.userName.toLowerCase().includes(needle));
  }

  const effectiveGroupBy = ["employee", "day", "shop", "none"].includes(groupBy) ? groupBy : "employee";
  const keyFor = (r) => {
    if (effectiveGroupBy === "employee") return r.userName;
    if (effectiveGroupBy === "day") return r.date;
    if (effectiveGroupBy === "shop") return r.shopName;
    return "Total";
  };
  const groups = {};
  for (const r of filteredRows) {
    const key = keyFor(r);
    if (!groups[key]) groups[key] = { label: key, totalHours: 0 };
    groups[key].totalHours += r.hours;
  }
  let groupList = Object.values(groups).sort((a, b) => b.totalHours - a.totalHours);

  const p = paginate(groupList, limit, offset);
  const labourPart = { ranked: false, note: null, groups: p.page, costToday, incompleteCount, errors };
  const text = withCurrency(formatLabourPart(labourPart));

  const header = [`LABOUR — ${start} to ${end} (grouped by ${effectiveGroupBy})`];
  if (employeeName) header.push(`Filtered to employees matching "${employeeName}"`);
  if (effectiveGroupBy === "employee" || effectiveGroupBy === "none") {
    header.push(`Roster who worked in this period: ${roster.map((r) => r.name).join(", ") || "(none)"}`);
  }
  return [...header, "", text, paginationFooter(p)].join("\n");
}

// ---------- Invoices (what a shop was charged by the central kitchen) ----------

function queryInvoiceWeeksByCategory(shops, start, end, category) {
  const shopRows = db
    .prepare("SELECT id, slug, name FROM users WHERE role = 'shop'")
    .all()
    .filter((s) => shops.includes(s.slug));

  const weeks = [];
  const lastWeekStart = mondayOnOrBefore(end);
  const categoryClause = category && category !== "all" ? "AND c.slug = ?" : "";
  for (let weekStart = mondayOnOrBefore(start); weekStart <= lastWeekStart; weekStart = addDaysISO(weekStart, 7)) {
    const weekEnd = addDaysISO(weekStart, 6);
    for (const shop of shopRows) {
      const params = [shop.id, weekStart, weekEnd];
      if (category && category !== "all") params.push(category);
      const itemRows = db
        .prepare(
          `SELECT oi.name, oi.unit, SUM(oi.quantity) AS quantity, MAX(i.price) AS price
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN items i ON i.id = oi.item_id
           LEFT JOIN categories c ON c.id = i.category_id
           WHERE o.shop_id = ? AND o.delivery_date BETWEEN ? AND ? AND oi.item_id IS NOT NULL ${categoryClause}
           GROUP BY oi.name, oi.unit
           ORDER BY oi.name`
        )
        .all(...params);
      if (itemRows.length === 0) continue;

      const items = itemRows.map((r) => ({ name: r.name, unit: r.unit, quantity: r.quantity, price: r.price }));
      const total = items.reduce((s, it) => s + (it.price !== null ? it.price * it.quantity : 0), 0);
      const hasUnpriced = items.some((it) => it.price === null);
      const sentRow = db.prepare("SELECT sent_at FROM invoice_log WHERE week_start_date = ? AND shop_id = ?").get(weekStart, shop.id);
      weeks.push({
        shopName: shop.name,
        weekStart,
        weekEnd,
        items,
        total,
        hasUnpriced,
        sent: Boolean(sentRow),
        sentAt: sentRow ? sentRow.sent_at : null,
      });
    }
  }
  return weeks;
}

function searchInvoices({ shops, start, end, category }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  const cat = ["food", "paper", "cans", "all"].includes(category) ? category : "all";

  const invoices =
    cat === "all"
      ? buildInvoiceSearchPart(db, { shops: resolvedShops, start, end, rank: false, rankOrder: "desc" })
      : { weeks: queryInvoiceWeeksByCategory(resolvedShops, start, end, cat), rank: false, rankOrder: "desc" };

  const header = `(category: ${cat === "all" ? "all (food + paper + grab n go combined)" : cat}; "sent" reflects the whole week's invoice bundle, not per-category)`;
  return [header, "", withCurrency(formatInvoicePart(invoices))].join("\n");
}

// ---------- Del Re (separate wholesale supplier) ----------

function searchDelreOrders({ shops, start, end }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  const placeholders = resolvedShops.map(() => "?").join(",");
  const orders = db
    .prepare(
      `SELECT o.id, o.created_at, u.slug AS shop_slug, u.name AS shop_name
       FROM delre_orders o
       JOIN users u ON u.id = o.shop_id
       WHERE u.slug IN (${placeholders}) AND substr(o.created_at, 1, 10) >= ? AND substr(o.created_at, 1, 10) <= ?
       ORDER BY o.created_at DESC`
    )
    .all(...resolvedShops, start, end);

  if (orders.length === 0) return `No Del Re orders found for ${resolvedShops.join(", ")} between ${start} and ${end}.`;

  const getItems = db.prepare(
    `SELECT oi.name, oi.unit, oi.current_stock, oi.quantity
     FROM delre_order_items oi
     WHERE oi.order_id = ?
     ORDER BY oi.id`
  );

  const lines = [`DEL RE ORDERS (separate wholesale supplier, no $ pricing tracked here) — ${start} to ${end}`, ""];
  for (const o of orders) {
    lines.push(`${o.shop_name} — submitted ${o.created_at}`);
    for (const item of getItems.all(o.id)) {
      lines.push(`    ${item.quantity} ${item.unit} ${item.name}${item.current_stock !== null ? ` (had ${item.current_stock} on hand)` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- Kitchen orders (raw quantities ordered, not $ invoiced) ----------

function searchKitchenOrders({ shops, start, end, category, limit, offset }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  const cat = ["food", "paper", "cans", "all"].includes(category) ? category : "all";
  const placeholders = resolvedShops.map(() => "?").join(",");
  const categoryClause = cat !== "all" ? "AND c.slug = ?" : "";
  const params = [...resolvedShops, start, end];
  if (cat !== "all") params.push(cat);

  const rows = db
    .prepare(
      `SELECT o.delivery_date, u.slug AS shop_slug, u.name AS shop_name, oi.name, oi.unit, oi.quantity, c.name AS category_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN users u ON u.id = o.shop_id
       LEFT JOIN items i ON i.id = oi.item_id
       LEFT JOIN categories c ON c.id = i.category_id
       WHERE u.slug IN (${placeholders}) AND o.delivery_date >= ? AND o.delivery_date <= ? AND oi.item_id IS NOT NULL ${categoryClause}
       ORDER BY o.delivery_date, u.slug, oi.name`
    )
    .all(...params);

  if (rows.length === 0) return `No kitchen orders found for the given shops/range/category (${cat}).`;

  const p = paginate(rows, limit, offset);
  const lines = [`KITCHEN ORDERS (raw quantities ordered — category: ${cat}) — ${start} to ${end}`, ""];
  for (const r of p.page) {
    lines.push(`  ${r.delivery_date} — ${r.shop_name} — ${r.quantity} ${r.unit} ${r.name} (${r.category_name || "uncategorized"})`);
  }
  lines.push(paginationFooter(p));
  return lines.join("\n");
}

// ---------- Stock checks ----------

function searchStockChecks({ shops, start, end }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  const placeholders = resolvedShops.map(() => "?").join(",");
  const checks = db
    .prepare(
      `SELECT * FROM stock_checks WHERE shop_slug IN (${placeholders}) AND check_date >= ? AND check_date <= ? ORDER BY check_date DESC`
    )
    .all(...resolvedShops, start, end);

  if (checks.length === 0) return `No stock checks found for the given shops/range (only Essendon has a checklist set up so far).`;

  const getEntries = db.prepare(
    `SELECT name, par_level, par_unit, current_stock, shortfall FROM stock_check_entries WHERE stock_check_id = ? ORDER BY id`
  );

  const lines = [`STOCK CHECKS — ${start} to ${end}`, ""];
  for (const c of checks) {
    lines.push(`${ALL_SHOP_NAMES[c.shop_slug] || c.shop_slug} — ${c.check_date} (submitted by ${c.submitted_by || "unknown"})`);
    const entries = getEntries.all(c.id);
    const short = entries.filter((e) => e.shortfall > 0);
    if (short.length === 0) {
      lines.push(`    Nothing needed from the back that day.`);
    } else {
      for (const e of short) {
        lines.push(`    ${e.name}: grab ${e.shortfall} ${e.par_unit} (had ${e.current_stock}, par ${e.par_level})`);
      }
    }
    if (c.notes) lines.push(`    Notes: ${c.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- General hub search ----------

function searchSupplierProducts(query) {
  return db
    .prepare(
      `SELECT i.name, i.unit, i.price, u.name AS shop_name, c.name AS category
       FROM items i
       LEFT JOIN users u ON u.id = i.shop_id
       LEFT JOIN categories c ON c.id = i.category_id
       WHERE i.active = 1 AND i.name LIKE ?
       ORDER BY i.name
       LIMIT 50`
    )
    .all(`%${query}%`);
}

function formatProductRow(r) {
  const price = r.price !== null && r.price !== undefined ? formatMoney(r.price) : "no price set";
  const scope = r.shop_name ? r.shop_name : "all shops";
  return `${r.name} — ${price} per ${r.unit} (${r.category || "uncategorized"}; ${scope})`;
}

// ---------- Read-only arbitrary SQL ----------

let readonlyDb = null;
function getReadonlyDb() {
  if (!readonlyDb) {
    readonlyDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  }
  return readonlyDb;
}

function isSafeReadOnlySql(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.includes(";")) return false; // no stacked statements
  if (!/^(select|pragma)\s/i.test(trimmed)) return false;
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|vacuum|replace|reindex)\b/i.test(trimmed)) return false;
  return true;
}

const TABLE_LIST = [
  "users",
  "categories",
  "items",
  "orders",
  "order_items",
  "shop_item_pars",
  "invoice_log",
  "delre_categories",
  "delre_items",
  "delre_orders",
  "delre_order_items",
  "shop_sales_targets",
  "daily_report_log",
  "labour_adjustments",
  "sales_adjustments",
  "cookie_bake_targets",
  "cookie_bake_log",
  "shop_float_settings",
  "eod_cash_sheets",
  "eod_cash_report_log",
  "daily_shop_snapshots",
  "catering_orders_manual",
  "staff_pins",
  "stock_checklist_items",
  "stock_checks",
  "stock_check_entries",
];

// ---------- MCP server ----------

function getServer() {
  const server = new McpServer({ name: "qtr-kitchen-hub", version: "2.0.0" }, { capabilities: {} });

  server.registerTool(
    "list_data_sources",
    {
      description:
        "Lists every data source and tool available on this QTR Kitchen Hub connector, so you know what's available before searching. Always read-only.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: [
            "QTR KITCHEN HUB — available read-only data sources:",
            "",
            "SHOPS: essendon, highpoint, mooneeponds (= Quarter Two, display name used elsewhere), melbournecentral.",
            "melbournecentral has no Square/Tanda connection (no sales/labour/report data), but has invoices/orders/EOD cash like the others.",
            "",
            "- search_square_sales: sales totals/by shop/by day/by hour/by item/top sellers, from Square. essendon/highpoint/mooneeponds only. Pass itemNameContains to count units sold of a product group instead of whole-order totals — e.g. for Grab n Go, use [\"gng\",\"chia\",\"oats\",\"yoghurt\",\"yogurt\",\"granola\"]: Highpoint's POS names it \"GNG combo\"/\"GNG cans\", while Essendon's POS names individual flavors (\"Oats vanilla\", \"Chia blueberry\", etc) — confirmed against real data, use both keyword sets together for full coverage across shops.",
            "- search_square_refunds: refunds by shop/date range, from Square.",
            "- search_labour: who worked, hours, labour cost, by employee/day/shop, from Tanda. $ cost only available for today.",
            "- search_invoices: what a shop was charged by the central kitchen (food/paper goods/grab n go), by week.",
            "- search_kitchen_orders: raw quantities a shop ordered from the central kitchen (not the $ invoice view).",
            "- search_delre_orders: orders/stock submitted to Del Re, a separate wholesale supplier (no $ pricing tracked).",
            "- search_stock_checks: par levels, current stock counted, and shortfalls — Essendon only so far.",
            "- search_catering: catering/event orders (manual + Square checkout), by event date.",
            "- search_eod_cash: daily till reconciliation (cash/EFTPOS/Uber sales, discrepancies) per shop.",
            "- search_daily_reports: saved daily COGS %/labour %/prime cost %/vs-target performance snapshots.",
            "- get_cogs: Joel's own per-item cost-of-goods figures, per shop (static, not time-series).",
            "- search_supplier_products / search_hub: the kitchen's internal ordering catalog (name, unit, price).",
            "- get_recipes / get_branding_info: not loaded yet, always return a placeholder.",
            "- query_database: arbitrary read-only SELECT (or PRAGMA table_info) against a true read-only DB connection, for anything not covered above. Tables: " +
              TABLE_LIST.join(", "),
            "",
            "All dates are Melbourne local (YYYY-MM-DD). All money is returned with currency (AUD). Large results are paginated via limit/offset.",
          ].join("\n"),
        },
      ],
    })
  );

  server.registerTool(
    "search_square_sales",
    {
      description:
        "Search Square sales: net sales, transaction counts, discounts, or — if itemNameContains is given — units SOLD and revenue of just matching products (e.g. \"how many Grab n Go sold today at Highpoint\" -> itemNameContains: [\"gng\",\"chia\",\"oats\",\"yoghurt\",\"yogurt\",\"granola\"]). Totals, by shop, by day, by hour of day, or by item (top sellers). POS item names differ PER SHOP, not just from the kitchen catalog — e.g. Highpoint sells Grab n Go as \"GNG combo\"/\"GNG cans\" while Essendon sells individual flavors (\"Oats vanilla\", \"Chia blueberry\"), so itemNameContains should include every naming variant across shops, not just one. Read-only.",
      inputSchema: {
        shops: shopsField,
        start: startField,
        end: endField,
        groupBy: z.enum(["total", "shop", "day", "hour", "item", "top_sellers"]).optional().describe("How to break down the result (default: total)"),
        itemNameContains: z
          .array(z.string())
          .optional()
          .describe(
            "Only count line items whose Square product name contains ANY of these (case-insensitive substrings) — e.g. [\"gng\",\"chia\",\"oats\",\"yoghurt\",\"yogurt\",\"granola\"] for Grab n Go (covers both Highpoint's \"GNG\" naming and Essendon's per-flavor naming). Omit to cover all sales."
          ),
        limit: limitField,
        offset: offsetField,
      },
    },
    async (args) => ({ content: [{ type: "text", text: await searchSquareSales(args) }] })
  );

  server.registerTool(
    "search_square_refunds",
    {
      description: "Search Square refunds by shop and date range — amount, status, reason. Read-only.",
      inputSchema: { shops: shopsField, start: startField, end: endField, limit: limitField, offset: offsetField },
    },
    async (args) => ({ content: [{ type: "text", text: await searchSquareRefunds(args) }] })
  );

  server.registerTool(
    "search_labour",
    {
      description:
        "Search rosters/labour from Tanda: who worked, hours, labour cost, by shop/date range, grouped by employee, day, or shop. Labour $ cost is only available for today (Tanda has no historical cost endpoint). Read-only.",
      inputSchema: {
        shops: shopsField,
        start: startField,
        end: endField,
        groupBy: z.enum(["employee", "day", "shop", "none"]).optional().describe("Default: employee"),
        employeeName: z.string().optional().describe("Filter to employees whose name contains this text"),
        limit: limitField,
        offset: offsetField,
      },
    },
    async (args) => ({ content: [{ type: "text", text: await searchLabour(args) }] })
  );

  server.registerTool(
    "search_invoices",
    {
      description:
        "Search what a shop was CHARGED by the central kitchen for its weekly food/paper-goods/grab-n-go orders — item quantities, prices, weekly totals, whether sent. Filterable by shop, date range, and category. Read-only.",
      inputSchema: {
        shops: shopsField,
        start: startField,
        end: endField,
        category: z.enum(["food", "paper", "cans", "all"]).optional().describe("cans = Grab n Go. Default: all"),
      },
    },
    async (args) => ({ content: [{ type: "text", text: searchInvoices(args) }] })
  );

  server.registerTool(
    "search_kitchen_orders",
    {
      description:
        "Search the raw quantities a shop ordered from the central kitchen (food/paper/grab n go) — distinct from search_invoices, which shows the $ charged. Read-only.",
      inputSchema: {
        shops: shopsField,
        start: startField,
        end: endField,
        category: z.enum(["food", "paper", "cans", "all"]).optional().describe("cans = Grab n Go. Default: all"),
        limit: limitField,
        offset: offsetField,
      },
    },
    async (args) => ({ content: [{ type: "text", text: searchKitchenOrders(args) }] })
  );

  server.registerTool(
    "search_delre_orders",
    {
      description:
        "Search orders/stock submitted to Del Re, a separate wholesale supplier independent of the central kitchen catalog. No $ pricing is tracked for Del Re items. Read-only.",
      inputSchema: { shops: shopsField, start: startField, end: endField },
    },
    async (args) => ({ content: [{ type: "text", text: searchDelreOrders(args) }] })
  );

  server.registerTool(
    "search_stock_checks",
    {
      description:
        "Search daily stock checks: par level vs current stock counted, and the computed shortfall ('grab X from the back'). Essendon only so far. Read-only.",
      inputSchema: { shops: shopsField, start: startField, end: endField },
    },
    async (args) => ({ content: [{ type: "text", text: searchStockChecks(args) }] })
  );

  server.registerTool(
    "search_catering",
    {
      description:
        "Search catering/event orders (manual WhatsApp/phone/email entries + Square checkout orders) by event date — customer, items, fulfillment, prep quantities. Read-only.",
      inputSchema: { start: startField, end: endField },
    },
    async ({ start, end }) => {
      if (!validDateRange(start, end)) return { content: [{ type: "text", text: "Invalid date range." }] };
      const result = await buildCateringSearchPart(db, { start, end });
      return { content: [{ type: "text", text: withCurrency(formatCateringPart(result)) }] };
    }
  );

  server.registerTool(
    "search_eod_cash",
    {
      description:
        "Search daily EOD cash reconciliation sheets: till amount, EFTPOS/Uber/cash sales, float, cash counted, discrepancy. Filterable by shop/date range/focus metric. Read-only.",
      inputSchema: {
        shops: shopsField,
        start: startField,
        end: endField,
        focusMetric: z
          .enum(["discrepancy", "till_amount", "cash_sales", "eftpos_sales", "uber_sales", "cash_amount", "float"])
          .optional()
          .describe("Return just this one figure per sheet instead of the full breakdown"),
      },
    },
    async ({ shops, start, end, focusMetric }) => {
      if (!validDateRange(start, end)) return { content: [{ type: "text", text: "Invalid date range." }] };
      const result = buildCashSearchPart(db, { shops: resolveShops(shops), start, end, focusMetric, rank: false, rankOrder: "desc" });
      return { content: [{ type: "text", text: withCurrency(formatCashPart(result)) }] };
    }
  );

  server.registerTool(
    "search_daily_reports",
    {
      description:
        "Search saved daily performance snapshots: net sales, labour %, COGS %, prime cost %, vs target — a trend over a date range. Only available from whenever snapshots started being saved. Read-only.",
      inputSchema: {
        shops: shopsField,
        start: startField,
        end: endField,
        focusMetric: z
          .enum([
            "net_sales",
            "labour_pct",
            "cogs_pct",
            "prime_cost_pct",
            "labour_hours",
            "labour_cost",
            "transaction_count",
            "avg_spend",
            "discounts",
          ])
          .optional(),
      },
    },
    async ({ shops, start, end, focusMetric }) => {
      if (!validDateRange(start, end)) return { content: [{ type: "text", text: "Invalid date range." }] };
      const result = buildReportSearchPart(db, { shops: resolveShops(shops), start, end, focusMetric, rank: false, rankOrder: "desc" });
      return { content: [{ type: "text", text: withCurrency(formatReportPart(result)) }] };
    }
  );

  server.registerTool(
    "get_cogs",
    {
      description:
        "Look up Joel's own per-item cost-of-goods (COGS) figures per shop — a static catalog, not a time series, for working out margins or bundle costs. Read-only.",
      inputSchema: { shops: shopsField },
    },
    async ({ shops }) => {
      const result = buildCogsSearchPart({ shops: resolveShops(shops) });
      return { content: [{ type: "text", text: withCurrency(formatCogsPart(result)) }] };
    }
  );

  server.registerTool(
    "search_supplier_products",
    {
      description:
        "Search QTR's internal product/ordering catalog by name — what each shop orders from the central kitchen, with unit and price. Read-only.",
      inputSchema: { query: z.string().describe("Text to search for in product names, e.g. 'cups' or 'almond milk'") },
    },
    async ({ query }) => {
      const rows = searchSupplierProducts(query);
      const text = rows.length === 0 ? `No supplier products found matching "${query}".` : rows.map(formatProductRow).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "get_recipes",
    {
      description:
        "Look up a QTR recipe or build by name. Not loaded yet — this always returns a placeholder until recipe content is added.",
      inputSchema: { query: z.string().describe("Recipe or item name to look up").optional() },
    },
    async () => ({
      content: [{ type: "text", text: "No recipes have been loaded into this server yet. Ask Joel to add them." }],
    })
  );

  server.registerTool(
    "get_branding_info",
    {
      description:
        "Look up QTR's brand voice, positioning, or visual identity info. Not loaded yet — this always returns a placeholder until branding content is added.",
      inputSchema: { topic: z.string().describe("Branding topic to look up, e.g. 'voice' or 'colors'").optional() },
    },
    async () => ({
      content: [{ type: "text", text: "No branding info has been loaded into this server yet. Ask Joel to add it." }],
    })
  );

  server.registerTool(
    "search_hub",
    {
      description:
        "General search across the QTR Kitchen Hub: the ordering catalog, catering orders (if a date range is given), and COGS item names. For sales, labour, invoices, cash, or stock data, use the dedicated tool instead — see list_data_sources.",
      inputSchema: {
        query: z.string().describe("Free-text search term"),
        start: z.string().regex(DATE_RE).optional().describe("Optional — include catering orders in this event-date range"),
        end: z.string().regex(DATE_RE).optional(),
      },
    },
    async ({ query, start, end }) => {
      const lines = [];
      const products = searchSupplierProducts(query);
      lines.push(products.length > 0 ? `Supplier products matching "${query}":` : `No supplier products matched "${query}".`);
      products.forEach((r) => lines.push(`  - ${formatProductRow(r)}`));

      if (start && end && validDateRange(start, end)) {
        lines.push("", `Catering orders in ${start} to ${end} mentioning "${query}":`);
        const catering = await buildCateringSearchPart(db, { start, end });
        const needle = query.toLowerCase();
        const matches = catering.orders.filter(
          (o) => (o.customer || "").toLowerCase().includes(needle) || o.lineItems.some((li) => li.name.toLowerCase().includes(needle))
        );
        if (matches.length === 0) lines.push("  (none)");
        matches.forEach((o) => lines.push(`  - ${o.eventDate} — ${o.customer || "(no name)"} [${o.source}]`));
      }

      lines.push("", "(For sales, labour, invoices, cash, or stock data, use the dedicated search tool — see list_data_sources.)");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "query_database",
    {
      description:
        `Run an arbitrary read-only SQL query (SELECT or PRAGMA table_info only — no writes are possible, this runs against a connection opened in SQLite read-only mode) for anything not covered by a dedicated tool. Tables: ${TABLE_LIST.join(", ")}. Use "SELECT name FROM sqlite_master WHERE type='table'" or "PRAGMA table_info(tablename)" to explore the schema. Results are capped at 200 rows.`,
      inputSchema: {
        sql: z.string().describe("A single SELECT or PRAGMA table_info statement"),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows to return (default 100, max 200)"),
      },
    },
    async ({ sql, limit }) => {
      if (!isSafeReadOnlySql(sql)) {
        return {
          content: [
            { type: "text", text: "Only a single read-only SELECT or PRAGMA table_info statement is allowed — no semicolons, no write keywords." },
          ],
        };
      }
      const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);
      try {
        const rodb = getReadonlyDb();
        const rows = rodb.prepare(sql).all();
        const page = rows.slice(0, lim);
        const text =
          page.length === 0
            ? "No rows returned."
            : JSON.stringify(page, null, 2) +
              (rows.length > lim ? `\n\n(${rows.length} rows matched; showing first ${lim})` : `\n\n(${rows.length} row(s))`);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Query error: ${err.message}` }] };
      }
    }
  );

  return server;
}

function createMcpRouter() {
  const router = express.Router();
  router.use(express.json());
  router.use(requireMcpAuth);

  router.post("/", async (req, res) => {
    const server = getServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  router.get("/", (req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  router.delete("/", (req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  return router;
}

module.exports = { createMcpRouter };
