"use client";

import { useState } from "react";
import { drCr, fmt0, fmt2, fmtDate } from "@/lib/terminal/engine";
import type { ncdexBill } from "@/lib/terminal/ledger";
import type { Account } from "@/lib/terminal/types";
import { downloadNcdexBillPdf, lineLabel } from "./ncdex-bill-pdf";
import { PnL } from "./ui";

/** A client's NCDEX weekly bill: B/F at last settle price, the week's trades, C/F at this settle price. */
export function NcdexBillCard({ account, bill, priceDate, moneyAfter, onClose }: {
  account: Account;
  bill: ReturnType<typeof ncdexBill>;
  priceDate: string;
  moneyAfter: number;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await downloadNcdexBillPdf({ account, bill, priceDate, moneyAfter });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tt-card">
      <div className="tt-card-h">
        NCDEX Bill — {account.code} {account.name}
        <span className="tt-muted">week {fmtDate(bill.monday)} – {fmtDate(bill.friday)} · settlement price {fmtDate(priceDate)}</span>
        <button type="button" className="tt-btn tt-btn-blue tt-btn-xs" style={{ marginLeft: "auto" }} onClick={download} disabled={busy}>
          {busy ? "Preparing…" : "Download PDF"}
        </button>
        <button type="button" className="tt-btn tt-btn-xs" onClick={onClose}>Close</button>
      </div>
      <div className="tt-grid-wrap" style={{ maxHeight: "60vh" }}>
        <table className="tt-grid">
          <thead>
            <tr>
              <th>Date</th><th>Time</th><th>Particulars</th><th className="num">Buy Qty</th><th className="num">Sell Qty</th>
              <th className="num">Rate</th><th className="num">Brokerage</th><th className="num">Net Rate</th><th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bill.contracts.map((c) => [
              <tr key={c.contract} className="editing-soft">
                <td colSpan={9} style={{ fontWeight: 700 }}>
                  {c.contract}{c.unpriced && <span className="bad"> — no settlement price, billed next week</span>}
                </td>
              </tr>,
              ...c.lines.map((l, i) => {
                const buy = l.amount < 0;
                const settle = l.kind === "BF" || l.kind === "CF" || l.kind === "EXPIRY";
                return (
                  <tr key={`${c.contract}-${i}`} className={settle ? "editing-soft" : buy ? "buy" : "sell"}>
                    <td>{fmtDate(l.date)}</td>
                    <td>{l.time}</td>
                    <td className={settle ? "" : buy ? "b-txt" : "s-txt"}>{lineLabel(l)}</td>
                    <td className="num b-txt">{buy ? fmt0(l.qty) : ""}</td>
                    <td className="num s-txt">{buy ? "" : fmt0(l.qty)}</td>
                    <td className="num">{fmt2(l.rate)}</td>
                    <td className="num">{l.brokerage ? fmt2(l.brokerage) : ""}</td>
                    <td className="num">{fmt2(l.netRate)}</td>
                    <td className={`num ${l.amount < 0 ? "neg" : "pos"}`}>{drCr(l.amount)}</td>
                  </tr>
                );
              }),
              !c.unpriced && (
                <tr key={`${c.contract}-sub`}>
                  <td colSpan={8} className="num tt-muted">
                    {c.contract} — Gross {fmt2(c.grossPnl)} · Brokerage {fmt2(c.brokerage)} · Net P&amp;L
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}><PnL value={c.netPnl} /></td>
                </tr>
              ),
            ])}
            {!bill.contracts.length && <tr><td colSpan={9} className="empty">No NCDEX trades or positions this week.</td></tr>}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={8}>Week P&amp;L — Gross {fmt2(bill.grossPnl)} · Brokerage {fmt2(bill.brokerage)} · Net (posted to ledger)</td>
              <td className="num"><PnL value={bill.netPnl} /></td>
            </tr>
            <tr>
              <td colSpan={8}>Client money after this bill</td>
              <td className="num">{drCr(moneyAfter)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
