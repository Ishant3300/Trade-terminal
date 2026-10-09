"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchSettlementPrices } from "@/app/actions";
import {
  addDays, computePositions, contractLabel, drCr, fmt0, fmt2, fmtDate, toDateStr, type TradeCalc,
} from "@/lib/terminal/engine";
import { SEGMENTS, type TerminalData } from "@/lib/terminal/types";
import { carryToSettlement, computeClientLedger } from "@/lib/terminal/ledger";
import { useLiveQuotes } from "./quotes";
import { downloadReportPdf, type ReportLedgerRow } from "./report-pdf";
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

  // Interest accrues up to the As on date (or today, if As on is in the future).
  const interestAsOf = f.to && f.to < toDateStr(new Date()) ? f.to : toDateStr(new Date());
  // NSE equity already settled is carried at the settlement price: P&L runs from the last settlement.
  const carried = useMemo(
    () => carryToSettlement(data.trades.filter((t) => !f.to || t.date <= f.to), calcs, data.settlements, interestAsOf),
    [data.trades, calcs, data.settlements, f.to, interestAsOf]
  );
  const since = carried.since;
  const positionTrades = useMemo(() => {
    const q = f.script.trim().toUpperCase();
    return carried.trades.filter((t) =>
      (!f.segment || t.segment === f.segment) &&
      (!q || contractLabel(t).includes(q)) &&
      (!f.client || t.clientCode === f.client)
    );
  }, [carried.trades, f]);
  // Client Ledger runs over every segment.
  const ledgerTrades = carried.trades;

  // Live prices only for contracts with an open position.
  const openKeys = useMemo(
    () =>
      [...computePositions(positionTrades, carried.calcs), ...computePositions(ledgerTrades, carried.calcs)]
        .filter((p) => p.netQty !== 0)
        .map((p) => p.quoteKey),
    [positionTrades, ledgerTrades, carried.calcs]
  );
  // As on today: live prices. As on a past date: NSE bhav close of that day
  // (or the last trading day before it) — live prices would be wrong there.
  const today = toDateStr(new Date());
  const isPast = !!f.to && f.to < today;
  const feed = useLiveQuotes(isPast ? [] : openKeys, 5000);
  const equityScripts = useMemo(
    () => [...new Set(openKeys.filter((k) => k.startsWith("NSEEQ|")).map((k) => k.slice(6)))].sort(),
    [openKeys]
  );
  const closeKey = `${f.to}|${equityScripts.join(",")}`;
  const [closes, setCloses] = useState<{ key: string; priceDate: string | null; prices: Record<string, number>; message?: string } | null>(null);
  useEffect(() => {
    if (!isPast || !equityScripts.length) return;
    let cancelled = false;
    fetchSettlementPrices(f.to, equityScripts)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) return setCloses({ key: closeKey, priceDate: null, prices: {}, message: res.error });
        const prices = Object.fromEntries(Object.entries(res.data.prices).map(([s, p]) => [s, p.price]));
        setCloses({ key: closeKey, priceDate: res.data.priceDate, prices, message: res.data.message });
      })
      .catch(() => !cancelled && setCloses({ key: closeKey, priceDate: null, prices: {}, message: "Could not load closing prices" }));
    return () => {
      cancelled = true;
    };
  }, [isPast, closeKey, f.to, equityScripts]);
  const closesReady = !isPast || !equityScripts.length || closes?.key === closeKey;
  const livePrices = useMemo(() => {
    const out: Record<string, number> = {};
    if (isPast) {
      if (closes?.key === closeKey) for (const [s, p] of Object.entries(closes.prices)) out[`NSEEQ|${s}`] = p;
      return out;
    }
    for (const [k, q] of Object.entries(feed.quotes)) if (q && q.ltp > 0) out[k] = q.ltp;
    return out;
  }, [isPast, closes, closeKey, feed.quotes]);

  const positions = useMemo(() => computePositions(positionTrades, carried.calcs, livePrices), [positionTrades, carried.calcs, livePrices]);

  // Client Ledger: client money after the last settlement (as in the Ledger tab) + what has
  // happened since — deposits, P&L (net of brokerage), interest accrued.
  const ledger = useMemo((): ReportLedgerRow[] => {
    const from = since?.settleDate ?? "";
    const all = computePositions(ledgerTrades, carried.calcs, livePrices);
    return data.accounts
      .filter((a) => !f.client || a.code === f.client)
      .map((account) => {
        const L = computeClientLedger(account, data.trades, calcs, data.entries, data.settlements, interestAsOf);
        const deposits = data.entries
          .filter((e) => e.clientCode === account.code && e.date >= from && e.date <= interestAsOf)
          .reduce((s, e) => s + (e.kind === "DEPOSIT" || e.kind === "JOURNAL_CR" ? e.amount : -e.amount), 0);
        let bf = L.money - deposits;
        let interest = L.accruedInterest;
        // Month-end As on: that month's bill is shown as P&L and interest, not yet in B/F.
        const billed = L.settlements.find((s) => s.periodTo === interestAsOf);
        if (billed) {
          bf -= billed.realized + billed.mtm - billed.interest;
          interest += billed.interest;
        }
        const pnl = all.filter((p) => p.clientCode === account.code).reduce((s, p) => s + p.realized + p.mtm, 0);
        return { account, bf, deposits, pnl, interest, equity: bf + deposits + pnl - interest };
      });
  }, [data.accounts, data.trades, data.entries, data.settlements, calcs, ledgerTrades, carried.calcs, livePrices, since, interestAsOf, f.client]);

  const pt = positions.reduce((s, p) => ({ realized: s.realized + p.realized, mtm: s.mtm + p.mtm }), { realized: 0, mtm: 0 });
  const lt = ledger.reduce(
    (s, r) => ({ bf: s.bf + r.bf, dep: s.dep + r.deposits, pnl: s.pnl + r.pnl, int: s.int + r.interest, eq: s.eq + r.equity }),
    { bf: 0, dep: 0, pnl: 0, int: 0, eq: 0 }
  );
  const sinceNote = since ? `NSE equity from settlement ${fmtDate(addDays(since.settleDate, -1))}, carried at settle price` : "";

  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadReportPdf({
        asOn: f.to,
        priceNote: isPast
          ? `MTM at NSE close ${closes?.priceDate ? fmtDate(closes.priceDate) : fmtDate(f.to)} (bhav)`
          : "MTM at live price when generated",
        filters: { client: f.client, segment: f.segment, script: f.script.trim().toUpperCase() },
        sinceNote, nameOf, positions, positionTotals: pt, ledger, ledgerTotals: lt,
      });
    } finally {
      setPdfBusy(false);
    }
  };

  const exportPositions = () =>
    downloadCsv(
      `net_position_as_on_${f.to}.csv`,
      ["Client Code", "Client", "Segment", "Script", "Buy Qty", "Avg Buy Rate", "Sell Qty", "Avg Sell Rate", "Net Qty", "LTP", "P&L"],
      positions.map((p) => [p.clientCode, nameOf.get(p.clientCode) ?? "", p.segment, p.label, p.buyQty, p.avgBuy.toFixed(4), p.sellQty, p.avgSell.toFixed(4), p.netQty, p.lastRate.toFixed(2), (p.realized + p.mtm).toFixed(2)])
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
          <button type="button" className="tt-btn tt-btn-blue" onClick={downloadPdf} disabled={pdfBusy || !closesReady || (!positions.length && !ledger.length)}>
            {pdfBusy ? "Preparing…" : "Download PDF"}
          </button>
          <button type="button" className="tt-btn tt-btn-save" onClick={exportPositions} disabled={!positions.length}>Export to Excel</button>
          <span className="tt-muted" style={{ marginLeft: "auto" }}>
            {isPast
              ? !closesReady
                ? "Loading NSE closing prices…"
                : <>MTM at <b className="pos">NSE close {closes?.priceDate ? fmtDate(closes.priceDate) : ""}</b> (bhav); <i>italic</i> = no close price, last traded rate{closes?.message ? ` · ${closes.message}` : ""}</>
              : feed.status === "live"
              ? <>MTM at <b className="pos">live price</b> (Angel One); <i>italic</i> = no live price, last traded rate</>
              : feed.status === "not-configured"
                ? "Live feed not configured — MTM at last traded rate"
                : <span className="neg">Live feed error: {feed.message} — showing last known prices</span>}
          </span>
        </form>
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Net Position <span className="tt-muted">— all trades up to {fmtDate(f.to)}{sinceNote && ` · ${sinceNote}`}</span>
          <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {positions.length}</span>
        </div>
        <div className="tt-grid-wrap" style={{ maxHeight: "46vh" }}>
          <table className="tt-grid">
            <thead>
              <tr>
                <th>Client</th><th>Segment</th><th>Script</th><th className="num">Total Buy Qty</th><th className="num">Avg Buy Rate</th>
                <th className="num">Total Sell Qty</th><th className="num">Avg Sell Rate</th><th className="num">Net Qty</th>
                <th className="num">LTP</th><th className="num">P&amp;L</th>
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
                  <td className="num"><PnL value={p.realized + p.mtm} /></td>
                </tr>
              ))}
              {positions.length === 0 && <tr><td colSpan={10} className="empty">No positions for the selected filter.</td></tr>}
            </tbody>
            {positions.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={9}>Total (net of brokerage)</td>
                  <td className="num"><PnL value={pt.realized + pt.mtm} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Client Ledger <span className="tt-muted">— up to {f.to.split("-").reverse().join("-")} · Net Equity = Balance B/F (+Cr / −Dr) + Deposits (net) + P&amp;L − Interest · {since ? <>B/F = client money after settlement {fmtDate(addDays(since.settleDate, -1))}; deposits, P&amp;L and interest since then</> : "B/F = opening balance"} · P&amp;L includes open positions, net of brokerage</span>
        </div>
        <div className="tt-grid-wrap">
          <table className="tt-grid">
            <thead>
              <tr>
                <th>Code</th><th>Account Name</th><th>Type</th><th className="num">Balance B/F</th><th className="num">Deposits (net)</th><th className="num">P&amp;L</th>
                <th className="num">Interest</th>
                <th className="num">Net Equity</th><th className="num">Int. %</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((r) => (
                <tr key={r.account.code}>
                  <td style={{ fontWeight: 600 }}>{r.account.code}</td>
                  <td>{r.account.name}</td>
                  <td>{r.account.type}</td>
                  <td className={`num ${r.bf < 0 ? "neg" : ""}`}>{drCr(r.bf)}</td>
                  <td className="num">{fmt2(r.deposits)}</td>
                  <td className="num"><PnL value={r.pnl} /></td>
                  <td className="num">{fmt2(r.interest)}</td>
                  <td className={`num ${r.equity < 0 ? "neg" : "pos"}`} style={{ fontWeight: 700 }}>{drCr(r.equity)}</td>
                  <td className="num">{r.account.interestPct ? r.account.interestPct.toFixed(2) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total</td>
                <td className="num">{drCr(lt.bf)}</td>
                <td className="num">{fmt2(lt.dep)}</td>
                <td className="num"><PnL value={lt.pnl} /></td>
                <td className="num">{fmt2(lt.int)}</td>
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
