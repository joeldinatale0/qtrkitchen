// Read-only audit comparing the saved Tanda labour snapshot (tanda_shifts /
// tanda_daily_labour / tanda_hourly_labour) against a fresh live pull from
// Tanda, for every day the snapshot store has data for. Writes NOTHING to
// the real tables — this only ever reads and reports. See snapshot-jobs.js
// for the thing being audited.
const {
  SHOP_INTEGRATIONS,
  fetchTandaDepartmentIds,
  fetchTandaShifts,
  fetchTandaUsers,
} = require("./shop-reports");

const REPORTING_SHOP_SLUGS = Object.keys(SHOP_INTEGRATIONS);

// Hours using ONLY unpaid break minutes — what Tanda's own payable-hours
// logic should mean. The snapshot job currently subtracts shift.break_length
// wholesale regardless of whether a break was paid.
function correctHours(shift) {
  if (!shift.start || !shift.finish) return null; // no clock-out — can't compute
  const unpaidBreakMinutes = (shift.breaks || []).filter((b) => b.paid === false).reduce((s, b) => s + (Number(b.length) || 0), 0);
  return Math.max((shift.finish - shift.start) / 3600 - unpaidBreakMinutes / 60, 0);
}

// What the CURRENT snapshot job computes (see snapshotTandaDay) — kept here
// so the audit can show "saved vs Tanda" using the exact same formula the
// save used, isolating genuine recompute drift from the paid-break bug.
function snapshotFormulaHours(shift) {
  if (!shift.start || !shift.finish) return null;
  return Math.max((shift.finish - shift.start) / 3600 - (Number(shift.break_length) || 0) / 60, 0);
}

let auditInProgress = false;
let auditResult = null;

function getLabourAuditStatus() {
  return { inProgress: auditInProgress, result: auditResult };
}

