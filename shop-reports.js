// Daily end-of-day shop report: pulls sales from Square and labour hours/cost
// from Tanda, computes the dashboard-style metrics Joel wants, and formats a
// plain-text email. Shops are added one at a time as each one's Square
// location and Tanda location are connected — see SHOP_INTEGRATIONS below.

const SQUARE_API_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-01-23";
const TANDA_API_BASE = "https://my.tanda.co/api/v2";

const { COGS_BY_SHOP } = require("./cogs-data");

// Location IDs aren't secret (only the access tokens are). Unlike Tanda
// (one org covers every shop, just different location IDs), each shop is
// its OWN separate Square merchant account — so each shop needs its own
// Square access token env var, named per shop below.
//
// displayName is the name used in the report/email — this system is
// intentionally independent of the `users` table (the food-ordering shop
// accounts), since a reportable business isn't necessarily one of the 4
// shops that order supplies from the central kitchen (e.g. Quarter Two).
const SHOP_INTEGRATIONS = {
  essendon: {
    displayName: "QTR Essendon",
    squareLocationId: "LJWTC3VTB52T3",
    squareTokenEnvVar: "SQUARE_ACCESS_TOKEN",
    tandaLocationId: 409591,
  },
  highpoint: {
    displayName: "QTR Highpoint",
    squareLocationId: "LWGVFS5B0JWS2",
    squareTokenEnvVar: "SQUARE_ACCESS_TOKEN_HIGHPOINT",
    tandaLocationId: 409592,
  },
  quartertwo: {
    displayName: "Quarter Two",
    squareLocationId: "L9SVGVFZHVEDA",
    squareTokenEnvVar: "SQUARE_ACCESS_TOKEN_QUARTERTWO",
    tandaLocationId: 409590,
  },
};

function squareHeaders(squareTokenEnvVar) {
  return {
    "Square-Version": SQUARE_VERSION,
    Authorization: `Bearer ${process.env[squareTokenEnvVar]}`,
    "Content-Type": "application/json",
  };
}

function tandaHeaders() {
  return { Authorization: `Bearer ${process.env.TANDA_ACCESS_TOKEN}` };
}

// Melbourne's UTC offset for a given instant (handles AEST/AEDT automatically).
function melbourneOffsetMinutes(utcDate) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Melbourne",
    timeZoneName: "shortOffset",
  }).formatToParts(utcDate);
  const offsetPart = parts.find((p) => p.type === "timeZoneName").value; // e.g. "GMT+11"
  const match = offsetPart.match(/GMT([+-]\d+)/);
  return match ? Number(match[1]) * 60 : 0;
}

// Start/end of a Melbourne-local calendar date, as UTC instants.
function melbourneDayRangeUtc(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guessUtcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const offsetMin = melbourneOffsetMinutes(guessUtcMidnight);
  const startUtc = new Date(guessUtcMidnight.getTime() - offsetMin * 60000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

function hourBucketsUtc(dateStr) {
  const { startUtc } = melbourneDayRangeUtc(dateStr);
  const buckets = [];
  for (let h = 0; h < 24; h++) {
    const start = new Date(startUtc.getTime() + h * 3600000);
    buckets.push({ hour: h, start, end: new Date(start.getTime() + 3600000) });
  }
  return buckets;
}

function melbourneHourOf(date) {
  return Number(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Melbourne",
      hourCycle: "h23",
      hour: "2-digit",
    }).format(date)
  );
}

