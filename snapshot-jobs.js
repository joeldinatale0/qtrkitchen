// Permanent nightly Square/Tanda data store. Every night, pulls YESTERDAY's
// real data for each connected shop and saves it to square_*/tanda_* tables
// (see db.js) — never overwritten by date, kept forever. Reporting over any
// PAST date range should read from these tables; only "today" needs a live
// Square/Tanda call (see the read* functions below, and how they're used
// from mcp-server.js).
//
// shop_slug throughout this file is the REPORTING slug (essendon, highpoint,
// quartertwo — see SHOP_INTEGRATIONS), not the ordering-side slug
// (mooneeponds for Quarter Two) — this file never touches the
// ordering/invoices tables, so there's nothing to translate here.
const {
  SHOP_INTEGRATIONS,
  melbourneDayRangeUtc,
  melbourneHourOf,
  hourBucketsUtc,
  fetchSquareOrders,
  fetchSquareRefunds,
  fetchTandaDepartmentIds,
  fetchTandaShifts,
  fetchTandaUsers,
  todayMelbourneStr,
} = require("./shop-reports");

// Australian super guarantee rate, FY2025-26 — Tanda's own cost/cost_breakdown
// fields are wage cost only (confirmed against real shift data: {award_cost,
// allowance_cost}, no super field), so this is added on top here. Update
// this if the legislated rate changes.
const SUPER_GUARANTEE_RATE = 0.115;

const REPORTING_SHOP_SLUGS = Object.keys(SHOP_INTEGRATIONS); // essendon, highpoint, quartertwo

