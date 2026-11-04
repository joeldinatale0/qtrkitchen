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

  // Revenue that doesn't come through Square (Uber Eats, other off-platform
  // income) but still counts toward the day's sales.
  const salesAdjustment = db
    .prepare(
      "SELECT SUM(amount_cents_delta) AS cents, GROUP_CONCAT(note, ', ') AS notes FROM sales_adjustments WHERE report_date = ? AND shop_slug = ?"
    )
    .get(dateStr, shopSlug);
  const otherRevenue = (salesAdjustment && salesAdjustment.cents) || 0;
  today.netSales += otherRevenue / 100;

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
    otherRevenue: otherRevenue / 100,
    otherRevenueNote: (salesAdjustment && salesAdjustment.notes) || null,
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

// Cookie flavour is the "Cookie" item's variation_name — Square catalog
// naming for it isn't consistent between shops ("M&M" vs "MnM", "Choc chip"
// vs "choc chip"), so normalize before matching.
function normalizeCookieFlavour(itemName, variationName) {
  const name = (itemName || "").trim().toLowerCase();
  if (name !== "cookie" && name !== "cookies") return null;
  const v = (variationName || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (v.includes("mnm") || v === "mm" || v.includes("mandm")) return "mnm";
  if (v.includes("chocchip")) return "chocchip";
  return null;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Average daily quantity sold of each cookie flavour, Sun-Sat, over the
// last `weeks` fully-completed weeks (default 8), per connected shop.
async function buildCookieSalesReport(weeks = 8) {
  const actualTodayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  function addDaysLocal(isoDate, days) {
    const [y, m, d] = isoDate.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  const endDateStr = addDaysLocal(actualTodayStr, -1); // last fully-completed trading day
  const startDateStr = addDaysLocal(endDateStr, -(weeks * 7 - 1));
  const { startUtc } = melbourneDayRangeUtc(startDateStr);
  const { endUtc } = melbourneDayRangeUtc(endDateStr);

  const results = {};
  for (const [slug, config] of Object.entries(SHOP_INTEGRATIONS)) {
    if (!process.env[config.squareTokenEnvVar]) {
      results[slug] = { shopName: config.displayName, error: "Square not connected" };
      continue;
    }
    const orders = await fetchSquareOrders(config.squareTokenEnvVar, config.squareLocationId, startUtc, endUtc);

    const byWeekday = Array.from({ length: 7 }, () => ({ mnm: 0, chocchip: 0 }));
    const occurrences = Array(7).fill(0);
    const seenDates = new Set();

    for (const order of orders) {
      const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Australia/Melbourne",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(order.created_at));
      seenDates.add(dateStr);
      const weekday = new Date(dateStr + "T00:00:00Z").getUTCDay();
      for (const li of order.line_items || []) {
        const flavour = normalizeCookieFlavour(li.name, li.variation_name);
        if (flavour) byWeekday[weekday][flavour] += Number(li.quantity) || 0;
      }
    }
    for (const d of seenDates) occurrences[new Date(d + "T00:00:00Z").getUTCDay()] += 1;

    const perDay = WEEKDAY_NAMES.map((name, w) => ({
      day: name,
      mnmAvg: occurrences[w] ? byWeekday[w].mnm / occurrences[w] : 0,
      chocchipAvg: occurrences[w] ? byWeekday[w].chocchip / occurrences[w] : 0,
    }));

    results[slug] = { shopName: config.displayName, range: `${startDateStr} to ${endDateStr}`, perDay };
  }
  return results;
}

function normalizeSearchText(s) {
  return (s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Ad hoc sales search: for each search term, across each selected shop,
// every distinct Square line-item name (not collapsed) whose normalized
// name contains the normalized term, with quantity and revenue. Shown as
// a raw breakdown rather than one auto-merged total — catalog naming is
// inconsistent between shops (e.g. "Golden Crunch" vs "Iced Golden
// Crunch"), so the admin reviewing the breakdown decides what to include.
async function buildItemSalesSearch(shopSlugs, searchTerms, startDateStr, endDateStr) {
  const { startUtc } = melbourneDayRangeUtc(startDateStr);
  const { endUtc } = melbourneDayRangeUtc(endDateStr);

  const terms = searchTerms.map((t) => ({ raw: t, norm: normalizeSearchText(t) })).filter((t) => t.norm);

  const perTerm = {};
  for (const t of terms) perTerm[t.raw] = { perShop: {}, grandTotalQty: 0, grandTotalRevenue: 0 };

  const errors = {};

  // Fetch every shop's orders in parallel rather than one at a time — this
  // is the slow part (Square pagination over a wide date range), and there
  // is no reason to serialize it across shops.
  const fetched = await Promise.all(
    shopSlugs.map(async (slug) => {
      const config = SHOP_INTEGRATIONS[slug];
      if (!config) return { slug, orders: null };
      if (!process.env[config.squareTokenEnvVar]) return { slug, orders: null, error: "Square not connected" };
      try {
        const orders = await fetchSquareOrders(config.squareTokenEnvVar, config.squareLocationId, startUtc, endUtc);
        return { slug, orders };
      } catch (err) {
        return { slug, orders: null, error: err.message };
      }
    })
  );

  for (const { slug, orders, error } of fetched) {
    const config = SHOP_INTEGRATIONS[slug];
    if (!config) continue;
    if (error) {
      errors[slug] = error;
      continue;
    }

    // name+variation -> { name, variation, qty, revenue }
    const rowsByKey = {};
    for (const order of orders) {
      for (const li of order.line_items || []) {
        const norm = normalizeSearchText(li.name);
        const revenue = (li.total_money?.amount || 0) / 100;
        const qty = Number(li.quantity) || 0;
        for (const t of terms) {
          if (!norm.includes(t.norm)) continue;
          const key = `${li.name}|${li.variation_name || ""}`;
          if (!rowsByKey[key]) {
            rowsByKey[key] = { name: (li.name || "").trim(), variation: li.variation_name || "", qty: 0, revenue: 0 };
          }
          rowsByKey[key].qty += qty;
          rowsByKey[key].revenue += revenue;

          if (!perTerm[t.raw].perShop[slug]) {
            perTerm[t.raw].perShop[slug] = { shopName: config.displayName, rows: {}, subtotalQty: 0, subtotalRevenue: 0 };
          }
          const shopBucket = perTerm[t.raw].perShop[slug];
          if (!shopBucket.rows[key]) {
            shopBucket.rows[key] = { name: (li.name || "").trim(), variation: li.variation_name || "", qty: 0, revenue: 0 };
          }
          shopBucket.rows[key].qty += qty;
          shopBucket.rows[key].revenue += revenue;
          shopBucket.subtotalQty += qty;
          shopBucket.subtotalRevenue += revenue;
          perTerm[t.raw].grandTotalQty += qty;
          perTerm[t.raw].grandTotalRevenue += revenue;
        }
      }
    }
  }

  // Flatten the rows maps into arrays, sorted by qty descending.
  for (const t of terms) {
    for (const slug of Object.keys(perTerm[t.raw].perShop)) {
      const bucket = perTerm[t.raw].perShop[slug];
      bucket.rows = Object.values(bucket.rows).sort((a, b) => b.qty - a.qty);
    }
  }

  return { startDateStr, endDateStr, terms: terms.map((t) => t.raw), perTerm, errors };
}

function money(n) {
  return `$${n.toFixed(2)}`;
}

function formatSalesSearchEmail(result) {
  const lines = [`Sales Search — ${result.startDateStr} to ${result.endDateStr}`, ``];

  for (const [slug, msg] of Object.entries(result.errors)) {
    lines.push(`(${slug}: ${msg})`);
  }
  if (Object.keys(result.errors).length) lines.push(``);

  for (const term of result.terms) {
    const t = result.perTerm[term];
    lines.push(`"${term}"`, ``);

    const shopBuckets = Object.values(t.perShop);
    if (shopBuckets.length === 0) {
      lines.push(`  No matches.`, ``);
      continue;
    }

    for (const bucket of shopBuckets) {
      lines.push(`  ${bucket.shopName}`);
      for (const r of bucket.rows) {
        const label = r.variation ? `${r.name} (${r.variation})` : r.name;
        lines.push(`    ${r.qty} x ${label} — ${money(r.revenue)}`);
      }
      lines.push(`    Subtotal: ${bucket.subtotalQty} — ${money(bucket.subtotalRevenue)}`, ``);
    }

    lines.push(`  Grand total across shops: ${t.grandTotalQty} sold — ${money(t.grandTotalRevenue)}`, ``, ``);
  }

  return { subject: `Sales Search — ${result.terms.join(", ")} — ${result.startDateStr} to ${result.endDateStr}`, text: lines.join("\n") };
}

// ---- AI-powered natural-language sales search -----------------------------
// Lets the admin ask things like "iced drink sales for the last 30 days,
// ranked highest to lowest" or "grab and go sales broken down by flavour"
// in plain English, instead of picking exact item names from a checklist.
// Two Claude calls: the first resolves the vague parts (which shops, what
// date range) into something code can act on; the second is shown the
// ACTUAL distinct items sold in that window — grounded in the real,
// inconsistently-named catalog rather than guessing item names blind — and
// decides which ones are in scope, and how to group/rank them.
const CLAUDE_API_BASE = "https://api.anthropic.com/v1/messages";

async function callClaude({ system, userText, model, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is missing");
  const res = await fetch(CLAUDE_API_BASE, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((c) => c.text || "").join("");
}

function extractJson(text, context) {
  const label = context || "Model";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`${label} did not return JSON — raw response: ${(text || "(empty)").slice(0, 400)}`);
  }
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`${label} returned invalid JSON (${err.message}) — raw: ${match[0].slice(0, 400)}`);
  }
}

function todayMelbourneStr() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Step 1: turn the free-text question into an intent (sales/labour/both) +
// shops + an absolute date range.
async function parseNaturalQuery(queryText) {
  const todayStr = todayMelbourneStr();
  const shopList = Object.entries(SHOP_INTEGRATIONS)
    .map(([slug, c]) => `${slug} = ${c.displayName}`)
    .join(", ");

  const system = `You convert a cafe owner's plain-English question into strict JSON, nothing else.
Today's date (Melbourne time) is ${todayStr}. Shops: ${shopList}.
Respond with ONLY the raw JSON object below — no markdown code fences, no explanation before or after it.
{"intent": "sales" or "labour" or "both", "shops": ["slug", ...] or "all", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "restated_question": "one short plain-English sentence restating what is being asked and over what period"}
Rules: "intent" is "sales" for questions about what sold, revenue, items, drinks, food; "labour" for questions about hours worked, staff, employees, shifts, wages, rostering, labour cost; "both" only if the question genuinely asks about both together (e.g. comparing sales to labour cost). Resolve relative dates ("past 30 days", "last quarter", "this month", "today") into absolute dates, ending no later than today (${todayStr}); default a vague/relative range to end yesterday instead of today, since today's trading/shifts may be incomplete, UNLESS the question explicitly says "today". If no shop is named, or "all shops"/"across all shops" is said, use "all"; if a shop is named, use only its slug(s) from the list above.`;

  const text = await callClaude({ system, userText: queryText, model: "claude-haiku-5-5", maxTokens: 400 });
  const parsed = extractJson(text, "parseNaturalQuery");

  const allSlugs = Object.keys(SHOP_INTEGRATIONS);
  let shops =
    parsed.shops === "all" || !Array.isArray(parsed.shops)
      ? allSlugs
      : parsed.shops.filter((s) => allSlugs.includes(s));
  if (shops.length === 0) shops = allSlugs;

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed.start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed.end) ||
    parsed.start > parsed.end
  ) {
    throw new Error("Could not resolve a valid date range from the question");
  }

  const intent = ["sales", "labour", "both"].includes(parsed.intent) ? parsed.intent : "sales";

  return {
    intent,
    shops,
    start: parsed.start,
    end: parsed.end,
    restatedQuestion: parsed.restated_question || queryText,
  };
}

// Pull every distinct name+variation sold by each shop in the window, with
// qty/revenue totals — the real, as-sold catalog, not a guessed item list.
async function fetchDistinctItemsForShops(shopSlugs, startDateStr, endDateStr) {
  const { startUtc } = melbourneDayRangeUtc(startDateStr);
  const { endUtc } = melbourneDayRangeUtc(endDateStr);
  const errors = {};
  const perShopItems = {};

  const fetched = await Promise.all(
    shopSlugs.map(async (slug) => {
      const config = SHOP_INTEGRATIONS[slug];
      if (!config) return { slug, orders: null };
      if (!process.env[config.squareTokenEnvVar]) return { slug, orders: null, error: "Square not connected" };
      try {
        const orders = await fetchSquareOrders(config.squareTokenEnvVar, config.squareLocationId, startUtc, endUtc);
        return { slug, orders };
      } catch (err) {
        return { slug, orders: null, error: err.message };
      }
    })
  );

  for (const { slug, orders, error } of fetched) {
    const config = SHOP_INTEGRATIONS[slug];
    if (!config) continue;
    if (error) {
      errors[slug] = error;
      continue;
    }
    const rowsByKey = {};
    for (const order of orders) {
      for (const li of order.line_items || []) {
        const key = `${li.name || ""}|${li.variation_name || ""}`;
        const revenue = (li.total_money?.amount || 0) / 100;
        const qty = Number(li.quantity) || 0;
        if (!rowsByKey[key]) {
          rowsByKey[key] = { name: (li.name || "").trim(), variation: li.variation_name || "", qty: 0, revenue: 0 };
        }
        rowsByKey[key].qty += qty;
        rowsByKey[key].revenue += revenue;
      }
    }
    perShopItems[slug] = Object.values(rowsByKey).sort((a, b) => b.qty - a.qty);
  }

  return { perShopItems, errors };
}

// Step 2: show Claude the real, as-sold item list and the original
// question, and have it decide which items match, and how to group/rank.
async function classifySalesItems(queryText, perShopItems) {
  const catalogLines = [];
  for (const [slug, rows] of Object.entries(perShopItems)) {
    for (const r of rows) {
      catalogLines.push(`${slug}|${r.name}|${r.variation}|qty=${r.qty}|revenue=${r.revenue.toFixed(2)}`);
    }
  }

  const system = `You are matching a cafe owner's sales question against the ACTUAL items sold, so you can tell code which rows are relevant and how to group them. The owner's question: "${queryText}"
Each catalog line below is: shop_slug|item name|variation|qty=total sold|revenue=total $ in the period already asked about. Item naming is inconsistent between shops (e.g. "Golden Crunch" vs "Iced Golden Crunch", "M&M" vs "MnM") — use judgement.
Return ONLY this JSON shape:
{
  "group_dimension_label": "short label for what 'group' means below, e.g. Flavour, Drink, Category, Item",
  "rank": true or false (true only if the question explicitly asks for ranking/ordering by highest-to-lowest or similar),
  "rank_by": "qty" or "revenue",
  "rank_order": "desc" or "asc",
  "matched": [{"shop": "slug", "name": "exact item name from the line", "variation": "exact variation from the line (or empty string)", "group": "the canonical label this row belongs under"}],
  "note": "short caveat if any naming was ambiguous, else null"
}
Only include rows in "matched" that genuinely belong in scope for the question — leave out everything else (e.g. unrelated hot drinks, retail items, if the question is about a narrower category). Always assign a "group" even if grouping wasn't explicitly asked for — use the canonical product name in that case (e.g. normalize "Golden Crunch" and "Iced Golden Crunch" to the same group if they are the same drink).
Respond with ONLY the raw JSON object — no markdown code fences, no explanation before or after it.`;

  const text = await callClaude({
    system,
    userText: catalogLines.join("\n") || "(no sales rows in this period)",
    model: "claude-sonnet-5-5",
    maxTokens: 8000,
  });
  const parsed = extractJson(text, "classifySalesItems");
  return {
    groupDimensionLabel: parsed.group_dimension_label || "Item",
    rank: Boolean(parsed.rank),
    rankBy: parsed.rank_by === "revenue" ? "revenue" : "qty",
    rankOrder: parsed.rank_order === "asc" ? "asc" : "desc",
    matched: Array.isArray(parsed.matched) ? parsed.matched : [],
    note: parsed.note || null,
  };
}

async function buildSalesSearchPart(queryText, parse) {
  const { perShopItems, errors } = await fetchDistinctItemsForShops(parse.shops, parse.start, parse.end);
  const classification = await classifySalesItems(queryText, perShopItems);

  // Join the matched rows back to their real qty/revenue, grouped by the
  // label Claude assigned.
  const groups = {};
  for (const m of classification.matched) {
    const rows = perShopItems[m.shop] || [];
    const row = rows.find((r) => r.name === m.name && (r.variation || "") === (m.variation || ""));
    if (!row) continue;
    const groupKey = m.group || m.name;
    if (!groups[groupKey]) groups[groupKey] = { label: groupKey, totalQty: 0, totalRevenue: 0, perShop: {} };
    groups[groupKey].totalQty += row.qty;
    groups[groupKey].totalRevenue += row.revenue;
    if (!groups[groupKey].perShop[m.shop]) {
      groups[groupKey].perShop[m.shop] = {
        shopName: (SHOP_INTEGRATIONS[m.shop] || {}).displayName || m.shop,
        qty: 0,
        revenue: 0,
      };
    }
    groups[groupKey].perShop[m.shop].qty += row.qty;
    groups[groupKey].perShop[m.shop].revenue += row.revenue;
  }

  let groupList = Object.values(groups);
  if (classification.rank) {
    const field = classification.rankBy === "revenue" ? "totalRevenue" : "totalQty";
    groupList.sort((a, b) => (classification.rankOrder === "asc" ? a[field] - b[field] : b[field] - a[field]));
  } else {
    groupList.sort((a, b) => b.totalQty - a.totalQty);
  }

  return {
    groupDimensionLabel: classification.groupDimensionLabel,
    ranked: classification.rank,
    note: classification.note,
    groups: groupList,
    errors,
  };
}

function formatSalesPart(sales) {
  const lines = [`SALES`, ``];

  for (const [slug, msg] of Object.entries(sales.errors)) lines.push(`(${slug}: ${msg})`);
  if (Object.keys(sales.errors).length) lines.push(``);

  if (sales.note) lines.push(`Note: ${sales.note}`, ``);

  if (sales.groups.length === 0) {
    lines.push(`No matching sales found for this question in that period.`);
  } else {
    let grandQty = 0;
    let grandRevenue = 0;
    sales.groups.forEach((g, i) => {
      grandQty += g.totalQty;
      grandRevenue += g.totalRevenue;
      const rank = sales.ranked ? `${i + 1}. ` : ``;
      lines.push(`${rank}${g.label} — ${g.totalQty} sold — ${money(g.totalRevenue)}`);
      for (const bucket of Object.values(g.perShop)) {
        lines.push(`    ${bucket.shopName}: ${bucket.qty} — ${money(bucket.revenue)}`);
      }
      lines.push(``);
    });
    lines.push(`Grand total: ${grandQty} sold — ${money(grandRevenue)}`);
  }

  return lines.join("\n");
}

// ---- Labour side of natural-language search --------------------------
// Tanda is one org covering every shop (just different department_ids per
// location), and /shifts and /users return the whole org in one call —
// much cheaper than the sales side's per-shop Square pagination.
async function fetchTandaUsers() {
  const res = await fetch(`${TANDA_API_BASE}/users`, { headers: tandaHeaders() });
  if (!res.ok) throw new Error(`Tanda users failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchTandaShiftsRange(startDateStr, endDateStr) {
  const res = await fetch(`${TANDA_API_BASE}/shifts?from=${startDateStr}&to=${endDateStr}`, {
    headers: tandaHeaders(),
  });
  if (!res.ok) throw new Error(`Tanda shifts failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Hours worked for one shift, minus its recorded break. A still-open shift
// (no finish time) is only valid for TODAY (still clocked in) — an older
// shift with no finish is an unrecorded clock-out, not real data, so it is
// excluded rather than guessed at.
function shiftHours(shift, actualTodayStr, now) {
  if (!shift.start) return 0;
  const start = new Date(shift.start * 1000);
  let finish;
  if (shift.finish) {
    finish = new Date(shift.finish * 1000);
  } else if (shift.date === actualTodayStr) {
    finish = now;
  } else {
    return null;
  }
  if (finish <= start) return 0;
  const breakHours = (Number(shift.break_length) || 0) / 60;
  return Math.max((finish - start) / 3600000 - breakHours, 0);
}

async function fetchLabourDataForShops(shopSlugs, startDateStr, endDateStr) {
  const actualTodayStr = todayMelbourneStr();
  const now = new Date();
  const errors = {};

  const deptSets = {};
  for (const slug of shopSlugs) {
    const config = SHOP_INTEGRATIONS[slug];
    if (!config) continue;
    if (!process.env.TANDA_ACCESS_TOKEN) {
      errors[slug] = "Tanda not connected";
      continue;
    }
    try {
      deptSets[slug] = await fetchTandaDepartmentIds(config.tandaLocationId);
    } catch (err) {
      errors[slug] = err.message;
    }
  }

  let shifts = [];
  let users = [];
  try {
    [shifts, users] = await Promise.all([fetchTandaShiftsRange(startDateStr, endDateStr), fetchTandaUsers()]);
  } catch (err) {
    errors["_fetch"] = err.message;
  }

  const userNames = {};
  for (const u of users) userNames[u.id] = (u.name || "").trim() || `Employee #${u.id}`;

  const rows = [];
  let incompleteCount = 0;
  for (const shift of shifts) {
    for (const [slug, deptIds] of Object.entries(deptSets)) {
      if (!deptIds.has(shift.department_id)) continue;
      const hours = shiftHours(shift, actualTodayStr, now);
      if (hours === null) {
        incompleteCount++;
        continue;
      }
      rows.push({
        shopSlug: slug,
        shopName: SHOP_INTEGRATIONS[slug].displayName,
        userId: shift.user_id,
        userName: userNames[shift.user_id] || `Employee #${shift.user_id}`,
        date: shift.date,
        hours,
      });
    }
  }

  // Tanda's live wage tracker only ever reports TODAY's cumulative $ cost,
  // shop-level only (never a past date, never per employee) — so $ cost is
  // only ever included when the requested range covers today.
  const costToday = {};
  if (startDateStr <= actualTodayStr && actualTodayStr <= endDateStr) {
    await Promise.all(
      shopSlugs.map(async (slug) => {
        const config = SHOP_INTEGRATIONS[slug];
        if (!config || !process.env.TANDA_ACCESS_TOKEN) return;
        try {
          costToday[slug] = await fetchTandaLiveLabourCost(config.tandaLocationId);
        } catch (err) {
          // Hours are still useful without today's $ cost — not fatal.
        }
      })
    );
  }

  const rosterIds = new Set(rows.map((r) => String(r.userId)));
  const roster = Object.entries(userNames)
    .filter(([id]) => rosterIds.has(String(id)))
    .map(([id, name]) => ({ id, name }));

  return { rows, roster, costToday, incompleteCount, errors };
}

// Step 2 (labour): show Claude the real roster of people who actually
// worked in the period, and have it resolve any named person against it
// and decide how to group/rank — the hour math itself stays in code.
async function classifyLabourQuery(queryText, roster) {
  const rosterLines = roster.map((r) => `${r.id}|${r.name}`).join("\n");

  const system = `You are helping interpret a cafe owner's labour/staffing question: "${queryText}"
Below is the roster of employees who actually worked in the period already resolved for this question: id|name.
Return ONLY this JSON shape:
{
  "group_by": "employee" or "day" or "shop" or "none",
  "rank": true or false (true only if explicitly asked to rank/order by most/least/highest/lowest),
  "rank_order": "desc" or "asc",
  "employee_filter_ids": ["id", ...] (ids of employees the question specifically names, matched by name even with a slightly different spelling — empty array if the question is about everyone, not a specific person),
  "note": "short caveat if any name was ambiguous, else null"
}
Respond with ONLY the raw JSON object — no markdown code fences, no explanation before or after it.`;

  const text = await callClaude({
    system,
    userText: rosterLines || "(no one worked in this period)",
    model: "claude-haiku-5-5",
    maxTokens: 800,
  });
  const parsed = extractJson(text, "classifyLabourQuery");
  return {
    groupBy: ["employee", "day", "shop"].includes(parsed.group_by) ? parsed.group_by : "none",
    rank: Boolean(parsed.rank),
    rankOrder: parsed.rank_order === "asc" ? "asc" : "desc",
    employeeFilterIds: Array.isArray(parsed.employee_filter_ids) ? parsed.employee_filter_ids.map(String) : [],
    note: parsed.note || null,
  };
}

async function buildLabourSearchPart(queryText, parse) {
  const { rows, roster, costToday, incompleteCount, errors } = await fetchLabourDataForShops(
    parse.shops,
    parse.start,
    parse.end
  );
  const classification = await classifyLabourQuery(queryText, roster);

  let filteredRows = rows;
  if (classification.employeeFilterIds.length) {
    const idSet = new Set(classification.employeeFilterIds);
    filteredRows = rows.filter((r) => idSet.has(String(r.userId)));
  }

  const keyFor = (r) => {
    if (classification.groupBy === "employee") return r.userName;
    if (classification.groupBy === "day") return r.date;
    if (classification.groupBy === "shop") return r.shopName;
    return "Total";
  };

  const groups = {};
  for (const r of filteredRows) {
    const key = keyFor(r);
    if (!groups[key]) groups[key] = { label: key, totalHours: 0 };
    groups[key].totalHours += r.hours;
  }

  let groupList = Object.values(groups);
  if (classification.rank) {
    groupList.sort((a, b) =>
      classification.rankOrder === "asc" ? a.totalHours - b.totalHours : b.totalHours - a.totalHours
    );
  } else {
    groupList.sort((a, b) => b.totalHours - a.totalHours);
  }

  return { ranked: classification.rank, note: classification.note, groups: groupList, costToday, incompleteCount, errors };
}

function formatLabourPart(labour) {
  const lines = [`LABOUR`, ``];

  for (const [slug, msg] of Object.entries(labour.errors)) lines.push(`(${slug}: ${msg})`);
  if (Object.keys(labour.errors).length) lines.push(``);

  if (labour.incompleteCount) {
    lines.push(
      `(${labour.incompleteCount} past shift(s) had no clock-out recorded in Tanda — excluded from hours.)`,
      ``
    );
  }
  if (labour.note) lines.push(`Note: ${labour.note}`, ``);

  if (labour.groups.length === 0) {
    lines.push(`No matching labour hours found for this question in that period.`);
  } else {
    let grandHours = 0;
    labour.groups.forEach((g, i) => {
      grandHours += g.totalHours;
      const rank = labour.ranked ? `${i + 1}. ` : ``;
      lines.push(`${rank}${g.label} — ${g.totalHours.toFixed(2)} hrs`);
    });
    lines.push(``, `Total: ${grandHours.toFixed(2)} hrs`);
  }

  const costEntries = Object.entries(labour.costToday);
  if (costEntries.length) {
    lines.push(
      ``,
      `Labour $ cost for TODAY only (Tanda only ever reports live cost for the current day, never a past date):`
    );
    for (const [slug, cost] of costEntries) {
      lines.push(`  ${(SHOP_INTEGRATIONS[slug] || {}).displayName || slug}: ${money(cost)}`);
    }
  }

  return lines.join("\n");
}

// Single entry point for the free-text search box — resolves intent once,
// then runs the sales and/or labour pipeline(s) it calls for.
async function buildNaturalSearch(queryText) {
  const parse = await parseNaturalQuery(queryText);
  const result = {
    queryText,
    restatedQuestion: parse.restatedQuestion,
    start: parse.start,
    end: parse.end,
  };

  if (parse.intent === "labour") {
    result.labour = await buildLabourSearchPart(queryText, parse);
  } else if (parse.intent === "sales") {
    result.sales = await buildSalesSearchPart(queryText, parse);
  } else {
    const [sales, labour] = await Promise.all([
      buildSalesSearchPart(queryText, parse),
      buildLabourSearchPart(queryText, parse),
    ]);
    result.sales = sales;
    result.labour = labour;
  }

  return result;
}

function formatNaturalSearchEmail(result) {
  const lines = [
    `Search — "${result.queryText}"`,
    result.restatedQuestion,
    `Period: ${result.start} to ${result.end}`,
    ``,
  ];

  if (result.sales) lines.push(formatSalesPart(result.sales), ``);
  if (result.labour) lines.push(formatLabourPart(result.labour));

  return {
    subject: `Search — ${result.restatedQuestion}`.slice(0, 200),
    text: lines.join("\n"),
  };
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
    `  Total net sales: ${money(report.netSales)}${
      report.otherRevenue ? ` (includes ${money(report.otherRevenue)} off-platform: ${report.otherRevenueNote})` : ""
    }`,
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

module.exports = {
  SHOP_INTEGRATIONS,
  buildDailyShopReport,
  formatDailyReportEmail,
  buildCookieSalesReport,
  buildItemSalesSearch,
  formatSalesSearchEmail,
  buildNaturalSearch,
  formatNaturalSearchEmail,
};
