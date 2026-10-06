import type { StatementRow } from "@/lib/terminal/ledger";
import type { Account } from "@/lib/terminal/types";

// Premium A4-landscape PDF of the Ledger Statement (same content as the screen).

export interface LedgerPdfInput {
  account: Account;
  monthLabel: string; // "Aug 2026"
  periodFrom: string; // YYYY-MM-DD
  periodTo: string; // statement up to
  rows: StatementRow[];
  summary: {
    money: number;
    margin: number;
    funded: number;
    monthInterest: number;
    monthInterestNote: string; // "billed 31-08-2026" | "accrued"
    postedInterest: number;
    pendingPnl: number;
  };
  firmName?: string;
}

type RGB = [number, number, number];
const INK: RGB = [28, 36, 48];
const NAVY: RGB = [31, 36, 45];
const ACCENT: RGB = [30, 96, 210];
const MUTED: RGB = [107, 118, 134];
const RED: RGB = [183, 28, 28];
const GREEN: RGB = [26, 127, 55];
const LINE: RGB = [216, 220, 227];

const nf = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt = (n: number) => nf.format(Math.abs(n) < 0.005 ? 0 : n);
const crDr = (n: number) => (Math.abs(n) < 0.005 ? "0.00" : `${nf.format(Math.abs(n))} ${n >= 0 ? "Cr" : "Dr"}`);
const dmy = (d: string) => d.split("-").reverse().join("-");

export async function downloadLedgerPdf(input: LedgerPdfInput) {
  const doc = await buildLedgerPdf(input);
  doc.save(`Ledger_${input.account.code}_${input.account.name.replace(/[^\w]+/g, "_")}_${input.periodFrom.slice(0, 7)}.pdf`);
}

