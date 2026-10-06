"use client";

import { useMemo, useState } from "react";
import {
  computeLedger, computePositions, contractLabel, drCr, fmt0, fmt2, fmtDate, toDateStr, type TradeCalc,
} from "@/lib/terminal/engine";
import { SEGMENTS, type TerminalData } from "@/lib/terminal/types";
import { computeClientLedger } from "@/lib/terminal/ledger";
import { useLiveQuotes } from "./quotes";
import { downloadReportPdf } from "./report-pdf";
import { downloadCsv, Field, PnL } from "./ui";

interface Filters {
  segment: string;
  script: string;
  client: string;
  to: string;
}

const defaults = (): Filters => {
  const today = toDateStr(new Date());
  return { segment: "", script: "", client: "", to: today };
};

export function Reports({ data, calcs }: { data: TerminalData; calcs: Map<number, TradeCalc> }) {
  const [draft, setDraft] = useState<Filters>(defaults);
  const [f, setApplied] = useState<Filters>(defaults);
  const set = (k: keyof Filters, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const nameOf = useMemo(() => new Map(data.accounts.map((a) => [a.code, a.name])), [data.accounts]);

  const positionTrades = useMemo(() => {
    const q = f.script.trim().toUpperCase();
    return data.trades.filter((t) =>
      (!f.segment || t.segment === f.segment) &&
      (!q || contractLabel(t).includes(q)) &&
      (!f.client || t.clientCode === f.client) &&
      (!f.to || t.date <= f.to)
    );
  }, [data.trades, f]);
  // Ledger balances run over every trade up to the To date, across all segments.
  const ledgerTrades = useMemo(() => data.trades.filter((t) => !f.to || t.date <= f.to), [data.trades, f.to]);

  // Live prices only for contracts with an open position.
  const openKeys = useMemo(
    () =>
      [...computePositions(positionTrades, calcs), ...computePositions(ledgerTrades, calcs)]
        .filter((p) => p.netQty !== 0)
        .map((p) => p.quoteKey),
    [positionTrades, ledgerTrades, calcs]
  );
  const feed = useLiveQuotes(openKeys, 5000);
  const livePrices = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, q] of Object.entries(feed.quotes)) if (q && q.ltp > 0) out[k] = q.ltp;
    return out;
  }, [feed.quotes]);

  const positions = useMemo(() => computePositions(positionTrades, calcs, livePrices), [positionTrades, calcs, livePrices]);
  // Interest accrues up to the To date (or today, if To is in the future).
  const interestAsOf = f.to && f.to < toDateStr(new Date()) ? f.to : toDateStr(new Date());
  // Interest (posted + accrued) from the client money ledger — same figures as the Ledger tab.
  const interest = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of data.accounts) {
      if (f.client && a.code !== f.client) continue;
      const L = computeClientLedger(a, data.trades, calcs, data.entries, data.settlements, interestAsOf);
      m.set(a.code, L.postedInterest + L.accruedInterest);
    }
    return m;
  }, [data.accounts, data.trades, data.entries, data.settlements, calcs, interestAsOf, f.client]);
  const deposits = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data.entries) {
      if (e.date > interestAsOf) continue;
      const signed = e.kind === "DEPOSIT" || e.kind === "JOURNAL_CR" ? e.amount : -e.amount;
      m.set(e.clientCode, (m.get(e.clientCode) ?? 0) + signed);
    }
    return m;
  }, [data.entries, interestAsOf]);
  const ledger = useMemo(() => {
    const accounts = data.accounts.filter((a) => !f.client || a.code === f.client);
    return computeLedger(accounts, computePositions(ledgerTrades, calcs, livePrices), interest, deposits);
  }, [data.accounts, ledgerTrades, calcs, livePrices, interest, deposits, f.client]);

  const pt = positions.reduce((s, p) => ({ realized: s.realized + p.realized, mtm: s.mtm + p.mtm }), { realized: 0, mtm: 0 });
  const lt = ledger.reduce(
    (s, r) => ({ opening: s.opening + r.opening, dep: s.dep + r.deposits, gross: s.gross + r.grossRealized, brk: s.brk + r.brokerage, int: s.int + r.interest, bal: s.bal + r.balance, unr: s.unr + r.unrealized, eq: s.eq + r.equity }),
    { opening: 0, dep: 0, gross: 0, brk: 0, int: 0, bal: 0, unr: 0, eq: 0 }
  );

  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadReportPdf({
        asOn: f.to,
        filters: { client: f.client, segment: f.segment, script: f.script.trim().toUpperCase() },
        nameOf, positions, positionTotals: pt, ledger, ledgerTotals: lt,
      });
    } finally {
      setPdfBusy(false);
    }
  };

  const exportPositions = () =>
    downloadCsv(
      `net_position_as_on_${f.to}.csv`,
      ["Client Code", "Client", "Segment", "Script", "Buy Qty", "Avg Buy Rate", "Sell Qty", "Avg Sell Rate", "Net Qty", "LTP", "Realized P&L", "MTM"],
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
          <Field label="As on" width={128}>
            <input type="date" className="tt-input" value={draft.to} onChange={(e) => set("to", e.target.value)} />
          </Field>
          <button type="submit" className="tt-btn tt-btn-blue">View</button>
          <button type="button" className="tt-btn tt-btn-blue" onClick={downloadPdf} disabled={pdfBusy || (!positions.length && !ledger.length)}>
            {pdfBusy ? "Preparing…" : "Download PDF"}
          </button>
          <button type="button" className="tt-btn tt-btn-save" onClick={exportPositions} disabled={!positions.length}>Export to Excel</button>
          <span className="tt-muted" style={{ marginLeft: "auto" }}>
            {feed.status === "live"
              ? <>MTM at <b className="pos">live price</b> (Angel One); <i>italic</i> = no live price, last traded rate</>
              : feed.status === "not-configured"
                ? "Live feed not configured — MTM at last traded rate"
                : <span className="neg">Live feed error: {feed.message} — showing last known prices</span>}
          </span>
        </form>
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Net Position <span className="tt-muted">— all trades up to {fmtDate(f.to)}</span>
          <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {positions.length}</span>
        </div>
        <div className="tt-grid-wrap" style={{ maxHeight: "46vh" }}>
          <table className="tt-grid">
            <thead>
              <tr>
                <th>Client</th><th>Segment</th><th>Script</th><th className="num">Total Buy Qty</th><th className="num">Avg Buy Rate</th>
                <th className="num">Total Sell Qty</th><th className="num">Avg Sell Rate</th><th className="num">Net Qty</th>
                <th className="num">LTP</th><th className="num">Realized P&amp;L</th><th className="num">MTM</th>
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
                  <td className="num" style={p.live ? undefined : { fontStyle: "italic", color: "#6b7686" }}>{fmt2(p.lastRate)}</td>
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
          Client Ledger <span className="tt-muted">— up to {f.to.split("-").reverse().join("-")} · Balance = Opening (+Cr / −Dr) + Deposits (net) + Realized P&amp;L − Brokerage − Interest · interest per Ledger tab</span>
        </div>
        <div className="tt-grid-wrap">
          <table className="tt-grid">
            <thead>
              <tr>
                <th>Code</th><th>Account Name</th><th>Type</th><th className="num">Opening</th><th className="num">Deposits (net)</th><th className="num">Realized P&amp;L</th>
                <th className="num">Brokerage</th><th className="num">Interest</th><th className="num">Current Balance</th><th className="num">Unrealized MTM</th>
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
                  <td className="num">{fmt2(r.deposits)}</td>
                  <td className="num"><PnL value={r.grossRealized} /></td>
                  <td className="num">{fmt2(r.brokerage)}</td>
                  <td className="num">{fmt2(r.interest)}</td>
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
                <td className="num">{fmt2(lt.dep)}</td>
                <td className="num"><PnL value={lt.gross} /></td>
                <td className="num">{fmt2(lt.brk)}</td>
                <td className="num">{fmt2(lt.int)}</td>
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