function addDaysISO(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// ---------- Snapshot writers ----------

async function snapshotSquareDay(db, shopSlug, dateStr, isBackfill) {
  const config = SHOP_INTEGRATIONS[shopSlug];
  if (!config) throw new Error(`No Square integration for ${shopSlug}`);
  if (!process.env[config.squareTokenEnvVar]) throw new Error(`${config.squareTokenEnvVar} is missing`);

  const { startUtc, endUtc } = melbourneDayRangeUtc(dateStr);
  const [orders, refunds] = await Promise.all([
    fetchSquareOrders(config.squareTokenEnvVar, config.squareLocationId, startUtc, endUtc),
    fetchSquareRefunds(config.squareTokenEnvVar, config.squareLocationId, startUtc.toISOString(), endUtc.toISOString()),
  ]);

  let netSalesCents = 0;
  let discountsCents = 0;
  const itemMap = {};
  const hourMap = {};
  const discountMap = {};

  for (const order of orders) {
    const totalCents = order.total_money?.amount || 0;
    const discCents = order.total_discount_money?.amount || 0;
    netSalesCents += totalCents;
    discountsCents += discCents;

    const hour = melbourneHourOf(new Date(order.created_at));
    if (!hourMap[hour]) hourMap[hour] = { salesCents: 0, count: 0 };
    hourMap[hour].salesCents += totalCents;
    hourMap[hour].count += 1;

    for (const d of order.discounts || []) {
      const name = d.name || "(unnamed)";
      discountMap[name] = (discountMap[name] || 0) + (d.applied_money?.amount || 0);
    }
    for (const li of order.line_items || []) {
      const key = `${(li.name || "").trim()}|${li.variation_name || ""}`;
      if (!itemMap[key]) {
        itemMap[key] = { name: (li.name || "").trim(), variation: li.variation_name || "", qty: 0, revenueCents: 0 };
      }
      itemMap[key].qty += Number(li.quantity) || 0;
      itemMap[key].revenueCents += li.total_money?.amount || 0;
    }
  }
  const refundsCents = refunds.reduce((s, r) => s + (r.amount_money?.amount || 0), 0);
  // Gross = what it would have been without any discount (Net + Discounts) —
  // the cafe-owner-intuitive meaning, not Square's own line-item
  // gross_sales_money field (which, confirmed against a real order, already
  // has discounts netted out despite the name).
  const grossSalesCents = netSalesCents + discountsCents;

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM square_daily_totals WHERE shop_slug = ? AND date = ?").run(shopSlug, dateStr);
    db.prepare(
      `INSERT INTO square_daily_totals
         (shop_slug, date, gross_sales_cents, net_sales_cents, discounts_cents, refunds_cents, transaction_count, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(shopSlug, dateStr, grossSalesCents, netSalesCents, discountsCents, refundsCents, orders.length, isBackfill ? "backfilled" : "live");

    db.prepare("DELETE FROM square_item_sales WHERE shop_slug = ? AND date = ?").run(shopSlug, dateStr);
    const insertItem = db.prepare(
      "INSERT INTO square_item_sales (shop_slug, date, item_name, variation_name, quantity, net_revenue_cents) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const it of Object.values(itemMap)) insertItem.run(shopSlug, dateStr, it.name, it.variation, it.qty, it.revenueCents);

    db.prepare("DELETE FROM square_hourly_sales WHERE shop_slug = ? AND date = ?").run(shopSlug, dateStr);
    const insertHour = db.prepare(
      "INSERT INTO square_hourly_sales (shop_slug, date, hour, net_sales_cents, transaction_count) VALUES (?, ?, ?, ?, ?)"
    );
    for (const [hour, s] of Object.entries(hourMap)) insertHour.run(shopSlug, dateStr, Number(hour), s.salesCents, s.count);

    db.prepare("DELETE FROM square_discounts WHERE shop_slug = ? AND date = ?").run(shopSlug, dateStr);
    const insertDisc = db.prepare("INSERT INTO square_discounts (shop_slug, date, discount_name, amount_cents) VALUES (?, ?, ?, ?)");
    for (const [name, amt] of Object.entries(discountMap)) insertDisc.run(shopSlug, dateStr, name, amt);
  });
  tx();
}

function getSalariedRatesByUserId(db) {
  const rows = db.prepare("SELECT tanda_user_id, daily_salary_cents FROM salaried_staff_rates").all();
  const map = {};
  for (const r of rows) map[r.tanda_user_id] = r.daily_salary_cents;
  return map;
}

async function snapshotTandaDay(db, shopSlug, dateStr, isBackfill) {
  const config = SHOP_INTEGRATIONS[shopSlug];
  if (!config) throw new Error(`No Tanda integration for ${shopSlug}`);
  if (!process.env.TANDA_ACCESS_TOKEN) throw new Error("TANDA_ACCESS_TOKEN is missing");

  const [deptIds, allShifts, users] = await Promise.all([
    fetchTandaDepartmentIds(config.tandaLocationId),
    fetchTandaShifts(dateStr),
    fetchTandaUsers(),
  ]);
  const userNames = {};
  users.forEach((u) => (userNames[u.id] = (u.name || "").trim() || `Employee #${u.id}`));
  const salariedRates = getSalariedRatesByUserId(db);

  const buckets = hourBucketsUtc(dateStr);
  let missingCostShifts = 0; // has a finish time, but Tanda still gave no cost
  let noClockOutCount = 0; // no finish time at all
  const hourlyMap = {};
  const shiftRows = [];
  const hoursByUser = {}; // for the salaried-override pass below

  for (const shift of allShifts) {
    if (!deptIds.has(shift.department_id)) continue;
    const userName = userNames[shift.user_id] || `Employee #${shift.user_id}`;

    if (!shift.start || !shift.finish) {
      // No clock-out — saved (not dropped) so it can be named, not just
      // counted. Can't compute hours/cost without a finish time.
      noClockOutCount++;
      shiftRows.push({
        userId: shift.user_id,
        userName,
        start: shift.start || null,
        finish: null,
        hours: null,
        breakMinutes: Number(shift.break_length) || 0,
        costCents: null,
        costSource: "missing",
        status: shift.status || null,
        noClockOut: 1,
      });
      continue;
    }

    const hours = Math.max((shift.finish - shift.start) / 3600 - (Number(shift.break_length) || 0) / 60, 0);
    if (hours <= 0) continue;
    const hasCost = typeof shift.cost === "number";
    const costCents = hasCost ? Math.round(shift.cost * 100) : null;
    if (!hasCost) missingCostShifts++;

    hoursByUser[shift.user_id] = (hoursByUser[shift.user_id] || 0) + hours;

    shiftRows.push({
      userId: shift.user_id,
      userName,
      start: shift.start,
      finish: shift.finish,
      hours,
      breakMinutes: Number(shift.break_length) || 0,
      costCents,
      costSource: hasCost ? "tanda" : "missing",
      status: shift.status || null,
      noClockOut: 0,
    });

    if (hasCost) {
      // Worked intervals only — excludes break windows in the middle of the
      // shift, same approach as this codebase's existing summarizeTandaShifts
      // (shop-reports.js). Without this, a shift's break time still gets
      // counted as worked when distributed into hour buckets, so the hourly
      // sum comes out higher than the shift's own (break-adjusted) total.
      const startDate = new Date(shift.start * 1000);
      const finishDate = new Date(shift.finish * 1000);
      const shiftBreaks = (shift.breaks || []).filter((b) => b.start && b.finish).sort((a, b) => a.start - b.start);
      const intervals = [];
      let cursor = startDate;
      for (const br of shiftBreaks) {
        const bStart = new Date(br.start * 1000);
        const bFinish = new Date(br.finish * 1000);
        if (bStart > cursor) intervals.push([cursor, bStart < finishDate ? bStart : finishDate]);
        if (bFinish > cursor) cursor = bFinish;
      }
      if (cursor < finishDate) intervals.push([cursor, finishDate]);

      for (const [ws, wf] of intervals) {
        for (const b of buckets) {
          const overlapStart = ws > b.start ? ws : b.start;
          const overlapEnd = wf < b.end ? wf : b.end;
          const hrs = (overlapEnd - overlapStart) / 3600000;
          if (hrs > 0) {
            if (!hourlyMap[b.hour]) hourlyMap[b.hour] = { hours: 0, costCents: 0 };
            hourlyMap[b.hour].hours += hrs;
            hourlyMap[b.hour].costCents += costCents * (hrs / hours);
          }
        }
      }
    }
  }

  // Salaried override: replace this person's Tanda-costed shift(s) for the
  // day with their flat daily rate instead — applies once per person per
  // day, regardless of how many shifts they have that day. Hours are left
  // as Tanda reported them (still useful to know how long they were there);
  // only the $ cost is overridden.
  for (const s of shiftRows) {
    if (s.noClockOut) continue;
    const rate = salariedRates[s.userId];
    if (rate === undefined) continue;
    if (s.costSource === "salaried") continue; // already applied to this user's first shift today
    const alreadyApplied = shiftRows.some((other) => other !== s && other.userId === s.userId && other.costSource === "salaried");
    if (alreadyApplied) {
      s.costCents = 0; // the day's salary is carried on the first shift only, so totals aren't double-counted
      s.costSource = "salaried";
    } else {
      s.costCents = rate;
      s.costSource = "salaried";
    }
  }

  const totalHours = shiftRows.reduce((sum, s) => sum + (s.hours || 0), 0);
  const totalCostCents = shiftRows.reduce((sum, s) => sum + (s.costCents || 0), 0);
  const totalCostWithSuperCents = Math.round(totalCostCents * (1 + SUPER_GUARANTEE_RATE));

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM tanda_shifts WHERE shop_slug = ? AND date = ?").run(shopSlug, dateStr);
    const insertShift = db.prepare(
      `INSERT INTO tanda_shifts
         (shop_slug, date, tanda_user_id, user_name, start_ts, finish_ts, hours, break_minutes, cost_cents, cost_source, status, no_clock_out)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of shiftRows) {
      insertShift.run(shopSlug, dateStr, s.userId, s.userName, s.start, s.finish, s.hours, s.breakMinutes, s.costCents, s.costSource, s.status, s.noClockOut);
    }

    db.prepare("DELETE FROM tanda_daily_labour WHERE shop_slug = ? AND date = ?").run(shopSlug, dateStr);
    db.prepare(
      `INSERT INTO tanda_daily_labour
         (shop_slug, date, total_hours, total_cost_cents, total_cost_with_super_cents, missing_cost_shifts, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(shopSlug, dateStr, totalHours, totalCostCents, totalCostWithSuperCents, missingCostShifts, isBackfill ? "backfilled" : "live");

    db.prepare("DELETE FROM tanda_hourly_labour WHERE shop_slug = ? AND date = ?").run(shopSlug, dateStr);
    const insertHourly = db.prepare("INSERT INTO tanda_hourly_labour (shop_slug, date, hour, hours, cost_cents) VALUES (?, ?, ?, ?, ?)");
    for (const [hour, v] of Object.entries(hourlyMap)) insertHourly.run(shopSlug, dateStr, Number(hour), v.hours, Math.round(v.costCents));
  });
  tx();

  return { noClockOutCount, missingCostShifts };
}

async function snapshotShopDay(db, shopSlug, dateStr, { isBackfill = false } = {}) {
  let squareStatus = "ok";
  let tandaStatus = "ok";
  const errors = [];

  try {
    await snapshotSquareDay(db, shopSlug, dateStr, isBackfill);
  } catch (err) {
    squareStatus = "failed";
    errors.push(`Square: ${err.message}`);
  }

  try {
    await snapshotTandaDay(db, shopSlug, dateStr, isBackfill);
  } catch (err) {
    tandaStatus = "failed";
    errors.push(`Tanda: ${err.message}`);
  }

  const existing = db.prepare("SELECT retry_count FROM nightly_snapshot_log WHERE shop_slug = ? AND date = ?").get(shopSlug, dateStr);
  db.prepare(
    `INSERT INTO nightly_snapshot_log (shop_slug, date, square_status, tanda_status, error_message, retry_count, is_backfilled, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(shop_slug, date) DO UPDATE SET
       square_status = excluded.square_status,
       tanda_status = excluded.tanda_status,
       error_message = excluded.error_message,
       retry_count = nightly_snapshot_log.retry_count + 1,
       is_backfilled = excluded.is_backfilled,
       attempted_at = CURRENT_TIMESTAMP`
  ).run(shopSlug, dateStr, squareStatus, tandaStatus, errors.join("; ") || null, existing ? existing.retry_count : 0, isBackfill ? 1 : 0);

  return { squareStatus, tandaStatus, errors };
}

// ---------- Nightly scheduler (1am Melbourne time, yesterday's data) ----------

let nightlyRunInProgress = false;
let lastRecheckDate = null; // guards the 3-day re-check to once per night

// Called from a setInterval in server.js, same pattern as this app's other
// *IfDue jobs — only actually runs work during the 1am Melbourne hour, and
// only for shops/dates not already fully saved, so calling it often is safe.
async function runNightlySnapshotIfDue(db, sendEmail, alertEmailTo) {
  const melbourneHour = Number(
    new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hourCycle: "h23", hour: "2-digit" }).format(new Date())
  );
  if (melbourneHour !== 1) return;
  if (nightlyRunInProgress) return;

  const todayStr = todayMelbourneStr();
  const yesterday = addDaysISO(todayStr, -1);
  const allDone = REPORTING_SHOP_SLUGS.every((slug) => {
    const row = db.prepare("SELECT square_status, tanda_status FROM nightly_snapshot_log WHERE shop_slug = ? AND date = ?").get(slug, yesterday);
    return row && row.square_status === "ok" && row.tanda_status === "ok";
  });

  nightlyRunInProgress = true;
  try {
    if (!allDone) {
      for (const slug of REPORTING_SHOP_SLUGS) {
        const row = db
          .prepare("SELECT square_status, tanda_status, retry_count FROM nightly_snapshot_log WHERE shop_slug = ? AND date = ?")
          .get(slug, yesterday);
        if (row && row.square_status === "ok" && row.tanda_status === "ok") continue;
        if (row && row.retry_count >= 5) continue; // stop retrying tonight — already alerted below on attempt 3

        const result = await snapshotShopDay(db, slug, yesterday, { isBackfill: false });
        if (result.squareStatus === "failed" || result.tandaStatus === "failed") {
          const updated = db
            .prepare("SELECT retry_count, alert_sent FROM nightly_snapshot_log WHERE shop_slug = ? AND date = ?")
            .get(slug, yesterday);
          if (updated && updated.retry_count >= 2 && !updated.alert_sent && sendEmail) {
            try {
              await sendEmail({
                to: alertEmailTo,
                subject: `Nightly snapshot failed — ${slug} — ${yesterday}`,
                text: `The nightly Square/Tanda snapshot for ${slug} on ${yesterday} has failed ${updated.retry_count} time(s).\n\n${result.errors.join("\n")}\n\nCheck /kitchen/admin/data-health.`,
              });
              db.prepare("UPDATE nightly_snapshot_log SET alert_sent = 1 WHERE shop_slug = ? AND date = ?").run(slug, yesterday);
            } catch (err) {
              console.error("Failed to send snapshot failure alert:", err.message);
            }
          }
        }
      }
    }

    // Tanda timesheets can be approved or edited a day or two after the
    // fact — re-pulling just yesterday once, the night after, isn't enough
    // to catch that. Re-check the last 3 days every night (once per night,
    // guarded by lastRecheckDate) and alert if a re-pull actually changes
    // the saved hours/cost for a day thought to be final.
    if (lastRecheckDate !== todayStr) {
      for (let i = 1; i <= 3; i++) {
        const dateStr = addDaysISO(todayStr, -i);
        for (const slug of REPORTING_SHOP_SLUGS) {
          const before = db.prepare("SELECT total_hours, total_cost_cents FROM tanda_daily_labour WHERE shop_slug = ? AND date = ?").get(slug, dateStr);
          let result;
          try {
            result = await snapshotShopDay(db, slug, dateStr, { isBackfill: false });
          } catch (err) {
            console.error(`Nightly 3-day re-check failed for ${slug} ${dateStr}:`, err.message);
            continue;
          }
          if (result.tandaStatus === "failed") {
            console.error(`Nightly 3-day re-check failed for ${slug} ${dateStr}: ${result.errors.join("; ")}`);
            continue;
          }
          const after = db.prepare("SELECT total_hours, total_cost_cents FROM tanda_daily_labour WHERE shop_slug = ? AND date = ?").get(slug, dateStr);
          if (before && after && (Math.abs(before.total_hours - after.total_hours) > 0.01 || before.total_cost_cents !== after.total_cost_cents)) {
            console.log(`Labour re-check changed ${slug} ${dateStr}: ${before.total_hours.toFixed(2)}hrs/$${(before.total_cost_cents / 100).toFixed(2)} -> ${after.total_hours.toFixed(2)}hrs/$${(after.total_cost_cents / 100).toFixed(2)}`);
            if (sendEmail) {
              try {
                await sendEmail({
                  to: alertEmailTo,
                  subject: `Labour data changed on re-check — ${slug} — ${dateStr}`,
                  text: `Tanda's data for ${dateStr} (${slug}) changed since it was first saved — likely a late approval or edit.\n\nBefore: ${before.total_hours.toFixed(2)} hrs, $${(before.total_cost_cents / 100).toFixed(2)}\nAfter: ${after.total_hours.toFixed(2)} hrs, $${(after.total_cost_cents / 100).toFixed(2)}`,
                });
              } catch (err) {
                console.error("Failed to send re-check change alert:", err.message);
              }
            }
          }
        }
      }
      lastRecheckDate = todayStr;
    }
  } finally {
    nightlyRunInProgress = false;
  }
}