function runLabourAudit(db) {
  if (auditInProgress) return { started: false, alreadyRunning: true };
  auditInProgress = true;
  auditResult = { startedAt: new Date().toISOString(), finishedAt: null, datesChecked: 0, totalDates: 0, findings: [], staffNameCollisions: [], departmentOverlaps: [] };

  (async () => {
    try {
      const dates = db
        .prepare(
          `SELECT DISTINCT date FROM nightly_snapshot_log WHERE tanda_status = 'ok' AND shop_slug IN (${REPORTING_SHOP_SLUGS.map(() => "?").join(",")}) ORDER BY date`
        )
        .all(...REPORTING_SHOP_SLUGS)
        .map((r) => r.date);
      auditResult.totalDates = dates.length;

      const [allDepartments, users] = await Promise.all([
        fetch(`https://my.tanda.co/api/v2/departments`, { headers: { Authorization: `Bearer ${process.env.TANDA_ACCESS_TOKEN}` } }).then((r) => r.json()),
        fetchTandaUsers(),
      ]);
      const userNames = {};
      users.forEach((u) => (userNames[u.id] = (u.name || "").trim() || `Employee #${u.id}`));

      // Department -> shop overlap check (once, not per day).
      const deptSetsByShop = {};
      for (const slug of REPORTING_SHOP_SLUGS) {
        deptSetsByShop[slug] = await fetchTandaDepartmentIds(SHOP_INTEGRATIONS[slug].tandaLocationId);
      }
      const deptOwner = {};
      for (const [slug, set] of Object.entries(deptSetsByShop)) {
        for (const id of set) {
          if (deptOwner[id] && deptOwner[id] !== slug) {
            auditResult.departmentOverlaps.push({ departmentId: id, shops: [deptOwner[id], slug] });
          }
          deptOwner[id] = slug;
        }
      }

      // Staff name collision check (two people sharing a first or last name token).
      const nameTokenOwners = {};
      for (const u of users) {
        const tokens = (u.name || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
        for (const t of tokens) {
          if (!nameTokenOwners[t]) nameTokenOwners[t] = [];
          nameTokenOwners[t].push({ id: u.id, name: (u.name || "").trim() });
        }
      }
      for (const [token, owners] of Object.entries(nameTokenOwners)) {
        const distinctIds = [...new Set(owners.map((o) => o.id))];
        if (distinctIds.length > 1) {
          auditResult.staffNameCollisions.push({ token, people: owners.filter((o, i) => owners.findIndex((x) => x.id === o.id) === i) });
        }
      }

      for (const dateStr of dates) {
        const shiftsRaw = await fetchTandaShifts(dateStr);

        // Duplicate shift ids in the raw Tanda response itself.
        const idCounts = {};
        for (const s of shiftsRaw) idCounts[s.id] = (idCounts[s.id] || 0) + 1;
        const dupIds = Object.entries(idCounts).filter(([, c]) => c > 1);
        if (dupIds.length > 0) {
          auditResult.findings.push({ type: "duplicate_shift_in_tanda_response", date: dateStr, shiftIds: dupIds.map(([id]) => id) });
        }

        for (const slug of REPORTING_SHOP_SLUGS) {
          const deptIds = deptSetsByShop[slug];
          const liveShifts = shiftsRaw.filter((s) => deptIds.has(s.department_id));

          const savedShifts = db
            .prepare("SELECT * FROM tanda_shifts WHERE shop_slug = ? AND date = ?")
            .all(slug, dateStr);
          const savedByKey = {};
          for (const s of savedShifts) savedByKey[`${s.tanda_user_id}|${s.start_ts}`] = s;

          const matchedKeys = new Set();
          let correctTotalHours = 0;
          let correctTotalCostCents = 0;
          let openShiftCount = 0;

          for (const shift of liveShifts) {
            const key = `${shift.user_id}|${shift.start}`;
            const name = userNames[shift.user_id] || `Employee #${shift.user_id}`;

            if (!shift.start || !shift.finish) {
              openShiftCount++;
              auditResult.findings.push({ type: "no_clock_out", date: dateStr, shop: slug, user: name, shiftId: shift.id, status: shift.status });
              continue;
            }

            const hoursCorrect = correctHours(shift);
            const hoursSnapshotFormula = snapshotFormulaHours(shift);
            const hasCost = typeof shift.cost === "number";
            const costCentsLive = hasCost ? Math.round(shift.cost * 100) : null;
            if (hasCost) correctTotalHours += hoursCorrect, (correctTotalCostCents += costCentsLive);

            if (shift.status !== "APPROVED") {
              auditResult.findings.push({ type: "unapproved_shift", date: dateStr, shop: slug, user: name, shiftId: shift.id, status: shift.status });
            }
            if (hoursCorrect !== null && hoursCorrect > 12) {
              auditResult.findings.push({ type: "long_shift_over_12h", date: dateStr, shop: slug, user: name, shiftId: shift.id, hours: hoursCorrect });
            }
            if (hasCost && costCentsLive === 0 && hoursCorrect > 0) {
              auditResult.findings.push({ type: "zero_cost_with_hours", date: dateStr, shop: slug, user: name, shiftId: shift.id, hours: hoursCorrect });
            }
            if (Math.abs((hoursCorrect || 0) - (hoursSnapshotFormula || 0)) > 0.01) {
              auditResult.findings.push({
                type: "paid_break_subtracted",
                date: dateStr,
                shop: slug,
                user: name,
                shiftId: shift.id,
                hoursCorrect,
                hoursSnapshotFormula,
              });
            }

            const saved = savedByKey[key];
            matchedKeys.add(key);
            if (!saved) {
              auditResult.findings.push({ type: "missing_from_saved", date: dateStr, shop: slug, user: name, shiftId: shift.id, start: shift.start, finish: shift.finish });
              continue;
            }
            if (Math.abs(saved.hours - hoursSnapshotFormula) > 0.01) {
              auditResult.findings.push({
                type: "hours_mismatch_vs_saved",
                date: dateStr,
                shop: slug,
                user: name,
                shiftId: shift.id,
                saved: saved.hours,
                recomputedSameFormula: hoursSnapshotFormula,
              });
            }
            if (hasCost && saved.cost_cents !== costCentsLive) {
              auditResult.findings.push({ type: "cost_mismatch_vs_saved", date: dateStr, shop: slug, user: name, shiftId: shift.id, saved: saved.cost_cents, live: costCentsLive });
            }
            if (!hasCost && saved.cost_source === "tanda") {
              auditResult.findings.push({ type: "saved_cost_but_now_missing_live", date: dateStr, shop: slug, user: name, shiftId: shift.id });
            }
          }

          for (const [key, saved] of Object.entries(savedByKey)) {
            if (!matchedKeys.has(key)) {
              auditResult.findings.push({
                type: "stale_or_wrong_shop_in_saved",
                date: dateStr,
                shop: slug,
                user: saved.user_name,
                savedStartTs: saved.start_ts,
              });
            }
          }

          // Daily total comparison (against the snapshot's OWN formula, to
          // isolate "did the save even match a correct re-run of itself"
          // from "is the formula itself right" — the latter is the
          // paid_break_subtracted findings above).
          const savedDaily = db.prepare("SELECT * FROM tanda_daily_labour WHERE shop_slug = ? AND date = ?").get(slug, dateStr);
          const recomputedSnapshotFormulaHours = liveShifts.reduce((s, sh) => s + (snapshotFormulaHours(sh) || 0), 0);
          const recomputedSnapshotFormulaCostCents = liveShifts.reduce((s, sh) => s + (typeof sh.cost === "number" ? Math.round(sh.cost * 100) : 0), 0);
          if (savedDaily) {
            if (Math.abs(savedDaily.total_hours - recomputedSnapshotFormulaHours) > 0.05) {
              auditResult.findings.push({
                type: "daily_hours_mismatch",
                date: dateStr,
                shop: slug,
                saved: savedDaily.total_hours,
                recomputed: recomputedSnapshotFormulaHours,
              });
            }
            if (Math.abs(savedDaily.total_cost_cents - recomputedSnapshotFormulaCostCents) > 2) {
              auditResult.findings.push({
                type: "daily_cost_mismatch",
                date: dateStr,
                shop: slug,
                savedCents: savedDaily.total_cost_cents,
                recomputedCents: recomputedSnapshotFormulaCostCents,
              });
            }
          } else {
            auditResult.findings.push({ type: "no_daily_total_saved", date: dateStr, shop: slug });
          }

          // Hourly-bucket completeness (catches the overnight-shift gap:
          // hours worked past midnight on an overnight shift attributed to
          // THIS date never land in any hour bucket for this date OR the
          // next, since Tanda's own shift.date groups the whole shift under
          // the start date).
          const savedHourly = db.prepare("SELECT SUM(hours) AS h FROM tanda_hourly_labour WHERE shop_slug = ? AND date = ?").get(slug, dateStr);
          const hourlySum = savedHourly && savedHourly.h !== null ? savedHourly.h : 0;
          if (savedDaily && Math.abs(hourlySum - savedDaily.total_hours) > 0.1) {
            auditResult.findings.push({
              type: "hourly_sum_vs_daily_mismatch",
              date: dateStr,
              shop: slug,
              dailyTotal: savedDaily.total_hours,
              hourlySum,
              likelyCause: "overnight shift crossing midnight — its post-midnight hours fall outside this date's hour buckets",
            });
          }
          if (openShiftCount > 0) {
            auditResult.findings.push({ type: "open_shifts_excluded_from_day", date: dateStr, shop: slug, count: openShiftCount });
          }
        }

        auditResult.datesChecked++;
      }
    } catch (err) {
      auditResult.error = err.message;
    } finally {
      auditInProgress = false;
      auditResult.finishedAt = new Date().toISOString();
    }
  })();

  return { started: true };
}

module.exports = { runLabourAudit, getLabourAuditStatus };
