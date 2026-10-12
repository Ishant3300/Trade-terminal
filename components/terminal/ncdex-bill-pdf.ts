import type { NcdexBillLine, ncdexBill } from "@/lib/terminal/ledger";
import type { Account } from "@/lib/terminal/types";
import { amt, BLUE, crDr, dmy, drawBand, drawFooters, generatedAt, GREEN, INK, loadPdf, MARGIN, MUTED, qty, RED, tableTheme, type RGB } from "./pdf-kit";

// A4-landscape PDF of a client's NCDEX weekly bill (same content as the screen).

export interface NcdexBillPdfInput {
  account: Account;
  bill: ReturnType<typeof ncdexBill>;
  priceDate: string;
  /** Client money after this week's posting (ledger). */
  moneyAfter: number;
}

export const lineLabel = (l: NcdexBillLine) =>
  l.kind === "BF" ? `B/F ${l.amount < 0 ? "Buy" : "Sell"} @ settle` :
  l.kind === "CF" ? `C/F ${l.amount > 0 ? "Sell" : "Buy"} @ settle` :
  l.kind === "EXPIRY" ? `Expiry ${l.amount > 0 ? "Sell" : "Buy"} @ settle` : l.kind;

const pnlColor = (n: number): RGB => (n > 0.004 ? GREEN : n < -0.004 ? RED : INK);

export async function downloadNcdexBillPdf(input: NcdexBillPdfInput) {
  const doc = await buildNcdexBillPdf(input);
  doc.save(`NCDEX_Bill_${input.account.code}_${input.bill.friday}.pdf`);
}

export async function buildNcdexBillPdf({ account, bill, priceDate, moneyAfter }: NcdexBillPdfInput) {
  const { doc, autoTable } = await loadPdf();
  const W = doc.internal.pageSize.getWidth();
  const M = MARGIN;
  drawBand(doc, "NCDEX WEEKLY BILL", `${dmy(bill.monday)} to ${dmy(bill.friday)}  ·  settlement price ${dmy(priceDate)}`);

  let y = 34;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text("CLIENT", M, y);
  doc.text("BILL DETAILS", W - M, y, { align: "right" });
  y += 6;
  doc.setTextColor(...INK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(`${account.code}  -  ${account.name}`, M, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Week ${dmy(bill.monday)} - ${dmy(bill.friday)}`, W - M, y, { align: "right" });
  y += 5.5;
  doc.setTextColor(...MUTED);
  doc.setFontSize(8.5);
  doc.text("NCDEX futures  ·  open positions carried forward at the NCDEX settlement price  ·  no interest", M, y);
  doc.text(`Generated ${generatedAt()}  ·  Amounts in INR`, W - M, y, { align: "right" });
  y += 6;

  const body: (string | { content: string; colSpan?: number; styles?: object })[][] = [];
  const kinds: (string | null)[] = [];
  for (const c of bill.contracts) {
    body.push([{ content: c.contract + (c.unpriced ? "   (no settlement price - billed next week)" : ""), colSpan: 9, styles: { fontStyle: "bold", fillColor: [238, 243, 249] } }]);
    kinds.push("HEAD");
    for (const l of c.lines) {
      const buy = l.amount < 0;
      body.push([
        dmy(l.date), l.time, lineLabel(l), buy ? qty(l.qty) : "", buy ? "" : qty(l.qty), amt(l.rate),
        l.brokerage ? amt(l.brokerage) : "", amt(l.netRate), crDr(l.amount),
      ]);
      kinds.push(l.kind);
    }
    if (!c.unpriced) {
      body.push([{ content: `${c.contract}  -  Gross ${amt(c.grossPnl)}  ·  Brokerage ${amt(c.brokerage)}`, colSpan: 8, styles: { halign: "right", textColor: MUTED } }, crDr(c.netPnl)]);
      kinds.push("SUB");
    }
  }

  autoTable(doc, {
    ...tableTheme,
    startY: y,
    margin: { left: M, right: M, top: 16, bottom: 16 },
    head: [["Date", "Time", "Particulars", "Buy Qty", "Sell Qty", "Rate", "Brokerage", "Net Rate", "Amount"]],
    body,
    foot: [[{ content: `Week P&L  -  Gross ${amt(bill.grossPnl)}  ·  Brokerage ${amt(bill.brokerage)}  ·  Net (posted to ledger)`, colSpan: 8 }, crDr(bill.netPnl)]],
    showHead: "everyPage",
    showFoot: "lastPage",
    columnStyles: {
      0: { cellWidth: 22 }, 1: { cellWidth: 18 }, 2: { cellWidth: "auto" }, 3: { cellWidth: 20, halign: "right" }, 4: { cellWidth: 20, halign: "right" },
      5: { cellWidth: 24, halign: "right" }, 6: { cellWidth: 22, halign: "right" }, 7: { cellWidth: 24, halign: "right" }, 8: { cellWidth: 34, halign: "right", fontStyle: "bold" },
    },
    didParseCell: (d) => {
      if ((d.section === "head" && d.column.index >= 3) || (d.section === "foot")) d.cell.styles.halign = "right";
      if (d.section === "foot" && d.column.index === 8) d.cell.styles.textColor = pnlColor(bill.netPnl);
      if (d.section !== "body") return;
      const k = kinds[d.row.index];
      if (k === "BF" || k === "CF" || k === "EXPIRY") d.cell.styles.fillColor = [232, 241, 252];
      if (k === "SUB") d.cell.styles.fontStyle = "bold";
      if (d.column.index === 3) d.cell.styles.textColor = BLUE;
      if (d.column.index === 4) d.cell.styles.textColor = RED;
    },
  });

  const end = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  doc.text(`Client money after this bill: ${crDr(moneyAfter)}`, W - M, end, { align: "right" });

  drawFooters(doc, `NCDEX Weekly Bill  ·  ${account.code} ${account.name}  ·  ${dmy(bill.monday)} - ${dmy(bill.friday)}`);
  return doc;
}
