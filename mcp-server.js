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
  fetchSquareOrders,
  fetchSquareRefunds,
  melbourneDayRangeUtc,
  summarizeSquareOrders,
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
const {
  readSquareDailyTotals,
  readSquareItemSales,
  readSquareHourlySales,
  readTandaShiftsSaved,
  readTandaDailyLabour,
  readTandaHourlyLabour,
  SUPER_GUARANTEE_RATE,
} = require("./snapshot-jobs");

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
function fromReportingSlug(reportingSlug) {
  return reportingSlug === "quartertwo" ? "mooneeponds" : reportingSlug;
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

// The permanent-store read path: historical days (everything before today)
// come from the nightly snapshot tables (instant, no Square call); only
// TODAY, if it's in range, goes live. Returns day/item/hour records in a
// common shape regardless of which source they came from, so callers don't
// need to care. Item records carry a date, so "quantity of X over a range"
// and "X per day" both work from square_item_sales alone — there is no
// saved hour-by-item breakdown (only whole-shop hourly totals), so
// itemNameContains + groupBy "hour" is flagged as unavailable for historical
// ranges rather than silently answered wrong.
async function getSquareSalesData(shops, start, end) {
  const todayStr = todayMelbourneStr();
  const historicalEnd = end < todayStr ? end : addDaysISO(todayStr, -1);
  const needsLiveToday = start <= todayStr && todayStr <= end;
  const errors = {};

  const dayRows = [];
  const itemRows = [];
  const hourRows = [];

  if (start <= historicalEnd) {
    const reportingShops = shops.map(toReportingSlug);
    for (const r of readSquareDailyTotals(db, reportingShops, start, historicalEnd)) {
      dayRows.push({
        shopSlug: fromReportingSlug(r.shop_slug),
        date: r.date,
        netSalesCents: r.net_sales_cents,
        grossSalesCents: r.gross_sales_cents,
        discountsCents: r.discounts_cents,
        refundsCents: r.refunds_cents,
        transactionCount: r.transaction_count,
      });
    }
    for (const r of readSquareItemSales(db, reportingShops, start, historicalEnd)) {
      itemRows.push({
        shopSlug: fromReportingSlug(r.shop_slug),
        date: r.date,
        name: r.item_name,
        variation: r.variation_name,
        qty: r.quantity,
        revenueCents: r.net_revenue_cents,
      });
    }
    for (const r of readSquareHourlySales(db, reportingShops, start, historicalEnd)) {
      hourRows.push({
        shopSlug: fromReportingSlug(r.shop_slug),
        date: r.date,
        hour: r.hour,
        netSalesCents: r.net_sales_cents,
        transactionCount: r.transaction_count,
      });
    }
  }

  if (needsLiveToday) {
    const { perShop, errors: liveErrors } = await fetchSalesOrdersForShops(shops, todayStr, todayStr);
    Object.assign(errors, liveErrors);
    for (const slug of shops) {
      const orders = perShop[slug];
      if (!orders) continue;
      const s = summarizeSquareOrders(orders, {});
      dayRows.push({
        shopSlug: slug,
        date: todayStr,
        netSalesCents: Math.round(s.netSales * 100),
        grossSalesCents: Math.round((s.netSales + s.totalDiscounts) * 100),
        discountsCents: Math.round(s.totalDiscounts * 100),
        refundsCents: 0, // live path doesn't fetch refunds — use search_square_refunds for today's refunds
        transactionCount: s.transactionCount,
      });
      for (const [name, stat] of Object.entries(s.productStats)) {
        itemRows.push({ shopSlug: slug, date: todayStr, name, variation: "", qty: stat.qty, revenueCents: Math.round(stat.revenue * 100) });
      }
      for (const [hour, stat] of Object.entries(s.hourly)) {
        hourRows.push({ shopSlug: slug, date: todayStr, hour: Number(hour), netSalesCents: Math.round(stat.sales * 100), transactionCount: stat.count });
      }
    }
  }

  return {
    dayRows,
    itemRows,
    hourRows,
    errors,
    needsLiveToday,
    note: needsLiveToday
      ? "Today's figures are live from Square; every earlier date is from the saved nightly snapshot store."
      : "All figures are from the saved nightly snapshot store (instant — no live Square call for this range).",
  };
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

async function searchSquareSales({ shops, start, end, groupBy, itemNameContains, limit, offset }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  const needles = Array.isArray(itemNameContains) ? itemNameContains.filter(Boolean) : [];
  const effectiveGroupBy = groupBy || "total";

  if (effectiveGroupBy === "hour" && needles.length > 0) {
    return "By-hour sales for a specific item group aren't available — the saved snapshot store only keeps whole-shop hourly totals, not an hourly breakdown per item. Use groupBy \"item\"/\"day\"/\"total\" with itemNameContains instead, or groupBy \"hour\" without itemNameContains for whole-shop hourly sales.";
  }

  const { dayRows, itemRows, hourRows, errors, note } = await getSquareSalesData(resolvedShops, start, end);
  const lines = [`SQUARE SALES — ${start} to ${end} (Melbourne time)${needles.length ? ` — items matching: ${needles.join(", ")}` : ""}`, `(${note})`, ""];
  for (const [slug, msg] of Object.entries(errors)) lines.push(`(${ALL_SHOP_NAMES[slug] || slug}: ${msg})`);
  if (Object.keys(errors).length) lines.push("");

  if (dayRows.length === 0) {
    lines.push("No sales found for the connected shop(s) in that range.");
    return lines.join("\n");
  }

  // Per-shop totals (ALL sales, unfiltered) always included for context.
  lines.push(needles.length > 0 ? "Per-shop totals (ALL sales, unfiltered, for context):" : "Per-shop totals:");
  for (const slug of resolvedShops) {
    const rows = dayRows.filter((r) => r.shopSlug === slug);
    if (rows.length === 0) continue;
    const netSales = rows.reduce((s, r) => s + r.netSalesCents, 0) / 100;
    const txCount = rows.reduce((s, r) => s + r.transactionCount, 0);
    const discounts = rows.reduce((s, r) => s + r.discountsCents, 0) / 100;
    lines.push(
      needles.length > 0
        ? `  ${ALL_SHOP_NAMES[slug] || slug}: ${formatMoney(netSales)} net sales, ${txCount} transactions`
        : `  ${ALL_SHOP_NAMES[slug] || slug}: ${formatMoney(netSales)} net sales, ${txCount} transactions, ${formatMoney(discounts)} discounts`
    );
  }
  lines.push("");

  const matchingItemRows = needles.length > 0 ? itemRows.filter((r) => matchesAnyNeedle(r.name, needles)) : itemRows;

  if (needles.length > 0) {
    const totalQty = matchingItemRows.reduce((s, r) => s + r.qty, 0);
    const totalRevenue = matchingItemRows.reduce((s, r) => s + r.revenueCents, 0) / 100;
    lines.push(`Matching items — total: ${totalQty} sold, ${formatMoney(totalRevenue)}`, "");

    if (effectiveGroupBy === "shop") {
      lines.push("Matching items, by shop:");
      for (const slug of resolvedShops) {
        const rows = matchingItemRows.filter((r) => r.shopSlug === slug);
        if (rows.length === 0) continue;
        const qty = rows.reduce((s, r) => s + r.qty, 0);
        const revenue = rows.reduce((s, r) => s + r.revenueCents, 0) / 100;
        lines.push(`  ${ALL_SHOP_NAMES[slug] || slug}: ${qty} sold, ${formatMoney(revenue)}`);
      }
    } else if (effectiveGroupBy === "day") {
      const byDay = {};
      for (const r of matchingItemRows) {
        if (!byDay[r.date]) byDay[r.date] = { qty: 0, revenueCents: 0 };
        byDay[r.date].qty += r.qty;
        byDay[r.date].revenueCents += r.revenueCents;
      }
      const rows = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
      const p = paginate(rows, limit, offset);
      lines.push("By day:");
      for (const [day, s] of p.page) lines.push(`  ${day}: ${s.qty} sold, ${formatMoney(s.revenueCents / 100)}`);
      lines.push(paginationFooter(p));
    } else if (effectiveGroupBy === "item" || effectiveGroupBy === "top_sellers") {
      const byItem = {};
      for (const r of matchingItemRows) {
        const key = r.variation ? `${r.name} (${r.variation})` : r.name;
        if (!byItem[key]) byItem[key] = { qty: 0, revenueCents: 0 };
        byItem[key].qty += r.qty;
        byItem[key].revenueCents += r.revenueCents;
      }
      const rows = Object.entries(byItem).sort((a, b) => b[1].revenueCents - a[1].revenueCents);
      const p = paginate(rows, limit, offset);
      lines.push("By matching item:");
      p.page.forEach(([name, s], i) => lines.push(`  ${p.offset + i + 1}. ${name} — ${formatMoney(s.revenueCents / 100)}, ${s.qty} sold`));
      lines.push(paginationFooter(p));
    }
    // effectiveGroupBy === "total" already shown above.
    return lines.join("\n");
  }

  if (effectiveGroupBy === "total") {
    const netSales = dayRows.reduce((s, r) => s + r.netSalesCents, 0) / 100;
    const txCount = dayRows.reduce((s, r) => s + r.transactionCount, 0);
    const discounts = dayRows.reduce((s, r) => s + r.discountsCents, 0) / 100;
    lines.push(`Combined total: ${formatMoney(netSales)} net sales across ${txCount} transactions, ${formatMoney(discounts)} discounts.`);
  } else if (effectiveGroupBy === "shop") {
    lines.push("(See per-shop totals above.)");
  } else if (effectiveGroupBy === "day") {
    const byDay = {};
    for (const r of dayRows) {
      if (!byDay[r.date]) byDay[r.date] = { netSalesCents: 0, transactionCount: 0 };
      byDay[r.date].netSalesCents += r.netSalesCents;
      byDay[r.date].transactionCount += r.transactionCount;
    }
    const rows = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
    const p = paginate(rows, limit, offset);
    lines.push("By day:");
    for (const [day, s] of p.page) lines.push(`  ${day}: ${formatMoney(s.netSalesCents / 100)} (${s.transactionCount} transactions)`);
    lines.push(paginationFooter(p));
  } else if (effectiveGroupBy === "hour") {
    const byHour = {};
    for (const r of hourRows) {
      if (!byHour[r.hour]) byHour[r.hour] = { netSalesCents: 0, transactionCount: 0 };
      byHour[r.hour].netSalesCents += r.netSalesCents;
      byHour[r.hour].transactionCount += r.transactionCount;
    }
    const rows = Object.entries(byHour).sort((a, b) => Number(a[0]) - Number(b[0]));
    lines.push("By hour of day (aggregated across the whole range):");
    for (const [hour, s] of rows) lines.push(`  ${String(hour).padStart(2, "0")}:00 — ${formatMoney(s.netSalesCents / 100)} (${s.transactionCount} transactions)`);
  } else if (effectiveGroupBy === "item" || effectiveGroupBy === "top_sellers") {
    const byItem = {};
    for (const r of itemRows) {
      const key = r.variation ? `${r.name} (${r.variation})` : r.name;
      if (!byItem[key]) byItem[key] = { qty: 0, revenueCents: 0 };
      byItem[key].qty += r.qty;
      byItem[key].revenueCents += r.revenueCents;
    }
    const rows = Object.entries(byItem).sort((a, b) => b[1].revenueCents - a[1].revenueCents);
    const p = paginate(rows, limit, offset);
    lines.push(effectiveGroupBy === "top_sellers" ? "Top sellers (by revenue):" : "By item (sorted by revenue):");
    p.page.forEach(([name, s], i) => lines.push(`  ${p.offset + i + 1}. ${name} — ${formatMoney(s.revenueCents / 100)}, ${s.qty} sold`));
    lines.push(paginationFooter(p));
  }

  return lines.join("\n");
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

// The permanent-store read path for labour, mirroring getSquareSalesData:
// historical days read from tanda_shifts/tanda_daily_labour (instant, with
// real per-shift $ cost already saved, incl. no-clock-out/unapproved
// flags); only TODAY goes live, where per-shift cost isn't available from
// Tanda at all (only the whole-shop live_wage_tracker total) — so today's
// shift rows carry hours but no cost, and today's cost is folded into
// dailyCostRows as a shop-level total.
async function getLabourShiftData(shops, start, end) {
  const todayStr = todayMelbourneStr();
  const historicalEnd = end < todayStr ? end : addDaysISO(todayStr, -1);
  const needsLiveToday = start <= todayStr && todayStr <= end;
  const errors = {};
  const shiftRows = []; // {shopSlug (ordering), date, userId, userName, startTs, hours, costCents, status, noClockOut}
  const dailyCostRows = []; // {shopSlug, date, totalHours, totalCostCents, totalCostWithSuperCents, missingCostShifts}
  let incompleteCount = 0;
  const costToday = {};

  const reportingShops = shops.map(toReportingSlug);

  if (start <= historicalEnd) {
    for (const r of readTandaShiftsSaved(db, reportingShops, start, historicalEnd)) {
      shiftRows.push({
        shopSlug: fromReportingSlug(r.shop_slug),
        date: r.date,
        userId: r.tanda_user_id,
        userName: r.user_name,
        startTs: r.start_ts,
        hours: r.hours,
        costCents: r.cost_cents,
        status: r.status,
        noClockOut: !!r.no_clock_out,
      });
    }
    for (const r of readTandaDailyLabour(db, reportingShops, start, historicalEnd)) {
      dailyCostRows.push({
        shopSlug: fromReportingSlug(r.shop_slug),
        date: r.date,
        totalHours: r.total_hours,
        totalCostCents: r.total_cost_cents,
        totalCostWithSuperCents: r.total_cost_with_super_cents,
        missingCostShifts: r.missing_cost_shifts,
      });
    }
  }

  if (needsLiveToday) {
    const live = await fetchLabourDataForShops(reportingShops, todayStr, todayStr);
    Object.assign(errors, live.errors);
    incompleteCount += live.incompleteCount;
    for (const r of live.rows) {
      // Today's in-progress shifts are expected to have no finish time yet —
      // that's normal, not a "didn't clock out" problem, so noClockOut is
      // never set true here (only for saved/historical rows above).
      shiftRows.push({
        shopSlug: fromReportingSlug(r.shopSlug),
        date: todayStr,
        userId: Number(r.userId),
        userName: r.userName,
        startTs: null,
        hours: r.hours,
        costCents: null,
        status: null,
        noClockOut: false,
      });
    }
    for (const [repSlug, costDollars] of Object.entries(live.costToday)) {
      const slug = fromReportingSlug(repSlug);
      costToday[slug] = costDollars;
      const hoursToday = live.rows.filter((r) => r.shopSlug === repSlug).reduce((s, r) => s + r.hours, 0);
      const costCents = Math.round(costDollars * 100);
      dailyCostRows.push({
        shopSlug: slug,
        date: todayStr,
        totalHours: hoursToday,
        totalCostCents: costCents,
        totalCostWithSuperCents: Math.round(costCents * (1 + SUPER_GUARANTEE_RATE)),
        missingCostShifts: 0,
      });
    }
  }

  return {
    shiftRows,
    dailyCostRows,
    costToday,
    incompleteCount,
    errors,
    needsLiveToday,
    note: needsLiveToday
      ? "Today's figures are live from Tanda; every earlier date is from the saved nightly snapshot store."
      : "All figures are from the saved nightly snapshot store (instant — no live Tanda call for this range).",
  };
}

function formatMelbourneTimeOf(ts) {
  if (!ts) return "unknown time";
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(ts * 1000)
  );
}

// Net sales for the same shop/date(s), for computing labour % the same way
// daily_shop_snapshots does (wage-only cost / net sales) — the single
// definition every labour tool in this file uses, so a figure quoted from
// here always matches the existing daily report for the same shop/day.
function getNetSalesByShopDate(shops, start, end) {
  const reportingShops = shops.map(toReportingSlug);
  const map = {}; // "shopSlug|date" -> netSalesCents
  for (const r of readSquareDailyTotals(db, reportingShops, start, end)) {
    map[`${fromReportingSlug(r.shop_slug)}|${r.date}`] = r.net_sales_cents;
  }
  return map;
}

async function searchLabour({ shops, start, end, groupBy, employeeId, employeeIds, employeeName, limit, offset }) {
  if (!validDateRange(start, end)) return "Invalid date range — start must be <= end, both YYYY-MM-DD.";
  const resolvedShops = resolveShops(shops);
  let effectiveGroupBy = ["employee", "day", "shop", "hour", "none"].includes(groupBy) ? groupBy : "employee";

  const idFilter = new Set(
    [...(employeeId ? [employeeId] : []), ...(Array.isArray(employeeIds) ? employeeIds : [])].map(Number).filter(Boolean)
  );

  if (effectiveGroupBy === "hour") {
    const todayStr = todayMelbourneStr();
    const historicalEnd = end < todayStr ? end : addDaysISO(todayStr, -1);
    const reportingShops = resolvedShops.map(toReportingSlug);
    const lines = [`LABOUR BY HOUR OF DAY — ${start} to ${end}`];
    if (todayStr >= start && todayStr <= end) {
      lines.push("(Today is excluded — the saved snapshot only covers past days, and Tanda has no live hour-by-hour cost breakdown for an in-progress day.)");
    }
    if (start > historicalEnd) {
      lines.push("", "No historical days in this range to report on.");
      return lines.join("\n");
    }
    const hourly = readTandaHourlyLabour(db, reportingShops, start, historicalEnd);
    const byHour = {};
    for (const r of hourly) {
      if (!byHour[r.hour]) byHour[r.hour] = { hours: 0, costCents: 0 };
      byHour[r.hour].hours += r.hours;
      byHour[r.hour].costCents += r.cost_cents;
    }
    const rows = Object.entries(byHour).sort((a, b) => Number(a[0]) - Number(b[0]));
    lines.push("", "By hour of day (aggregated across the whole range; wage cost only — add super separately, see search_labour groupBy day/shop):");
    for (const [hour, s] of rows) lines.push(`  ${String(hour).padStart(2, "0")}:00 — ${s.hours.toFixed(2)} hrs, ${formatMoney(s.costCents / 100)} wage`);
    return withCurrency(lines.join("\n"));
  }

  const { shiftRows, dailyCostRows, costToday, incompleteCount, errors, note } = await getLabourShiftData(resolvedShops, start, end);

  let filteredRows = shiftRows;
  let matchNote = null;
  if (idFilter.size > 0) {
    filteredRows = shiftRows.filter((r) => idFilter.has(r.userId));
  } else if (employeeName && employeeName.trim()) {
    const needle = employeeName.trim().toLowerCase();
    filteredRows = shiftRows.filter((r) => r.userName.toLowerCase().includes(needle));
    const distinctIds = new Set(filteredRows.map((r) => r.userId));
    if (distinctIds.size > 1) {
      // Ambiguous name match — never combine different people's hours.
      // Force per-employee grouping regardless of what was asked for.
      effectiveGroupBy = "employee";
      const names = [...new Set(filteredRows.map((r) => r.userName))];
      matchNote = `"${employeeName}" matched ${distinctIds.size} different people (${names.join(", ")}) — showing each separately. Use employeeId to target just one.`;
    }
  }
  const roster = [...new Set(shiftRows.map((r) => r.userName))].sort();

  const keyFor = (r) => {
    if (effectiveGroupBy === "employee") return r.userName;
    if (effectiveGroupBy === "day") return r.date;
    if (effectiveGroupBy === "shop") return ALL_SHOP_NAMES[r.shopSlug] || r.shopSlug;
    return "Total";
  };
  const groups = {};
  for (const r of filteredRows) {
    const key = keyFor(r);
    if (!groups[key]) groups[key] = { label: key, totalHours: 0 };
    groups[key].totalHours += r.hours || 0;
  }
  let groupList = Object.values(groups).sort((a, b) => b.totalHours - a.totalHours);

  const p = paginate(groupList, limit, offset);
  const labourPart = { ranked: false, note: null, groups: p.page, costToday, incompleteCount, errors };
  const text = withCurrency(formatLabourPart(labourPart));

  const header = [`LABOUR — ${start} to ${end} (grouped by ${effectiveGroupBy})`, `(${note})`];
  if (matchNote) header.push(`NOTE: ${matchNote}`);
  else if (employeeName) header.push(`Filtered to employees matching "${employeeName}"`);
  else if (idFilter.size > 0) header.push(`Filtered to employee ID(s): ${[...idFilter].join(", ")}`);
  if (effectiveGroupBy === "employee" || effectiveGroupBy === "none") {
    header.push(`Roster who worked in this period: ${roster.join(", ") || "(none)"}`);
  }

  // Daily/shop labour cost + % — % always wage-only / net sales, the same
  // definition the daily report (daily_shop_snapshots) uses, so a figure
  // quoted from here never disagrees with that report for the same day.
  const costLines = [];
  if (dailyCostRows.length > 0) {
    const netSalesByShopDate = getNetSalesByShopDate(resolvedShops, start, end);
    const byDay = {};
    for (const r of dailyCostRows) {
      if (!byDay[r.date]) byDay[r.date] = { hours: 0, costCents: 0, costWithSuperCents: 0, missing: 0, netSalesCents: 0, hasNetSales: false };
      byDay[r.date].hours += r.totalHours;
      byDay[r.date].costCents += r.totalCostCents;
      byDay[r.date].costWithSuperCents += r.totalCostWithSuperCents;
      byDay[r.date].missing += r.missingCostShifts;
      const netSalesCents = netSalesByShopDate[`${r.shopSlug}|${r.date}`];
      if (netSalesCents !== undefined) {
        byDay[r.date].netSalesCents += netSalesCents;
        byDay[r.date].hasNetSales = true;
      }
    }
    costLines.push("", "Daily labour cost (wage, and wage + super) and labour % (wage / net sales — same definition as the daily report):");
    for (const [date, s] of Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]))) {
      const pct = s.hasNetSales && s.netSalesCents > 0 ? ((s.costCents / s.netSalesCents) * 100).toFixed(1) + "%" : "n/a (no sales data for this day)";
      costLines.push(
        `  ${date}: ${s.hours.toFixed(2)} hrs, ${formatMoney(s.costCents / 100)} wage (${formatMoney(s.costWithSuperCents / 100)} incl. super), labour % ${pct}${
          s.missing > 0 ? ` — ${s.missing} shift(s) missing a Tanda cost` : ""
        }`
      );
    }
  }

  // "Say what's missing" — every labour answer names, not just counts, any
  // shift with no clock-out in the period, plus unapproved-shift counts.
  const missingLines = [];
  const noClockOutRows = shiftRows.filter((r) => r.noClockOut);
  if (noClockOutRows.length > 0) {
    missingLines.push("", `No clock-out (${noClockOutRows.length} shift(s) — hours/cost for these are excluded from every total above):`);
    for (const r of noClockOutRows) {
      missingLines.push(`  ${r.userName} — ${ALL_SHOP_NAMES[r.shopSlug] || r.shopSlug} — ${r.date} — started ${formatMelbourneTimeOf(r.startTs)}`);
    }
  }
  const unapprovedRows = shiftRows.filter((r) => r.status && r.status !== "APPROVED");
  if (unapprovedRows.length > 0) {
    missingLines.push("", `Not yet approved in Tanda (${unapprovedRows.length} shift(s) — figures may still change):`);
    for (const r of unapprovedRows) {
      missingLines.push(`  ${r.userName} — ${ALL_SHOP_NAMES[r.shopSlug] || r.shopSlug} — ${r.date} (${r.status})`);
    }
  }
  if (noClockOutRows.length === 0 && unapprovedRows.length === 0 && Object.keys(errors).length === 0) {
    missingLines.push("", "Nothing missing — every shift in this period has a clock-out and is approved.");
  }

  return [...header, "", text, paginationFooter(p), ...costLines, ...missingLines].join("\n");
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
            "- search_square_sales: sales totals/by shop/by day/by hour/by item/top sellers. essendon/highpoint/mooneeponds only. Past dates are instant (saved nightly snapshot store), today is live. Pass itemNameContains to count units sold of a product group instead of whole-order totals — e.g. for Grab n Go, use [\"gng\",\"chia\",\"oats\",\"yoghurt\",\"yogurt\",\"granola\"]: Highpoint's POS names it \"GNG combo\"/\"GNG cans\", while Essendon's POS names individual flavors (\"Oats vanilla\", \"Chia blueberry\", etc) — confirmed against real data, use both keyword sets together for full coverage across shops. itemNameContains + groupBy hour isn't available (no saved hourly-by-item breakdown).",
            "- search_square_refunds: refunds by shop/date range — always live (not in the snapshot store).",
            "- search_labour: who worked, hours, labour cost (wage + super) by employee/day/shop/hour. Past dates are instant (saved snapshot store, real per-shift Tanda cost), today is live (hours only live, cost from Tanda's live_wage_tracker). groupBy hour excludes today.",
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
        "Search rosters/labour: who worked, hours, labour cost (wage and wage+super) and labour % (wage/net sales — same definition as the daily report), by shop/date range. Always names (not just counts) any shift with no clock-out, and lists any unapproved shift. groupBy employee/day/shop/none groups hours per that dimension and appends a daily labour cost+% breakdown; groupBy hour gives labour cost per hour of the day (e.g. 4-5pm) for the historical part of the range — today excluded there (no live hourly breakdown from Tanda). Prefer employeeId over employeeName — a name can match more than one person (e.g. two Alexes); if it does, each person is listed separately rather than combined. Past dates are instant (saved snapshot store); today is always live. Read-only.",
      inputSchema: {
        shops: shopsField,
        start: startField,
        end: endField,
        groupBy: z.enum(["employee", "day", "shop", "hour", "none"]).optional().describe("Default: employee"),
        employeeId: z.number().int().optional().describe("Tanda user ID — exact match, no ambiguity. Preferred over employeeName."),
        employeeIds: z.array(z.number().int()).optional().describe("Multiple Tanda user IDs, each shown separately"),
        employeeName: z.string().optional().describe("Filter to employees whose name contains this text — if it matches 2+ people, each is shown separately, not combined"),
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
      const result = buildReportSearchPart(db, { shops: resolveShops(shops).map(toReportingSlug), start, end, focusMetric, rank: false, rankOrder: "desc" });
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
      const result = buildCogsSearchPart({ shops: resolveShops(shops).map(toReportingSlug) });
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
