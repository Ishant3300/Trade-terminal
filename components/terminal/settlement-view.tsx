"use client";

import { useMemo, useState } from "react";
import { fetchNcdexPrices, fetchSettlementPrices } from "@/app/actions";
import { addDays, fmt0, fmt2, fmtDate, parseContract, toDateStr, type TradeCalc } from "@/lib/terminal/engine";
import { buildEquityLots, computeClientLedger, ncdexBill, ncdexSettle } from "@/lib/terminal/ledger";
import { NcdexBillCard } from "./ncdex-bill";
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

type Props = { data: TerminalData; calcs: Map<number, TradeCalc>; actions: TerminalActions };

export function SettlementView(props: Props) {
  const [kind, setKind] = useState<"NSEEQ" | "NCDEX">("NSEEQ");
  const { data, actions } = props;
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const remove = async (id: number, label: string) => {
    if (!confirm(`Delete (undo) the settlement of ${label}? Its postings will be removed and recalculated.`)) return;
    const res = await actions.deleteSettlement(id);
    setMessage(res.ok ? { ok: true, text: `Settlement ${label} deleted` } : { ok: false, text: `Not deleted: ${res.error}` });
  };
  return (
    <div className="tt-page">
      <div className="tt-card">
        <div className="tt-card-b flex items-center gap-3">
          <span style={{ fontWeight: 600 }}>Settlement type</span>
          <label className={`tt-check${kind === "NSEEQ" ? " on" : ""}`}>
            <input type="radio" checked={kind === "NSEEQ"} onChange={() => setKind("NSEEQ")} /> NSE Equity — Monthly
          </label>
          <label className={`tt-check${kind === "NCDEX" ? " on" : ""}`}>
            <input type="radio" checked={kind === "NCDEX"} onChange={() => setKind("NCDEX")} /> NCDEX — Weekly (Saturday)
          </label>
        </div>
      </div>
      {kind === "NSEEQ" ? <MonthlySettlement {...props} /> : <WeeklyNcdexSettlement {...props} />}

      <div className="tt-card">
        <div className="tt-card-h">Settlements <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {data.settlements.length}</span></div>
        {message && <div className="tt-status"><span className={message.ok ? "ok" : "bad"}>{message.text}</span></div>}
        <div className="tt-grid-wrap" style={{ maxHeight: "25vh" }}>
          <table className="tt-grid">
            <thead><tr><th>Type</th><th>Billing date</th><th>Price date</th><th className="num">Prices</th><th className="ctr">Delete</th></tr></thead>
            <tbody>
              {[...data.settlements].sort((a, b) => b.settleDate.localeCompare(a.settleDate) || a.segment.localeCompare(b.segment)).map((s) => (
                <tr key={s.id}>
                  <td>{s.segment === "NCDEX" ? "NCDEX weekly" : "NSE equity monthly"}</td>
                  <td>{fmtDate(addDays(s.settleDate, -1))}</td>
                  <td>{fmtDate(s.priceDate)}</td>
                  <td className="num">{Object.keys(s.prices).length}</td>
                  <td className="ctr"><button type="button" className="tt-btn tt-btn-red tt-btn-xs" onClick={() => remove(s.id, `${s.segment === "NCDEX" ? "NCDEX week" : "NSE month"} ${fmtDate(addDays(s.settleDate, -1))}`)}>Delete</button></td>
                </tr>
              ))}
              {!data.settlements.length && <tr><td colSpan={5} className="empty">No settlements yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MonthlySettlement({ data, calcs, actions }: Props) {
  const today = toDateStr(new Date());
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const t of data.trades) if (t.segment === "NSEEQ") set.add(t.date.slice(0, 7));
    return [...set].filter((m) => monthEnd(m) <= today) // the billing day itself counts.sort().reverse();
  }, [data.trades, today]);
  const [month, setMonth] = useState(months[0] ?? "");
  const end = month ? monthEnd(month) : "";
  const settleDate = end ? addDays(end, 1) : "";
  const existing = data.settlements.find((s) => s.segment !== "NCDEX" && s.settleDate === settleDate);

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
      segment: "NSEEQ", settleDate, priceDate,
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
    <>
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

    </>
  );
}

/** Friday of the Mon–Sun week containing `date`. */
const fridayOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const offset = (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday = 0
  return addDays(date, 4 - offset);
};

