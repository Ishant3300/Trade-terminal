"use client";

import { useMemo, useState } from "react";
import { addDays, contractLabel, fmt0, fmt2, fmtDate, fmtLots, toDateStr, type TradeCalc } from "@/lib/terminal/engine";
import { SEGMENTS, type TerminalData } from "@/lib/terminal/types";
import { downloadCsv, Field } from "./ui";

interface Filters {
  segment: string;
  script: string;
  client: string;
  from: string;
  to: string;
  side: string;
  tradeType: string;
}

const defaults = (): Filters => {
  const today = toDateStr(new Date());
  return { segment: "", script: "", client: "", from: addDays(today, -7), to: today, side: "", tradeType: "" };
};

export function TradeBook({ data, calcs }: { data: TerminalData; calcs: Map<number, TradeCalc> }) {
  const [draft, setDraft] = useState<Filters>(defaults);
  const [applied, setApplied] = useState<Filters>(defaults);
  const set = (k: keyof Filters, v: string) => setDraft((f) => ({ ...f, [k]: v }));
  const nameOf = useMemo(() => new Map(data.accounts.map((a) => [a.code, a.name])), [data.accounts]);

  const rows = useMemo(() => {
    const f = applied;
    const q = f.script.trim().toUpperCase();
    return data.trades
      .filter((t) =>
        (!f.segment || t.segment === f.segment) &&
        (!q || contractLabel(t).includes(q)) &&
        (!f.client || t.clientCode === f.client) &&
        (!f.from || t.date >= f.from) &&
        (!f.to || t.date <= f.to) &&
        (!f.side || t.side === f.side) &&
        (!f.tradeType || t.tradeType === f.tradeType)
      )
      .sort((a, b) => a.addTime.localeCompare(b.addTime) || a.id - b.id);
  }, [data.trades, applied]);

  const totals = rows.reduce(
    (acc, t) => {
      const c = calcs.get(t.id);
      if (t.side === "B") { acc.bq += t.qty; acc.bv += t.rate * t.qty; } else { acc.sq += t.qty; acc.sv += t.rate * t.qty; }
      acc.brk += c?.brokerage ?? 0;
      return acc;
    },
    { bq: 0, bv: 0, sq: 0, sv: 0, brk: 0 }
  );

  const exportExcel = () => {
    downloadCsv(
      `tradebook_${applied.from}_${applied.to}.csv`,
      ["O/T", "Trade Date", "Client Code", "Client", "Segment", "Script", "Type", "Lot", "Qty", "Rate", "Net Rate", "Brokerage", "Trade Type", "User", "User IP", "Add Time"],
      rows.map((t) => {
        const c = calcs.get(t.id);
        return [
          t.ot, fmtDate(t.date), t.clientCode, nameOf.get(t.clientCode) ?? "", t.segment, contractLabel(t), t.side === "B" ? "BUY" : "SELL",
          Math.round((t.qty / (c?.lotSize || 1)) * 100) / 100, t.qty, t.rate.toFixed(2), (c?.netRate ?? t.rate).toFixed(4), (c?.brokerage ?? 0).toFixed(2), t.tradeType, t.user, t.ip, t.addTime,
        ];
      })
    );
  };

  return (
    <div className="tt-page">
      <div className="tt-card">
        <div className="tt-card-h">Trade Book</div>
        <form className="tt-card-b flex flex-wrap items-end gap-x-2 gap-y-1"
          onSubmit={(e) => { e.preventDefault(); setApplied(draft); }}>
          <Field label="Segment" width={92}>
            <select className="tt-select" value={draft.segment} onChange={(e) => set("segment", e.target.value)}>
              <option value="">All</option>
              {SEGMENTS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Script / Symbol" width={140}>
            <input className="tt-input" value={draft.script} onChange={(e) => set("script", e.target.value.toUpperCase())} placeholder="e.g. NIFTY" />
          </Field>
          <Field label="Client Code" width={170}>
            <select className="tt-select" value={draft.client} onChange={(e) => set("client", e.target.value)}>
              <option value="">All Clients</option>
              {data.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} - {a.name}</option>)}
            </select>
          </Field>
          <Field label="From" width={128}>
            <input type="date" className="tt-input" value={draft.from} onChange={(e) => set("from", e.target.value)} />
          </Field>
          <Field label="To" width={128}>
            <input type="date" className="tt-input" value={draft.to} onChange={(e) => set("to", e.target.value)} />
          </Field>
          <Field label="Buy/Sell" width={70}>
            <select className="tt-select" value={draft.side} onChange={(e) => set("side", e.target.value)}>
              <option value="">All</option><option value="B">Buy</option><option value="S">Sell</option>
            </select>
          </Field>
          <Field label="Trade Type" width={70}>
            <select className="tt-select" value={draft.tradeType} onChange={(e) => set("tradeType", e.target.value)}>
              <option value="">All</option><option>NRM</option><option>CF</option><option>BF</option>
            </select>
          </Field>
          <button type="submit" className="tt-btn tt-btn-blue">Find Trade</button>
          <button type="button" className="tt-btn tt-btn-save" onClick={exportExcel} disabled={!rows.length}>Export to Excel</button>
          <button type="button" className="tt-btn" onClick={() => { setDraft(defaults()); setApplied(defaults()); }}>Reset</button>
          <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {rows.length}</span>
        </form>
        <div className="tt-grid-wrap" style={{ maxHeight: "calc(100vh - 150px)" }}>
          <table className="tt-grid">
            <thead>
              <tr>
                <th>O/T</th><th>Trade Date</th><th>Client</th><th>Script</th><th>Type</th><th className="num">Lot</th>
                <th className="num">Qty</th><th className="num">Rate</th><th className="num">Net Rate</th><th>Trade Type</th>
                <th>User</th><th>User IP</th><th>Add Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={t.side === "B" ? "buy" : "sell"}>
                  <td className="ctr">{t.ot}</td>
                  <td>{fmtDate(t.date)}</td>
                  <td>{t.clientCode} - {nameOf.get(t.clientCode) ?? "?"}</td>
                  <td>{contractLabel(t)} <span className="tt-muted">{t.segment}</span></td>
                  <td className={t.side === "B" ? "b-txt" : "s-txt"}>{t.side === "B" ? "BUY" : "SELL"}</td>
                  <td className="num">{fmtLots(t.qty / (calcs.get(t.id)?.lotSize || 1))}</td>
                  <td className="num">{fmt0(t.qty)}</td>
                  <td className="num">{fmt2(t.rate)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmt2(calcs.get(t.id)?.netRate ?? t.rate)}</td>
                  <td>{t.tradeType}</td>
                  <td>{t.user}</td>
                  <td>{t.ip}</td>
                  <td>{fmtDate(t.addTime.slice(0, 10))} {t.addTime.slice(11)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={13} className="empty">No trades match the filter. Adjust filters and press Find Trade.</td></tr>}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={6}>
                    <span className="b-txt">Buy Qty {fmt0(totals.bq)} · ₹{fmt2(totals.bv)}</span> &nbsp;|&nbsp;
                    <span className="s-txt"> Sell Qty {fmt0(totals.sq)} · ₹{fmt2(totals.sv)}</span>
                  </td>
                  <td colSpan={7}>Total Brokerage ₹{fmt2(totals.brk)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