// ---------- Backfill (one-off, 30 days by default, one day at a time) ----------

let backfillInProgress = false;
let backfillProgress = null;

function runBackfill(db, days = 30) {
  if (backfillInProgress) return { started: false, alreadyRunning: true };
  backfillInProgress = true;
  const todayStr = todayMelbourneStr();
  backfillProgress = { total: days * REPORTING_SHOP_SLUGS.length, done: 0, startedAt: new Date().toISOString(), finishedAt: null, errors: [] };

  // Runs after this function returns — the triggering HTTP request doesn't
  // wait for it, since 30 days x 3 shops of Square+Tanda calls would exceed
  // any reasonable request timeout. Progress is polled via getBackfillStatus.
  (async () => {
    try {
      for (let i = 1; i <= days; i++) {
        const dateStr = addDaysISO(todayStr, -i);
        for (const slug of REPORTING_SHOP_SLUGS) {
          try {
            await snapshotShopDay(db, slug, dateStr, { isBackfill: true });
          } catch (err) {
            backfillProgress.errors.push(`${slug} ${dateStr}: ${err.message}`);
          }
          backfillProgress.done++;
        }
      }
    } finally {
      backfillInProgress = false;
      backfillProgress.finishedAt = new Date().toISOString();
    }
  })();

  return { started: true };
}

