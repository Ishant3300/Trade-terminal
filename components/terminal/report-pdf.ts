import type { LedgerRow, Position } from "@/lib/terminal/engine";
import { amt, BLUE, crDr, dmy, drawBand, drawFooters, generatedAt, GREEN, INK, loadPdf, MARGIN, MUTED, qty, RED, tableTheme, type RGB } from "./pdf-kit";

// Premium A4-landscape PDF of the Reports page: Net Position + Client Ledger.

export interface ReportPdfInput {
  asOn: string; // YYYY-MM-DD
  /** How open positions were valued, e.g. "MTM at NSE close 30-09-2026 (bhav)". */
  priceNote: string;
  filters: { client: string; segment: string; script: string };
  nameOf: Map<string, string>;
  positions: Position[];
  positionTotals: { realized: number; mtm: number };
  ledger: LedgerRow[];
  ledgerTotals: { opening: number; dep: number; gross: number; brk: number; int: number; bal: number; unr: number; eq: number };
}

const pnlColor = (n: number): RGB => (n > 0.004 ? GREEN : n < -0.004 ? RED : INK);

export async function downloadReportPdf(input: ReportPdfInput) {
  const doc = await buildReportPdf(input);
  doc.save(`Report_${input.filters.client || "All"}_as_on_${input.asOn}.pdf`);
}

