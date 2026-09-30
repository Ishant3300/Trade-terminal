"use client";

import { useMemo, useState } from "react";
import {
  addDays, computeLedger, computePositions, contractLabel, drCr, fmt0, fmt2, toDateStr, type TradeCalc,
} from "@/lib/terminal/engine";
import { SEGMENTS, type TerminalData } from "@/lib/terminal/types";
import { downloadCsv, Field, PnL } from "./ui";

interface Filters {
  segment: string;
  script: string;
  client: string;
  from: string;
  to: string;
}

const defaults = (): Filters => {
  const today = toDateStr(new Date());
  return { segment: "", script: "", client: "", from: addDays(today, -7), to: today };
};

export function Reports({ data, calcs }: { data: TerminalData; calcs: Map<number, TradeCalc> }) {
  const [draft, setDraft] = useState<Filters>(defaults);
  const [f, setApplied] = useState<Filters>(defaults);
  const set = (k: keyof Filters, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const nameOf = useMemo(() => new Map(data.accounts.map((a) => [a.code, a.name])), [data.accounts]);

  const positions = useMemo(() => {
    const q = f.script.trim().toUpperCase();
    const trades = data.trades.filter((t) =>
      (!f.segment || t.segment === f.segment) &&
      (!q || contractLabel(t).includes(q)) &&
      (!f.client || t.clientCode === f.client) &&
      (!f.from || t.date >= f.from) &&
      (!f.to || t.date <= f.to)
    );
    return computePositions(trades, calcs);
  }, [data.trades, calcs, f]);

  // Ledger balances run over every trade up to the To date, across all segments.
  const ledger = useMemo(() => {
    const trades = data.trades.filter((t) => !f.to || t.date <= f.to);
    const accounts = data.accounts.filter((a) => !f.client || a.code === f.client);
    return computeLedger(accounts, computePositions(trades, calcs));
  }, [data.trades, data.accounts, calcs, f.to, f.client]);

  const pt = positions.reduce((s, p) => ({ realized: s.realized + p.realized, mtm: s.mtm + p.mtm }), { realized: 0, mtm: 0 });
  const lt = ledger.reduce(
    (s, r) => ({ opening: s.opening + r.opening, gross: s.gross + r.grossRealized, brk: s.brk + r.brokerage, bal: s.bal + r.balance, unr: s.unr + r.unrealized, eq: s.eq + r.equity }),
    { opening: 0, gross: 0, brk: 0, bal: 0, unr: 0, eq: 0 }
  );

  const exportPositions = () =>
    downloadCsv(
      `net_position_${f.from}_${f.to}.csv`,
      ["Client Code", "Client", "Segment", "Script", "Buy Qty", "Avg Buy Rate", "Sell Qty", "Avg Sell Rate", "Net Qty", "Last Rate", "Realized P&L", "MTM"],
      positions.map((p) => [p.clientCode, nameOf.get(p.clientCode) ?? "", p.segment, p.label, p.buyQty, p.avgBuy.toFixed(4), p.sellQty, p.avgSell.toFixed(4), p.netQty, p.lastRate.toFixed(2), p.realized.toFixed(2), p.mtm.toFixed(2)])
    );

  return (
    <div className="tt-page">
      <div className="tt-card">
        <div className="tt-card-h">Reports — Net Position &amp; Client Ledger</div>
        <form className="tt-card-b flex flex-wrap items-end gap-x-2 gap-y-1" onSubmit={(e) => { e.preventDefault(); setApplied(draft); }}>
          <Field label="Segment" width={92}>
            <select className="tt-select" value={draft.segment} onChange={(e) => set("segment", e.target.value)}>
              <option value="">All</option>
              {SEGMENTS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Script" width={140}>
            <input className="tt-input" value={draft.script} onChange={(e) => set("script", e.target.value.toUpperCase())} placeholder="e.g. CRUDEOIL" />
          </Field>
          <Field label="Client" width={170}>
            <select className="tt-select" value={draft.client} onChange={(e) => set("client", e.target.value)}>
              <option value="">All Clients</option>
              {data.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} - {a.name}</option>)}
            </select>
          </Field>
          <Field label="From" width={118}>
            <input type="date" className="tt-input" value={draft.from} onChange={(e) => set("from", e.target.value)} />
          </Field>
          <Field label="To" width={118}>
            <input type="date" className="tt-input" value={draft.to} onChange={(e) => set("to", e.target.value)} />
          </Field>
          <button type="submit" className="tt-btn tt-btn-blue">View</button>
          <button type="button" className="tt-btn tt-btn-save" onClick={exportPositions} disabled={!positions.length}>Export to Excel</button>
          <span className="tt-muted" style={{ marginLeft: "auto" }}>MTM marked to the last traded rate of each contract</span>
        </form>
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Net Position
          <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {positions.length}</span>
        </div>
        <div className="tt-grid-wrap" style={{ maxHeight: "46vh" }}>
          <table className="tt-grid">
            <thead>
              <tr>
                <th>Client</th><th>Segment</th><th>Script</th><th className="num">Total Buy Qty</th><th className="num">Avg Buy Rate</th>
                <th className="num">Total Sell Qty</th><th className="num">Avg Sell Rate</th><th className="num">Net Qty</th>
                <th className="num">Last Rate</th><th className="num">Realized P&amp;L</th><th className="num">MTM</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.key} className={p.netQty > 0 ? "buy" : p.netQty < 0 ? "sell" : ""}>
                  <td>{p.clientCode} - {nameOf.get(p.clientCode) ?? "?"}</td>
                  <td>{p.segment}</td>
                  <td>{p.label}</td>
                  <td className="num b-txt">{fmt0(p.buyQty)}</td>
                  <td className="num">{p.buyQty ? fmt2(p.avgBuy) : ""}</td>
                  <td className="num s-txt">{fmt0(p.sellQty)}</td>
                  <td className="num">{p.sellQty ? fmt2(p.avgSell) : ""}</td>
                  <td className={`num ${p.netQty > 0 ? "b-txt" : p.netQty < 0 ? "s-txt" : ""}`}>{fmt0(p.netQty)}</td>
                  <td className="num">{fmt2(p.lastRate)}</td>
                  <td className="num"><PnL value={p.realized} /></td>
                  <td className="num"><PnL value={p.mtm} /></td>
                </tr>
              ))}
              {positions.length === 0 && <tr><td colSpan={11} className="empty">No positions for the selected filter.</td></tr>}
            </tbody>
            {positions.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={9}>Total (net of brokerage)</td>
                  <td className="num"><PnL value={pt.realized} /></td>
                  <td className="num"><PnL value={pt.mtm} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Client Ledger <span className="tt-muted">— up to {f.to.split("-").reverse().join("-")} · Balance = Opening (+Cr / −Dr) + Realized P&amp;L − Brokerage</span>
        </div>
        <div className="tt-grid-wrap">
          <table className="tt-grid">
            <thead>
              <tr>
                <th>Code</th><th>Account Name</th><th>Type</th><th className="num">Opening</th><th className="num">Realized P&amp;L</th>
                <th className="num">Brokerage</th><th className="num">Current Balance</th><th className="num">Unrealized MTM</th>
                <th className="num">Net Equity</th><th className="num">Int. %</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((r) => (
                <tr key={r.account.code}>
                  <td style={{ fontWeight: 600 }}>{r.account.code}</td>
                  <td>{r.account.name}</td>
                  <td>{r.account.type}</td>
                  <td className={`num ${r.opening < 0 ? "neg" : ""}`}>{drCr(r.opening)}</td>
                  <td className="num"><PnL value={r.grossRealized} /></td>
                  <td className="num">{fmt2(r.brokerage)}</td>
                  <td className={`num ${r.balance < 0 ? "neg" : "pos"}`} style={{ fontWeight: 700 }}>{drCr(r.balance)}</td>
                  <td className="num"><PnL value={r.unrealized} /></td>
                  <td className={`num ${r.equity < 0 ? "neg" : ""}`} style={{ fontWeight: 600 }}>{drCr(r.equity)}</td>
                  <td className="num">{r.account.interestPct ? r.account.interestPct.toFixed(2) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total</td>
                <td className="num">{drCr(lt.opening)}</td>
                <td className="num"><PnL value={lt.gross} /></td>
                <td className="num">{fmt2(lt.brk)}</td>
                <td className="num">{drCr(lt.bal)}</td>
                <td className="num"><PnL value={lt.unr} /></td>
                <td className="num">{drCr(lt.eq)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