/** Builds the statement PDF (jsPDF document). */
export async function buildLedgerPdf(input: LedgerPdfInput) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const { account, rows, summary } = input;
  const firm = (input.firmName ?? "Trade Terminal").toUpperCase();
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 12; // margin

  // ---- Header band ------------------------------------------------------------------
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, W, 24, "F");
  doc.setFillColor(...ACCENT);
  doc.rect(0, 24, W, 1.2, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text(firm, M, 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(170, 178, 190);
  doc.text("JOBBING BACK OFFICE", M, 17.5);
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text("LEDGER STATEMENT", W - M, 12, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(200, 206, 214);
  doc.text(`${input.monthLabel}  ·  ${dmy(input.periodFrom)} to ${dmy(input.periodTo)}`, W - M, 17.5, { align: "right" });

  // ---- Client block -------------------------------------------------------------------
  let y = 34;
  doc.setTextColor(...MUTED);
  doc.setFontSize(7.5);
  doc.text("CLIENT", M, y);
  doc.text("STATEMENT DETAILS", W - M, y, { align: "right" });
  y += 6;
  doc.setTextColor(...INK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(`${account.code}  —  ${account.name}`, M, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Statement up to ${dmy(input.periodTo)}`, W - M, y, { align: "right" });
  y += 5.5;
  doc.setTextColor(...MUTED);
  doc.setFontSize(8.5);
  doc.text(`NSE Equity  ·  Interest ${account.interestPct.toFixed(2)}% p.a. on funded amount  ·  Funded = Margin used - Client money`, M, y);
  const now = new Date();
  doc.text(
    `Generated ${now.toLocaleDateString("en-GB").replace(/\//g, "-")} ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}  ·  Amounts in INR`,
    W - M, y, { align: "right" }
  );

  // ---- Summary tiles ------------------------------------------------------------------
  y += 6;
  const tiles: { label: string; value: string; color: RGB; note?: string }[] = [
    { label: "CLIENT MONEY", value: crDr(summary.money), color: summary.money < 0 ? RED : GREEN },
    { label: "MARGIN USED", value: amt(summary.margin), color: INK },
    { label: "FUNDED", value: amt(summary.funded), color: summary.funded > 0 ? RED : INK },
    { label: "INTEREST THIS MONTH", value: amt(summary.monthInterest), color: INK, note: summary.monthInterestNote },
    { label: "INTEREST POSTED TO DATE", value: amt(summary.postedInterest), color: INK },
    { label: "P&L AWAITING SETTLEMENT", value: amt(summary.pendingPnl), color: summary.pendingPnl < 0 ? RED : GREEN },
  ];
  const gap = 3;
  const tw = (W - 2 * M - gap * (tiles.length - 1)) / tiles.length;
  const th = 17;
  tiles.forEach((t, i) => {
    const x = M + i * (tw + gap);
    doc.setFillColor(246, 248, 251);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.25);
    doc.roundedRect(x, y, tw, th, 1.2, 1.2, "FD");
    doc.setFillColor(...ACCENT);
    doc.rect(x, y + 1.2, 0.9, th - 2.4, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(t.label, x + 3.5, y + 5);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...t.color);
    doc.text(t.value, x + 3.5, y + 11.5);
    if (t.note) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(...MUTED);
      doc.text(t.note, x + 3.5, y + 15);
    }
  });
  y += th + 6;

  // ---- Statement table ----------------------------------------------------------------
  const body = rows.map((r) => [
    dmy(r.date),
    r.particulars,
    r.debit ? amt(r.debit) : "",
    r.credit ? amt(r.credit) : "",
    crDr(r.money),
    amt(r.margin),
    amt(r.funded),
    r.days ? String(r.days) : "",
    r.interest ? amt(r.interest) : "",
  ]);
  const totalDays = rows.reduce((s, r) => s + r.days, 0);
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);

  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M, top: 16, bottom: 16 },
    head: [["Date", "Particulars", "Debit", "Credit", "Client Money", "Margin Used", "Funded", "Days", "Interest"]],
    body,
    foot: [[
      { content: `Interest for ${input.monthLabel}${summary.monthInterestNote.startsWith("accrued") ? " (accrued so far)" : ""}`, colSpan: 7 },
      String(totalDays),
      amt(totalInterest),
    ]],
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "plain",
    styles: { font: "helvetica", fontSize: 8.4, textColor: INK, cellPadding: { top: 2.1, bottom: 2.1, left: 2.4, right: 2.4 }, lineColor: LINE, lineWidth: { bottom: 0.2 }, valign: "middle" },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 8.4, lineWidth: 0 },
    footStyles: { fillColor: [228, 232, 238], textColor: INK, fontStyle: "bold", fontSize: 9, lineWidth: 0 },
    alternateRowStyles: { fillColor: [250, 251, 253] },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: "auto" },
      2: { cellWidth: 22, halign: "right" },
      3: { cellWidth: 22, halign: "right" },
      4: { cellWidth: 28, halign: "right" },
      5: { cellWidth: 25, halign: "right" },
      6: { cellWidth: 26, halign: "right", fontStyle: "bold" },
      7: { cellWidth: 14, halign: "right" },
      8: { cellWidth: 21, halign: "right" },
    },
    didParseCell: (data) => {
      if (data.section === "head" && data.column.index >= 2) data.cell.styles.halign = "right";
      if (data.section === "foot" && data.column.index >= 7) data.cell.styles.halign = "right";
      if (data.section !== "body") return;
      const r = rows[data.row.index];
      if (r.kind === "BF") {
        data.cell.styles.fillColor = [238, 243, 249];
        if (data.column.index === 1) data.cell.styles.fontStyle = "bold";
      } else if (r.kind === "PNL" || r.kind === "MTM") {
        data.cell.styles.fillColor = [232, 241, 252];
      } else if (r.kind === "INTEREST") {
        data.cell.styles.fillColor = [253, 236, 234];
      }
      if (data.column.index === 4 && r.money < -0.004) data.cell.styles.textColor = RED;
    },
  });

  // ---- Footer on every page -----------------------------------------------------------
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.3);
    doc.line(M, H - 10, W - M, H - 10);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(`${firm}  ·  Ledger Statement  ·  ${account.code} ${account.name}  ·  ${input.monthLabel}`, M, H - 6);
    doc.text("This is a computer-generated statement.", W / 2, H - 6, { align: "center" });
    doc.text(`Page ${p} of ${pages}`, W - M, H - 6, { align: "right" });
  }

  return doc;
}