export async function buildReportPdf(input: ReportPdfInput) {
  const { doc, autoTable } = await loadPdf();
  const W = doc.internal.pageSize.getWidth();
  const M = MARGIN;
  const { filters } = input;
  drawBand(doc, "PORTFOLIO REPORT", `Net Position & Client Ledger  ·  As on ${dmy(input.asOn)}`);

  // ---- Filter line ----------------------------------------------------------------------
  let y = 33;
  const clientLabel = filters.client ? `${filters.client} — ${input.nameOf.get(filters.client) ?? ""}` : "All clients";
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text("CLIENT", M, y);
  doc.text("REPORT DETAILS", W - M, y, { align: "right" });
  y += 6;
  doc.setTextColor(...INK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(clientLabel, M, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`As on ${dmy(input.asOn)}`, W - M, y, { align: "right" });
  y += 5.5;
  doc.setTextColor(...MUTED);
  doc.setFontSize(8.5);
  doc.text(`Segment: ${filters.segment || "All"}  ·  Script: ${filters.script || "All"}  ·  All trades up to the As on date`, M, y);
  doc.text(`Generated ${generatedAt()}  ·  Amounts in INR`, W - M, y, { align: "right" });
  y += 7;

  const section = (title: string, note: string) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...INK);
    doc.text(title, M, y);
    const titleWidth = doc.getTextWidth(title);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.8);
    doc.setTextColor(...MUTED);
    doc.text(note, M + titleWidth + 3, y);
    y += 2.5;
  };
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  // ---- Net Position -----------------------------------------------------------------------
  section("Net Position", `—  ${input.positions.length} positions  ·  average rates include brokerage  ·  ${input.priceNote}`);
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    margin: { left: M, right: M, top: 16, bottom: 16 },
    head: [["Client", "Segment", "Script", "Buy Qty", "Avg Buy", "Sell Qty", "Avg Sell", "Net Qty", "LTP", "P&L"]],
    body: input.positions.map((p) => [
      `${p.clientCode} - ${input.nameOf.get(p.clientCode) ?? ""}`,
      p.segment,
      p.label,
      qty(p.buyQty),
      p.buyQty ? amt(p.avgBuy) : "",
      qty(p.sellQty),
      p.sellQty ? amt(p.avgSell) : "",
      qty(p.netQty),
      amt(p.lastRate),
      amt(p.realized + p.mtm),
    ]),
    foot: [[{ content: "Total (net of brokerage)", colSpan: 9 }, amt(input.positionTotals.realized + input.positionTotals.mtm)]],
    showHead: "everyPage",
    showFoot: "lastPage",
    columnStyles: {
      0: { cellWidth: 40 }, 1: { cellWidth: 17 }, 2: { cellWidth: "auto" },
      3: { cellWidth: 18, halign: "right" }, 4: { cellWidth: 21, halign: "right" }, 5: { cellWidth: 18, halign: "right" },
      6: { cellWidth: 21, halign: "right" }, 7: { cellWidth: 18, halign: "right", fontStyle: "bold" }, 8: { cellWidth: 20, halign: "right" },
      9: { cellWidth: 30, halign: "right", fontStyle: "bold" },
    },
    didParseCell: (d) => {
      if ((d.section === "head" && d.column.index >= 3) || (d.section === "foot" && d.column.index >= 9)) d.cell.styles.halign = "right";
      if (d.section === "foot" && d.column.index === 9) d.cell.styles.textColor = pnlColor(input.positionTotals.realized + input.positionTotals.mtm);
      if (d.section !== "body") return;
      const p = input.positions[d.row.index];
      if (d.column.index === 3) d.cell.styles.textColor = BLUE;
      if (d.column.index === 5) d.cell.styles.textColor = RED;
      if (d.column.index === 7) d.cell.styles.textColor = p.netQty > 0 ? BLUE : p.netQty < 0 ? RED : INK;
      if (d.column.index === 9) d.cell.styles.textColor = pnlColor(p.realized + p.mtm);
      if (d.column.index === 8 && !p.live) d.cell.styles.fontStyle = "italic";
    },
  });
  y = lastY() + 9;

  // ---- Client Ledger ------------------------------------------------------------------------
  if (y > doc.internal.pageSize.getHeight() - 40) {
    doc.addPage();
    y = 18;
  }
  section("Client Ledger", "—  Balance = Opening (+Cr / -Dr) + Deposits (net) + Realized P&L - Brokerage - Interest");
  const t = input.ledgerTotals;
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    margin: { left: M, right: M, top: 16, bottom: 16 },
    head: [["Code", "Account Name", "Type", "Opening", "Deposits (net)", "Realized P&L", "Brokerage", "Interest", "Current Balance", "Unrealized MTM", "Net Equity", "Int. %"]],
    body: input.ledger.map((r) => [
      r.account.code,
      r.account.name,
      r.account.type,
      crDr(r.opening),
      amt(r.deposits),
      amt(r.grossRealized),
      amt(r.brokerage),
      amt(r.interest),
      crDr(r.balance),
      amt(r.unrealized),
      crDr(r.equity),
      r.account.interestPct ? r.account.interestPct.toFixed(2) : "",
    ]),
    foot: [[{ content: "Total", colSpan: 3 }, crDr(t.opening), amt(t.dep), amt(t.gross), amt(t.brk), amt(t.int), crDr(t.bal), amt(t.unr), crDr(t.eq), ""]],
    showHead: "everyPage",
    showFoot: "lastPage",
    columnStyles: {
      0: { cellWidth: 14, fontStyle: "bold" }, 1: { cellWidth: "auto" }, 2: { cellWidth: 17 },
      3: { cellWidth: 29, halign: "right" }, 4: { cellWidth: 24, halign: "right" }, 5: { cellWidth: 24, halign: "right" },
      6: { cellWidth: 21, halign: "right" }, 7: { cellWidth: 21, halign: "right" }, 8: { cellWidth: 29, halign: "right", fontStyle: "bold" },
      9: { cellWidth: 25, halign: "right" }, 10: { cellWidth: 29, halign: "right", fontStyle: "bold" }, 11: { cellWidth: 12, halign: "right" },
    },
    didParseCell: (d) => {
      if ((d.section === "head" && d.column.index >= 3) || (d.section === "foot" && d.column.index >= 3)) d.cell.styles.halign = "right";
      const r = d.section === "body" ? input.ledger[d.row.index] : null;
      const v = (key: "opening" | "balance" | "equity" | "grossRealized" | "unrealized") =>
        r ? r[key] : key === "opening" ? t.opening : key === "balance" ? t.bal : key === "equity" ? t.eq : key === "grossRealized" ? t.gross : t.unr;
      if (d.section === "head") return;
      if (d.column.index === 3 && v("opening") < -0.004) d.cell.styles.textColor = RED;
      if (d.column.index === 5) d.cell.styles.textColor = pnlColor(v("grossRealized"));
      if (d.column.index === 8) d.cell.styles.textColor = v("balance") < -0.004 ? RED : GREEN;
      if (d.column.index === 9) d.cell.styles.textColor = pnlColor(v("unrealized"));
      if (d.column.index === 10) d.cell.styles.textColor = v("equity") < -0.004 ? RED : GREEN;
    },
  });

  drawFooters(doc, `Portfolio Report  ·  ${filters.client ? `${filters.client} ${input.nameOf.get(filters.client) ?? ""}` : "All clients"}  ·  As on ${dmy(input.asOn)}`);
  return doc;
}