async function fetchSquareOrders(squareTokenEnvVar, squareLocationId, startUtc, endUtc) {
  const orders = [];
  let cursor;
  do {
    const res = await fetch(`${SQUARE_API_BASE}/orders/search`, {
      method: "POST",
      headers: squareHeaders(squareTokenEnvVar),
      body: JSON.stringify({
        location_ids: [squareLocationId],
        limit: 100,
        cursor,
        query: {
          filter: {
            date_time_filter: {
              created_at: { start_at: startUtc.toISOString(), end_at: endUtc.toISOString() },
            },
            state_filter: { states: ["COMPLETED"] },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
        },
      }),
    });
    if (!res.ok) throw new Error(`Square orders/search failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    orders.push(...(data.orders || []));
    cursor = data.cursor;
  } while (cursor);
  return orders;
}

// The same "Name (Variation)" convention used when the COGS worksheet was
// built from the Square catalog — variation omitted when it's the item's
// only/default one (named "Regular").
function cogsDisplayName(li) {
  // Square item names sometimes carry trailing/leading whitespace (e.g. a
  // catalog item literally named "Oats vanilla "), but cogs-data.js keys
  // are trimmed — trim here too so a stray space never causes a silent
  // COGS lookup miss.
  const name = (li.name || "").trim();
  const vname = li.variation_name;
  return !vname || vname.toLowerCase() === "regular" ? name : `${name} (${vname.trim()})`;
}

function summarizeSquareOrders(orders, cogsMap) {
  let netSales = 0;
  let totalDiscounts = 0;
  let totalCogs = 0;
  let cogsMappedRevenue = 0;
  const hourly = {}; // hour -> { sales, count }
  const productStats = {}; // name -> { revenue, qty }

  for (const order of orders) {
    const total = (order.total_money?.amount || 0) / 100;
    netSales += total;
    totalDiscounts += (order.total_discount_money?.amount || 0) / 100;

    const hour = melbourneHourOf(new Date(order.created_at));
    if (!hourly[hour]) hourly[hour] = { sales: 0, count: 0 };
    hourly[hour].sales += total;
    hourly[hour].count += 1;

    for (const li of order.line_items || []) {
      const revenue = (li.total_money?.amount || 0) / 100;
      const qty = Number(li.quantity) || 0;
      const productName = (li.name || "").trim();
      if (!productStats[productName]) productStats[productName] = { revenue: 0, qty: 0 };
      productStats[productName].revenue += revenue;
      productStats[productName].qty += qty;

      const unitCogsCents = cogsMap[cogsDisplayName(li)];
      if (unitCogsCents !== undefined) {
        totalCogs += (unitCogsCents * qty) / 100;
        cogsMappedRevenue += revenue;
      }
    }
  }

  return {
    netSales,
    totalDiscounts,
    totalCogs,
    cogsMappedRevenue,
    transactionCount: orders.length,
    hourly,
    productStats,
  };
}

async function fetchTandaDepartmentIds(tandaLocationId) {
  const res = await fetch(`${TANDA_API_BASE}/departments`, { headers: tandaHeaders() });
  if (!res.ok) throw new Error(`Tanda departments failed: ${res.status} ${await res.text()}`);
  const departments = await res.json();
  return new Set(departments.filter((d) => d.location_id === tandaLocationId).map((d) => d.id));
}

async function fetchTandaShifts(dateStr) {
  const res = await fetch(`${TANDA_API_BASE}/shifts?from=${dateStr}&to=${dateStr}`, {
    headers: tandaHeaders(),
  });
  if (!res.ok) throw new Error(`Tanda shifts failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// live_wage_tracker only ever reports the CURRENT day, cumulatively — it
// cannot be queried for past dates. That's why the report runs at a fixed
// time each day (5pm) rather than after midnight: it's the only way to
// capture a day's real $ labour cost at all.
async function fetchTandaLiveLabourCost(tandaLocationId) {
  const res = await fetch(`${TANDA_API_BASE}/reports/live_wage_tracker?location_id=${tandaLocationId}`, {
    headers: tandaHeaders(),
  });
  if (!res.ok) throw new Error(`Tanda live_wage_tracker failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const actual = data.actual_staff_data || [];
  // Each entry is the dollar cost accrued in its OWN 15-minute interval
  // (it tracks headcount up/down, not a running total — confirmed by
  // cross-checking against hours worked), so the day's total cost is the
  // SUM of every interval, not just the most recent one.
  return actual.reduce((sum, entry) => sum + (entry.costs?.total || 0), 0);
}

function summarizeTandaShifts(shifts, departmentIds, dateStr, now) {
  const buckets = hourBucketsUtc(dateStr);
  const hourly = {}; // hour -> hours worked
  let totalHours = 0;

  for (const shift of shifts) {
    if (!departmentIds.has(shift.department_id)) continue;
    if (!shift.start) continue;
    const start = new Date(shift.start * 1000);
    const finish = shift.finish ? new Date(shift.finish * 1000) : now; // still clocked in
    if (finish <= start) continue;

    const breaks = (shift.breaks || [])
      .filter((b) => b.start && b.finish)
      .sort((a, b) => a.start - b.start);

    const intervals = [];
    let cursor = start;
    for (const br of breaks) {
      const bStart = new Date(br.start * 1000);
      const bFinish = new Date(br.finish * 1000);
      if (bStart > cursor) intervals.push([cursor, bStart < finish ? bStart : finish]);
      if (bFinish > cursor) cursor = bFinish;
    }
    if (cursor < finish) intervals.push([cursor, finish]);

    for (const [ws, wf] of intervals) {
      for (const bucket of buckets) {
        const overlapStart = ws > bucket.start ? ws : bucket.start;
        const overlapEnd = wf < bucket.end ? wf : bucket.end;
        const hrs = (overlapEnd - overlapStart) / 3600000;
        if (hrs > 0) {
          hourly[bucket.hour] = (hourly[bucket.hour] || 0) + hrs;
          totalHours += hrs;
        }
      }
    }
  }

  return { totalHours, hourly };
}

// Ranks product stats {name: {revenue, qty}} by revenue, returning
// [name, revenue, qty] triples.
function topProductEntries(productStats, n) {
  return Object.entries(productStats)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, n)
    .map(([name, stats]) => [name, stats.revenue, stats.qty]);
}

async function buildDailyShopReport(db, shopSlug, shopName, addDays, overrideDateStr) {
  const config = SHOP_INTEGRATIONS[shopSlug];
  if (!config) return null;
  if (!process.env[config.squareTokenEnvVar] || !process.env.TANDA_ACCESS_TOKEN) return null;

  const actualTodayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const dateStr = overrideDateStr || actualTodayStr;
  const isToday = dateStr === actualTodayStr;
  const lastWeekStr = addDays(dateStr, -7);
  const weekday = new Date(dateStr + "T00:00:00").getDay();

  const { startUtc, endUtc } = melbourneDayRangeUtc(dateStr);
  const { startUtc: lwStart, endUtc: lwEnd } = melbourneDayRangeUtc(lastWeekStr);
  const now = new Date();

  const [orders, lastWeekOrders, departmentIds] = await Promise.all([
    fetchSquareOrders(config.squareTokenEnvVar, config.squareLocationId, startUtc, endUtc),
    fetchSquareOrders(config.squareTokenEnvVar, config.squareLocationId, lwStart, lwEnd),
    fetchTandaDepartmentIds(config.tandaLocationId),
  ]);

  const cogsMap = COGS_BY_SHOP[shopSlug] || {};
  const today = summarizeSquareOrders(orders, cogsMap);
  const lastWeek = summarizeSquareOrders(lastWeekOrders, cogsMap);

  const shifts = await fetchTandaShifts(dateStr);
  const labour = summarizeTandaShifts(shifts, departmentIds, dateStr, isToday ? now : new Date(endUtc));
  // Tanda's live wage tracker only ever reports the CURRENT day's cumulative
  // cost — it cannot be queried for a past date, so for any date other than
  // today the $ labour cost is genuinely unavailable (not faked as $0).
  let labourCost = isToday ? await fetchTandaLiveLabourCost(config.tandaLocationId) : null;

  // Manual corrections (e.g. a shift logged against the wrong location).
  const adjustment = db
    .prepare(
      "SELECT SUM(hours_delta) AS hours, SUM(cost_cents_delta) AS cost_cents FROM labour_adjustments WHERE report_date = ? AND shop_slug = ?"
    )
    .get(dateStr, shopSlug);
  if (adjustment && adjustment.hours) {
    labour.totalHours += adjustment.hours;
  }
  if (adjustment && adjustment.cost_cents && labourCost !== null) {
    labourCost += adjustment.cost_cents / 100;
  }

  let busiestHour = null;
  for (const [h, v] of Object.entries(today.hourly)) {
    if (busiestHour === null || v.sales > today.hourly[busiestHour].sales) busiestHour = Number(h);
  }

  let mostEfficientHour = null;
  let leastEfficientHour = null;
  let mostEfficientVal = -Infinity;
  let leastEfficientVal = Infinity;
  for (const [h, hrs] of Object.entries(labour.hourly)) {
    const sales = today.hourly[h]?.sales || 0;
    if (hrs <= 0) continue;
    const eff = sales / hrs;
    if (eff > mostEfficientVal) {
      mostEfficientVal = eff;
      mostEfficientHour = Number(h);
    }
    if (eff < leastEfficientVal) {
      leastEfficientVal = eff;
      leastEfficientHour = Number(h);
    }
  }

  const target = db
    .prepare("SELECT target_cents FROM shop_sales_targets WHERE shop_slug = ? AND weekday = ?")
    .get(shopSlug, weekday);

  const labourPct = labourCost !== null && today.netSales ? (labourCost / today.netSales) * 100 : null;
  const cogsPct = today.netSales ? (today.totalCogs / today.netSales) * 100 : null;
  // % of today's revenue that came from line items we actually have a COGS
  // figure for — the rest is unpriced/discontinued menu items, so cogsPct
  // understates true cost by roughly that same gap.
  const cogsCoveragePct = today.netSales ? (today.cogsMappedRevenue / today.netSales) * 100 : null;

  return {
    shopName,
    dateStr,
    isToday,
    netSales: today.netSales,
    transactionCount: today.transactionCount,
    avgSpend: today.transactionCount ? today.netSales / today.transactionCount : 0,
    discounts: today.totalDiscounts,
    targetDollars: target ? target.target_cents / 100 : null,
    lastWeekNetSales: lastWeek.netSales,
    labourHours: labour.totalHours,
    labourCost,
    labourPct,
    cogsDollars: today.totalCogs,
    cogsPct,
    cogsCoveragePct,
    primeCostPct: labourPct !== null && cogsPct !== null ? labourPct + cogsPct : null,
    salesPerLabourHour: labour.totalHours ? today.netSales / labour.totalHours : null,
    transactionsPerLabourHour: labour.totalHours ? today.transactionCount / labour.totalHours : null,
    busiestHour,
    mostEfficientHour,
    leastEfficientHour,
    topProducts: topProductEntries(today.productStats, 5),
    lowestProducts: topProductEntries(today.productStats, 1000).slice(-5).reverse(),
  };
}

function money(n) {
  return `$${n.toFixed(2)}`;
}

function hourLabel(h) {
  if (h === null || h === undefined) return "n/a";
  const to12 = (hh) => {
    const period = hh < 12 ? "am" : "pm";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}${period}`;
  };
  return `${to12(h)}–${to12((h + 1) % 24)}`;
}

function formatDailyReportEmail(report) {
  const vsTarget =
    report.targetDollars !== null
      ? `${money(report.netSales - report.targetDollars)} (${(
          (report.netSales / report.targetDollars) * 100
        ).toFixed(0)}% of target)`
      : "n/a (no target set)";

  const vsLastWeek = report.lastWeekNetSales
    ? `${money(report.netSales - report.lastWeekNetSales)} (${(
        (report.netSales / report.lastWeekNetSales) * 100
      ).toFixed(0)}% of last week)`
    : "n/a";

  const lines = [
    `Daily report — ${report.shopName} — ${report.dateStr}`,
    report.isToday
      ? `(as of send time; today's trading may not be fully complete)`
      : `(labour $ cost is not shown — Tanda only provides live cost for the current day, not past dates)`,
    ``,
    `SALES`,
    `  Total net sales: ${money(report.netSales)}`,
    `  vs daily target (${money(report.targetDollars || 0)}): ${vsTarget}`,
    `  vs same day last week (${money(report.lastWeekNetSales)}): ${vsLastWeek}`,
    `  Total transactions: ${report.transactionCount}`,
    `  Average customer spend: ${money(report.avgSpend)}`,
    `  Discounts given: ${money(report.discounts)}`,
    `  Busiest sales hour: ${hourLabel(report.busiestHour)}`,
    ``,
    `LABOUR`,
    `  Labour hours: ${report.labourHours.toFixed(2)}`,
    `  Labour cost: ${report.labourCost !== null ? money(report.labourCost) : "n/a (today only)"}`,
    `  Labour %: ${report.labourPct !== null ? report.labourPct.toFixed(1) + "%" : "n/a"}`,
    `  Sales per labour hour: ${report.salesPerLabourHour !== null ? money(report.salesPerLabourHour) : "n/a"}`,
    `  Transactions per labour hour: ${
      report.transactionsPerLabourHour !== null ? report.transactionsPerLabourHour.toFixed(2) : "n/a"
    }`,
    `  Most efficient trading hour: ${hourLabel(report.mostEfficientHour)}`,
    `  Least efficient staffed hour: ${hourLabel(report.leastEfficientHour)}`,
    ``,
    `COGS (cost of goods sold — does not include labour)`,
    `  COGS: ${money(report.cogsDollars)}`,
    `  COGS %: ${report.cogsPct !== null ? report.cogsPct.toFixed(1) + "%" : "n/a"}`,
    `  Priced-menu coverage: ${
      report.cogsCoveragePct !== null ? report.cogsCoveragePct.toFixed(0) + "% of today's revenue" : "n/a"
    } — the rest is from items without a cost on file yet, so COGS is a floor, not the full number`,
    `  Prime cost % (labour % + COGS %): ${
      report.primeCostPct !== null ? report.primeCostPct.toFixed(1) + "%" : "n/a"
    }`,
    ``,
    `TOP-GROSSING PRODUCTS`,
    ...report.topProducts.map(([name, revenue, qty]) => `  ${money(revenue)} — ${name} (${qty} sold)`),
    ``,
    `LOWEST-GROSSING PRODUCTS`,
    ...report.lowestProducts.map(([name, revenue, qty]) => `  ${money(revenue)} — ${name} (${qty} sold)`),
    ``,
    `(Cash discrepancy, waste/remakes and sold-out products are not yet tracked — left out of this report.)`,
  ];

  return lines.join("\n");
}

module.exports = { SHOP_INTEGRATIONS, buildDailyShopReport, formatDailyReportEmail };