function WeeklyNcdexSettlement({ data, calcs, actions }: Props) {
  const today = toDateStr(new Date());
  const ncdexTrades = useMemo(() => data.trades.filter((t) => t.segment === "NCDEX"), [data.trades]);
  // Every week from the first NCDEX trade up to the last Friday on or before today.
  const fridays = useMemo(() => {
    const first = ncdexTrades.map((t) => t.date).sort()[0];
    const out: string[] = [];
    if (first) for (let f = fridayOf(first); f <= today; f = addDays(f, 7)) out.push(f);
    return out.reverse();
  }, [ncdexTrades, today]);
  const [friday, setFriday] = useState(fridays[0] ?? "");
  const monday = friday ? addDays(friday, -4) : "";
  const settleDate = friday ? addDays(friday, 1) : "";
  const existing = data.settlements.find((s) => s.segment === "NCDEX" && s.settleDate === settleDate);

  // Contracts needing a settlement price: open (long or short) at the end of the Friday, per client,
  // not already closed out by an earlier weekly settlement (expired contracts).
  const open = useMemo(() => {
    const byContract = new Map<string, { long: number; short: number; clients: Set<string> }>();
    if (!friday) return byContract;
    const earlier = data.settlements.filter((s) => s.segment === "NCDEX" && s.settleDate < settleDate);
    const byClient = new Map<string, typeof ncdexTrades>();
    for (const t of ncdexTrades) if (t.date <= friday) byClient.set(t.clientCode, [...(byClient.get(t.clientCode) ?? []), t]);
    for (const [client, list] of byClient) {
      const done = ncdexSettle(list, calcs, earlier).settled;
      const net = new Map<string, number>();
      for (const t of list) net.set(t.script, (net.get(t.script) ?? 0) + (t.side === "B" ? t.qty : -t.qty));
      for (const [c, q] of net) {
        const exp = parseContract(c)?.expiry ?? "9999-12-31";
        if (!q || (exp < monday && done.get(c)?.qty === 0)) continue;
        const x = byContract.get(c) ?? { long: 0, short: 0, clients: new Set<string>() };
        if (q > 0) x.long += q;
        else x.short -= q;
        x.clients.add(client);
        byContract.set(c, x);
      }
    }
    return byContract;
  }, [ncdexTrades, data.settlements, calcs, friday, monday, settleDate]);
  const contracts = [...open.keys()].sort();

  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [priceDate, setPriceDate] = useState("");
  const [prices, setPrices] = useState<Record<string, PriceRow>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (settleDate && loadedFor !== settleDate) {
    setLoadedFor(settleDate);
    setPriceDate(existing?.priceDate ?? friday);
    setPrices(Object.fromEntries(Object.entries(existing?.prices ?? {}).map(([s, p]) => [s, { price: String(p), source: existing!.sources[s] ?? "" }])));
    setMessage(null);
  }

  const fetchPrices = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetchNcdexPrices(friday, contracts);
      if (!res.ok) return setMessage({ ok: false, text: res.error });
      const r = res.data;
      if (r.priceDate) setPriceDate(r.priceDate);
      setPrices((old) => {
        const next = { ...old };
        for (const [c, p] of Object.entries(r.prices)) next[c] = { price: String(p.price), source: p.source };
        return next;
      });
      setMessage({
        ok: !r.missing.length,
        text: `NCDEX bhav ${r.priceDate ? fmtDate(r.priceDate) : "?"}: ${Object.keys(r.prices).length} of ${contracts.length} settlement prices filled` +
          (r.missing.length ? ` — enter manually: ${r.missing.join(", ")}` : "") + (r.message ? ` · ${r.message}` : ""),
      });
    } catch {
      setMessage({ ok: false, text: "Connection problem — please try again" });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const missing = contracts.filter((c) => !(Number(prices[c]?.price) > 0));
    if (missing.length) return setMessage({ ok: false, text: `Enter a settlement price for: ${missing.join(", ")}` });
    if (!priceDate || priceDate > friday) return setMessage({ ok: false, text: `Price date must be on or before ${fmtDate(friday)}` });
    setBusy(true);
    const res = await actions.saveSettlement({
      segment: "NCDEX", settleDate, priceDate,
      prices: Object.fromEntries(contracts.map((c) => [c, { price: Number(prices[c].price), source: prices[c].source || "Manual" }])),
    });
    setBusy(false);
    setMessage(res.ok ? { ok: true, text: `NCDEX week ${fmtDate(monday)} – ${fmtDate(friday)} settled — postings below` } : { ok: false, text: `Not saved: ${res.error}` });
  };

  const [billFor, setBillFor] = useState<string | null>(null);
  const bill = useMemo(() => {
    const account = data.accounts.find((a) => a.code === billFor);
    if (!existing || !account) return null;
    const mine = data.trades.filter((t) => t.clientCode === account.code);
    const L = computeClientLedger(account, data.trades, calcs, data.entries, data.settlements, friday);
    return { account, bill: ncdexBill(mine, calcs, data.settlements, existing), moneyAfter: L.money };
  }, [billFor, existing, data.accounts, data.trades, data.entries, data.settlements, calcs, friday]);

  const postings = useMemo(() => {
    if (!existing) return [];
    return data.accounts
      .map((a) => {
        const L = computeClientLedger(a, data.trades, calcs, data.entries, data.settlements, friday);
        const p = L.ncdexPostings.find((x) => x.settlement.id === existing.id);
        return p ? { account: a, p, money: L.money } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }, [existing, data.accounts, data.trades, data.entries, data.settlements, calcs, friday]);

  return (
    <>
      <div className="tt-card">
        <div className="tt-card-h">
          NCDEX Weekly Settlement <span className="tt-muted">— run on Saturday: P&amp;L and MTM at Friday&apos;s NCDEX settlement price, open positions carried forward at that price (no brokerage, no interest)</span>
        </div>
        <div className="tt-card-b flex flex-wrap items-end gap-x-3 gap-y-1">
          <Field label="Week (Mon – Fri)" width={210}>
            <select className="tt-select" value={friday} onChange={(e) => setFriday(e.target.value)}>
              {fridays.map((f) => <option key={f} value={f}>{fmtDate(addDays(f, -4))} – {fmtDate(f)}</option>)}
            </select>
          </Field>
          <Field label="Billing date" width={128}>
            <input className="tt-input" readOnly tabIndex={-1} value={friday ? fmtDate(friday) : ""} />
          </Field>
          <Field label="Bhav (price) date" width={140}>
            <input type="date" className="tt-input" value={priceDate} max={friday} onChange={(e) => setPriceDate(e.target.value)} />
          </Field>
          <button type="button" className="tt-btn tt-btn-blue" onClick={fetchPrices} disabled={busy || !contracts.length}>
            {busy ? "Working…" : "Fetch NCDEX settlement prices"}
          </button>
          <button type="button" className="tt-btn tt-btn-save" onClick={save} disabled={busy || !friday}>
            {existing ? "Update settlement" : "Save settlement"}
          </button>
          <span className="tt-muted" style={{ marginLeft: "auto" }}>
            {existing ? `Settled — saved prices loaded (bhav ${fmtDate(existing.priceDate)})` : "Not settled yet"}
          </span>
        </div>
        {message && <div className="tt-status"><span className={message.ok ? "ok" : "bad"}>{message.text}</span></div>}
        <div className="tt-grid-wrap" style={{ maxHeight: "40vh" }}>
          <table className="tt-grid">
            <thead>
              <tr><th>Contract</th><th className="num">Long Qty</th><th className="num">Short Qty</th><th className="num">Clients</th><th className="num" style={{ width: 140 }}>Settlement Price</th><th>Source</th></tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c}>
                  <td style={{ fontWeight: 600 }}>{c}</td>
                  <td className="num b-txt">{open.get(c)!.long ? fmt0(open.get(c)!.long) : ""}</td>
                  <td className="num s-txt">{open.get(c)!.short ? fmt0(open.get(c)!.short) : ""}</td>
                  <td className="num">{open.get(c)!.clients.size}</td>
                  <td className="num">
                    <input className="tt-input num" style={{ width: 120 }} inputMode="decimal" value={prices[c]?.price ?? ""}
                      onChange={(e) => setPrices((p) => ({ ...p, [c]: { price: e.target.value.replace(/[^\d.]/g, ""), source: "Manual" } }))} />
                  </td>
                  <td className="tt-muted">{prices[c]?.source ?? ""}</td>
                </tr>
              ))}
              {!contracts.length && <tr><td colSpan={6} className="empty">{friday ? "No open NCDEX positions at the end of this week — saving still posts the week's closed-trade P&L." : "No NCDEX trades yet."}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {existing && (
        <div className="tt-card">
          <div className="tt-card-h">Postings on {fmtDate(friday)} <span className="tt-muted">— per client: NCDEX P&amp;L + MTM for the week, net of brokerage</span></div>
          <div className="tt-grid-wrap">
            <table className="tt-grid">
              <thead><tr><th>Client</th><th className="num">P&amp;L + MTM</th><th className="num">Client Money after</th><th>Missing prices</th><th className="ctr">Bill</th></tr></thead>
              <tbody>
                {postings.map(({ account, p, money }) => (
                  <tr key={account.code}>
                    <td>{account.code} - {account.name}</td>
                    <td className="num"><PnL value={p.amount} /></td>
                    <td className={`num ${money < 0 ? "neg" : "pos"}`}>{fmt2(Math.abs(money))} {money < 0 ? "Dr" : "Cr"}</td>
                    <td className="bad">{p.missing.join(", ")}</td>
                    <td className="ctr"><button type="button" className="tt-btn tt-btn-blue tt-btn-xs" onClick={() => setBillFor(account.code)}>Bill</button></td>
                  </tr>
                ))}
                {!postings.length && <tr><td colSpan={5} className="empty">Nothing posted for this week.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {existing && bill && (
        <NcdexBillCard account={bill.account} bill={bill.bill} priceDate={existing.priceDate} moneyAfter={bill.moneyAfter} onClose={() => setBillFor(null)} />
      )}
    </>
  );
}