function getBackfillStatus() {
  return { inProgress: backfillInProgress, progress: backfillProgress };
}

// ---------- Reads (the "instant" reporting path) ----------

function readSquareDailyTotals(db, shopSlugs, start, end) {
  const placeholders = shopSlugs.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM square_daily_totals WHERE shop_slug IN (${placeholders}) AND date >= ? AND date <= ? ORDER BY date`)
    .all(...shopSlugs, start, end);
}

function readSquareItemSales(db, shopSlugs, start, end) {
  const placeholders = shopSlugs.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM square_item_sales WHERE shop_slug IN (${placeholders}) AND date >= ? AND date <= ?`)
    .all(...shopSlugs, start, end);
}

function readSquareHourlySales(db, shopSlugs, start, end) {
  const placeholders = shopSlugs.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM square_hourly_sales WHERE shop_slug IN (${placeholders}) AND date >= ? AND date <= ?`)
    .all(...shopSlugs, start, end);
}

function readSquareDiscounts(db, shopSlugs, start, end) {
  const placeholders = shopSlugs.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM square_discounts WHERE shop_slug IN (${placeholders}) AND date >= ? AND date <= ?`)
    .all(...shopSlugs, start, end);
}

function readTandaShiftsSaved(db, shopSlugs, start, end) {
  const placeholders = shopSlugs.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM tanda_shifts WHERE shop_slug IN (${placeholders}) AND date >= ? AND date <= ? ORDER BY date, start_ts`)
    .all(...shopSlugs, start, end);
}

function readTandaDailyLabour(db, shopSlugs, start, end) {
  const placeholders = shopSlugs.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM tanda_daily_labour WHERE shop_slug IN (${placeholders}) AND date >= ? AND date <= ? ORDER BY date`)
    .all(...shopSlugs, start, end);
}

