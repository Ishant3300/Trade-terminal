"use client";

import { useMemo, useState } from "react";
import { fetchSettlementPrices } from "@/app/actions";
import { addDays, fmt0, fmt2, fmtDate, toDateStr, type TradeCalc } from "@/lib/terminal/engine";
import { buildEquityLots, computeClientLedger } from "@/lib/terminal/ledger";
import type { TerminalData } from "@/lib/terminal/types";
import type { TerminalActions } from "./store";
import { Field, PnL } from "./ui";

const monthEnd = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return toDateStr(new Date(y, mo, 0));
};
const monthLabel = (m: string) =>
  new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

type PriceRow = { price: string; source: string };

export function SettlementView({ data, calcs, actions }: { data: TerminalData; calcs: Map<number, TradeCalc>; actions: TerminalActions }) {
  const today = toDateStr(new Date());
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const t of data.trades) if (t.segment === "NSEEQ") set.add(t.date.slice(0, 7));
    return [...set].filter((m) => monthEnd(m) < today).sort().reverse();
  }, [data.trades, today]);
  const [month, setMonth] = useState(months[0] ?? "");
  const end = month ? monthEnd(month) : "";
  const settleDate = end ? addDays(end, 1) : "";
  const existing = data.settlements.find((s) => s.settleDate === settleDate);

  // Open NSE equity positions at month end, all clients.
  const open = useMemo(() => {
    const byScript = new Map<string, { qty: number; clients: Set<string> }>();
    if (!end) return byScript;
    for (const a of data.accounts) {
      const { portions } = buildEquityLots(data.trades.filter((t) => t.clientCode === a.code && t.date <= end), calcs);
      for (const p of portions) {
        if (p.buyDate > end || (p.closeDate !== null && p.closeDate <= end)) continue;
        const x = byScript.get(p.script) ?? { qty: 0, clients: new Set<string>() };
        x.qty += p.qty;
        x.clients.add(a.code);
        byScript.set(p.script, x);
      }
    }
    return byScript;
  }, [data.accounts, data.trades, calcs, end]);
  const scripts = [...open.keys()].sort();

  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [priceDate, setPriceDate] = useState("");
  const [prices, setPrices] = useState<Record<string, PriceRow>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Load an existing settlement's prices into the editor when switching month.
  if (settleDate && loadedFor !== settleDate) {
    setLoadedFor(settleDate);
    setPriceDate(existing?.priceDate ?? end);
    setPrices(Object.fromEntries(Object.entries(existing?.prices ?? {}).map(([s, p]) => [s, { price: String(p), source: existing!.sources[s] ?? "" }])));
    setMessage(null);
  }

  const fetchPrices = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetchSettlementPrices(end, scripts);
      if (!res.ok) return setMessage({ ok: false, text: res.error });
      const r = res.data;
      if (r.priceDate) setPriceDate(r.priceDate);
      setPrices((old) => {
        const next = { ...old };
        for (const [s, p] of Object.entries(r.prices)) next[s] = { price: String(p.price), source: p.source };
        return next;
      });
      setMessage({
        ok: !r.missing.length,
        text: `Bhav date ${r.priceDate ? fmtDate(r.priceDate) : "?"}: ${Object.keys(r.prices).length} of ${scripts.length} prices filled` +
          (r.missing.length ? ` — enter manually: ${r.missing.join(", ")}` : "") + (r.message ? ` · ${r.message}` : ""),
      });
    } catch {
      setMessage({ ok: false, text: "Connection problem — please try again" });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const missing = scripts.filter((s) => !(Number(prices[s]?.price) > 0));
    if (missing.length) return setMessage({ ok: false, text: `Enter a price for: ${missing.join(", ")}` });
    if (!priceDate || priceDate > end) return setMessage({ ok: false, text: `Price date must be on or before ${fmtDate(end)}` });
    setBusy(true);
    const res = await actions.saveSettlement({
      settleDate, priceDate,
      prices: Object.fromEntries(scripts.map((s) => [s, { price: Number(prices[s].price), source: prices[s].source || "Manual" }])),
    });
    setBusy(false);
    setMessage(res.ok ? { ok: true, text: `Settlement for ${fmtDate(end)} saved — postings below` } : { ok: false, text: `Not saved: ${res.error}` });
  };

  const remove = async (id: number, date: string) => {
    if (!confirm(`Delete (undo) the settlement of ${fmtDate(date)}? Its P&L, MTM and interest postings will be removed and recalculated.`)) return;
    const res = await actions.deleteSettlement(id);
    setMessage(res.ok ? { ok: true, text: `Settlement ${fmtDate(date)} deleted` } : { ok: false, text: `Not deleted: ${res.error}` });
    if (res.ok && date === end) setLoadedFor(null);
  };

  // What the saved settlement posts to each client.
  const postings = useMemo(() => {
    if (!existing) return [];
    return data.accounts
      .map((a) => {
        const L = computeClientLedger(a, data.trades, calcs, data.entries, data.settlements, end);
        const s = L.settlements.find((x) => x.settlement.id === existing.id);
        return s ? { account: a, s, money: L.money, funded: L.funded } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x && (!!x.s.realized || !!x.s.mtm || !!x.s.interest));
  }, [existing, data.accounts, data.trades, data.entries, data.settlements, calcs, end]);

  return (
    <div className="tt-page">
      {data.ledgerSetupNeeded && (
        <div className="tt-status" style={{ background: "#fde8e7" }}>
          <span className="bad">Settlement tables are not created yet — run supabase/schema.sql in Supabase (SQL Editor → Run) before saving a settlement.</span>
        </div>
      )}

      <div className="tt-card">
        <div className="tt-card-h">
          Monthly Settlement <span className="tt-muted">— NSE equity open positions valued at bhav close; bills the month&apos;s P&amp;L, MTM and interest on its last day</span>
        </div>
        <div className="tt-card-b flex flex-wrap items-end gap-x-3 gap-y-1">
          <Field label="Month" width={170}>
            <select className="tt-select" value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </Field>
          <Field label="Billing date" width={128}>
            <input className="tt-input" readOnly tabIndex={-1} value={end ? fmtDate(end) : ""} />
          </Field>
          <Field label="Bhav (price) date" width={140}>
            <input type="date" className="tt-input" value={priceDate} max={end} onChange={(e) => setPriceDate(e.target.value)} />
          </Field>
          <button type="button" className="tt-btn tt-btn-blue" onClick={fetchPrices} disabled={busy || !scripts.length}>
            {busy ? "Working…" : "Fetch bhav prices"}
          </button>
          <button type="button" className="tt-btn tt-btn-save" onClick={save} disabled={busy || !month}>
            {existing ? "Update settlement" : "Save settlement"}
          </button>
          {existing && (
            <button type="button" className="tt-btn tt-btn-red" onClick={() => remove(existing.id, end)} disabled={busy}>
              Delete settlement
            </button>
          )}
          <span className="tt-muted" style={{ marginLeft: "auto" }}>
            {existing ? `Settled — saved prices loaded (bhav ${fmtDate(existing.priceDate)})` : "Not settled yet"}
          </span>
        </div>
        {message && <div className="tt-status"><span className={message.ok ? "ok" : "bad"}>{message.text}</span></div>}
        <div className="tt-grid-wrap" style={{ maxHeight: "40vh" }}>
          <table className="tt-grid">
            <thead>
              <tr><th>Script</th><th className="num">Open Qty (all clients)</th><th className="num">Clients</th><th className="num" style={{ width: 140 }}>Bhav Close</th><th>Source</th></tr>
            </thead>
            <tbody>
              {scripts.map((s) => (
                <tr key={s}>
                  <td style={{ fontWeight: 600 }}>{s}</td>
                  <td className="num">{fmt0(open.get(s)!.qty)}</td>
                  <td className="num">{open.get(s)!.clients.size}</td>
                  <td className="num">
                    <input className="tt-input num" style={{ width: 120 }} inputMode="decimal" value={prices[s]?.price ?? ""}
                      onChange={(e) => setPrices((p) => ({ ...p, [s]: { price: e.target.value.replace(/[^\d.]/g, ""), source: "Manual" } }))} />
                  </td>
                  <td className="tt-muted">{prices[s]?.source ?? ""}</td>
                </tr>
              ))}
              {!scripts.length && <tr><td colSpan={5} className="empty">{month ? `No open NSE equity positions at the end of ${monthLabel(month)}.` : "No completed month with equity trades yet."}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {existing && (
        <div className="tt-card">
          <div className="tt-card-h">Postings on {fmtDate(end)} <span className="tt-muted">— per client, from the saved prices</span></div>
          <div className="tt-grid-wrap">
            <table className="tt-grid">
              <thead>
                <tr><th>Client</th><th>Interest period</th><th className="num">Trade P&amp;L</th><th className="num">MTM @ bhav</th><th className="num">Interest</th><th className="num">Client Money after</th><th className="num">Funded now</th><th>Missing prices</th></tr>
              </thead>
              <tbody>
                {postings.map(({ account, s, money, funded }) => (
                  <tr key={account.code}>
                    <td>{account.code} - {account.name}</td>
                    <td>{fmtDate(s.periodFrom)} – {fmtDate(s.periodTo)}</td>
                    <td className="num"><PnL value={s.realized} /></td>
                    <td className="num"><PnL value={s.mtm} /></td>
                    <td className="num">{fmt2(s.interest)}</td>
                    <td className={`num ${money < 0 ? "neg" : "pos"}`}>{fmt2(Math.abs(money))} {money < 0 ? "Dr" : "Cr"}</td>
                    <td className="num">{fmt2(funded)}</td>
                    <td className="bad">{s.missingPrices.join(", ")}</td>
                  </tr>
                ))}
                {!postings.length && <tr><td colSpan={8} className="empty">Nothing posted for this settlement.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="tt-card">
        <div className="tt-card-h">Settlements <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {data.settlements.length}</span></div>
        <div className="tt-grid-wrap" style={{ maxHeight: "25vh" }}>
          <table className="tt-grid">
            <thead><tr><th>Billing date</th><th>Bhav date</th><th className="num">Scripts priced</th><th className="ctr">Delete</th></tr></thead>
            <tbody>
              {[...data.settlements].sort((a, b) => b.settleDate.localeCompare(a.settleDate)).map((s) => (
                <tr key={s.id}>
                  <td>{fmtDate(addDays(s.settleDate, -1))}</td>
                  <td>{fmtDate(s.priceDate)}</td>
                  <td className="num">{Object.keys(s.prices).length}</td>
                  <td className="ctr"><button type="button" className="tt-btn tt-btn-red tt-btn-xs" onClick={() => remove(s.id, addDays(s.settleDate, -1))}>Delete</button></td>
                </tr>
              ))}
              {!data.settlements.length && <tr><td colSpan={4} className="empty">No settlements yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
