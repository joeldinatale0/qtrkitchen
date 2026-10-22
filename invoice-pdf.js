const PDFDocument = require("pdfkit");

function money(n) {
  return `$${n.toFixed(2)}`;
}

const PDF_COLS = { item: 50, unit: 270, qty: 330, price: 400, subtotal: 470, rightEdge: 545 };
const ROW_HEIGHT = 16;

// Manually paginate rather than relying on PDFKit's implicit auto-page-break,
// which doesn't know our rows are made of several independently-positioned
// text() calls — letting it fire mid-row splits a single row's columns
// across separate pages.
function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

// Draws one item table (header + rows + subtotal line) at the current cursor
// position, with every row's columns sharing one explicitly-captured y and
// the cursor advanced by a fixed row height — never by font-metric math that
// can drift once a page break has occurred. Returns { total, hasUnpriced }.
function renderItemTable(doc, items) {
  const c = PDF_COLS;
  ensureSpace(doc, ROW_HEIGHT * 2);

  doc.font("Helvetica-Bold").fontSize(10);
  let y = doc.y;
  doc.text("Item", c.item, y);
  doc.text("Unit", c.unit, y);
  doc.text("Qty", c.qty, y);
  doc.text("Price", c.price, y);
  doc.text("Subtotal", c.subtotal, y);
  doc.y = y + ROW_HEIGHT;
  doc.moveTo(c.item, doc.y).lineTo(c.rightEdge, doc.y).strokeColor("#ccc").stroke();
  doc.y += 6;
  doc.font("Helvetica").fontSize(10);

  let total = 0;
  let hasUnpriced = false;

  if (items.length === 0) {
    ensureSpace(doc, ROW_HEIGHT);
    doc.fillColor("#999").text("No order placed.", c.item, doc.y);
    doc.fillColor("#000");
    doc.y += ROW_HEIGHT;
  } else {
    items.forEach((t) => {
      ensureSpace(doc, ROW_HEIGHT);
      const rowY = doc.y;
      const subtotal = t.price !== null ? t.price * t.quantity : null;
      if (subtotal !== null) total += subtotal;
      else hasUnpriced = true;

      doc.text(t.name, c.item, rowY, { width: 210 });
      doc.text(t.unit, c.unit, rowY);
      doc.text(String(t.quantity), c.qty, rowY);
      doc.text(t.price !== null ? money(t.price) : "—", c.price, rowY);
      doc.text(subtotal !== null ? money(subtotal) : "—", c.subtotal, rowY);
      doc.y = rowY + ROW_HEIGHT;
    });

    ensureSpace(doc, ROW_HEIGHT * 1.5);
    doc.moveTo(c.item, doc.y).lineTo(c.rightEdge, doc.y).strokeColor("#ccc").stroke();
    doc.y += 6;
    doc.font("Helvetica-Bold");
    y = doc.y;
    doc.text("Subtotal", c.price, y);
    doc.text(money(total), c.subtotal, y);
    doc.y = y + ROW_HEIGHT;
    doc.font("Helvetica");
  }

  return { total, hasUnpriced };
}

// dailyBreakdown: array of 7 { dateLabel, items: [{name, unit, quantity, price}] }
// weeklyTotals: array of { name, unit, quantity, price } aggregated across the week
function buildWeeklySummaryPdf(shop, weekStartLabel, weekEndLabel, dailyBreakdown, weeklyTotals) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.x = PDF_COLS.item;
    doc.fontSize(20).text("QTR Kitchen Ordering", PDF_COLS.item, doc.y, { width: PDF_COLS.rightEdge - PDF_COLS.item });
    doc.fontSize(14).text(`Weekly Invoice — ${shop.name}`, PDF_COLS.item, doc.y, { width: PDF_COLS.rightEdge - PDF_COLS.item });
    doc.fontSize(11).fillColor("#555").text(`${weekStartLabel} to ${weekEndLabel}`, PDF_COLS.item, doc.y, { width: PDF_COLS.rightEdge - PDF_COLS.item });
    doc.fillColor("#000");

    let hasUnpriced = false;

    dailyBreakdown.forEach((day) => {
      ensureSpace(doc, ROW_HEIGHT * 4);
      doc.y += 16;
      doc.x = PDF_COLS.item;
      doc.fontSize(12).font("Helvetica-Bold").text(day.dateLabel, PDF_COLS.item, doc.y, { width: PDF_COLS.rightEdge - PDF_COLS.item });
      doc.y += 4;
      const { hasUnpriced: dayUnpriced } = renderItemTable(doc, day.items);
      if (dayUnpriced) hasUnpriced = true;
    });

    doc.addPage();
    doc.x = PDF_COLS.item;
    doc.fontSize(16).font("Helvetica-Bold").text("Weekly Total", PDF_COLS.item, doc.y, { width: PDF_COLS.rightEdge - PDF_COLS.item });
    doc.fontSize(11).font("Helvetica").fillColor("#555").text(`${weekStartLabel} to ${weekEndLabel}`, PDF_COLS.item, doc.y, { width: PDF_COLS.rightEdge - PDF_COLS.item });
    doc.fillColor("#000");
    doc.y += 16;
    const { total: grandTotal, hasUnpriced: weekUnpriced } = renderItemTable(doc, weeklyTotals);
    if (weekUnpriced) hasUnpriced = true;

    ensureSpace(doc, ROW_HEIGHT * 2);
    doc.y += 10;
    doc.x = PDF_COLS.item;
    doc.fontSize(13).font("Helvetica-Bold").text(`Week Total: ${money(grandTotal)}`, PDF_COLS.item, doc.y);

    if (hasUnpriced) {
      ensureSpace(doc, ROW_HEIGHT * 2);
      doc.y += 16;
      doc.fontSize(10).font("Helvetica").fillColor("#777").text(
        "Note: some items don't have a price set yet and are excluded from totals above (shown as —).",
        PDF_COLS.item,
        doc.y,
        { width: PDF_COLS.rightEdge - PDF_COLS.item }
      );
    }

    doc.end();
  });
}

module.exports = { buildWeeklySummaryPdf };