function readTandaHourlyLabour(db, shopSlugs, start, end) {
  const placeholders = shopSlugs.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM tanda_hourly_labour WHERE shop_slug IN (${placeholders}) AND date >= ? AND date <= ?`)
    .all(...shopSlugs, start, end);
}

// A date range is "fully historical" (safe to read only from saved tables)
// when it doesn't include today — today must still go live, since the
// nightly job only ever saves YESTERDAY and earlier.
function isFullyHistorical(start, end) {
  return end < todayMelbourneStr();
}

// ---------- Monitoring ----------

function getDataHealth(db, daysBack = 30) {
  const todayStr = todayMelbourneStr();
  return REPORTING_SHOP_SLUGS.map((slug) => {
    const lastSquare = db.prepare("SELECT MAX(date) AS d FROM square_daily_totals WHERE shop_slug = ?").get(slug).d;
    const lastTanda = db.prepare("SELECT MAX(date) AS d FROM tanda_daily_labour WHERE shop_slug = ?").get(slug).d;
    const missingDays = [];
    for (let i = 1; i <= daysBack; i++) {
      const dateStr = addDaysISO(todayStr, -i);
      const row = db.prepare("SELECT square_status, tanda_status FROM nightly_snapshot_log WHERE shop_slug = ? AND date = ?").get(slug, dateStr);
      if (!row || row.square_status !== "ok" || row.tanda_status !== "ok") missingDays.push(dateStr);
    }
    const recentFailures = db
      .prepare(
        `SELECT * FROM nightly_snapshot_log WHERE shop_slug = ? AND (square_status = 'failed' OR tanda_status = 'failed') AND date >= ?
         ORDER BY date DESC LIMIT 30`
      )
      .all(slug, addDaysISO(todayStr, -daysBack));
    return {
      shopSlug: slug,
      displayName: SHOP_INTEGRATIONS[slug].displayName,
      lastSquareDate: lastSquare,
      lastTandaDate: lastTanda,
      missingDays,
      recentFailures,
    };
  });
}

// ---------- Salaried staff rate management ----------

function listSalariedRates(db) {
  return db.prepare("SELECT * FROM salaried_staff_rates ORDER BY user_name").all();
}

function setSalariedRate(db, tandaUserId, userName, dailySalaryCents) {
  db.prepare(
    `INSERT INTO salaried_staff_rates (tanda_user_id, user_name, daily_salary_cents) VALUES (?, ?, ?)
     ON CONFLICT(tanda_user_id) DO UPDATE SET user_name = excluded.user_name, daily_salary_cents = excluded.daily_salary_cents`
  ).run(tandaUserId, userName, dailySalaryCents);
}

function removeSalariedRate(db, tandaUserId) {
  db.prepare("DELETE FROM salaried_staff_rates WHERE tanda_user_id = ?").run(tandaUserId);
}

module.exports = {
  SUPER_GUARANTEE_RATE,
  REPORTING_SHOP_SLUGS,
  addDaysISO,
  snapshotShopDay,
  runNightlySnapshotIfDue,
  runBackfill,
  getBackfillStatus,
  readSquareDailyTotals,
  readSquareItemSales,
  readSquareHourlySales,
  readSquareDiscounts,
  readTandaShiftsSaved,
  readTandaDailyLabour,
  readTandaHourlyLabour,
  isFullyHistorical,
  getDataHealth,
  listSalariedRates,
  setSalariedRate,
  removeSalariedRate,
};
