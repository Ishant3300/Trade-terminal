"use client";

import { useMemo, useState } from "react";
import { fmt2, fmtDate, toDateStr, type TradeCalc } from "@/lib/terminal/engine";
import { computeClientLedger, type StatementRow } from "@/lib/terminal/ledger";
import type { LedgerEntry, LedgerKind, TerminalData } from "@/lib/terminal/types";
import type { TerminalActions } from "./store";
import { downloadLedgerPdf } from "./ledger-pdf";
import { downloadCsv, Field, Suggest } from "./ui";

const KIND_LABEL: Record<LedgerKind, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal / Payout",
  JOURNAL_CR: "Journal Cr",
  JOURNAL_DR: "Journal Dr",
};
const CREDIT_KINDS: LedgerKind[] = ["DEPOSIT", "JOURNAL_CR"];

/** "1,23,456.00 Cr" for client money (Cr = client's favour). */
const crDr = (n: number) => (Math.abs(n) < 0.005 ? "0.00" : `${fmt2(Math.abs(n))} ${n >= 0 ? "Cr" : "Dr"}`);
const monthOf = (d: string) => d.slice(0, 7);
const monthEnd = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return toDateStr(new Date(y, mo, 0));
};
const monthLabel = (m: string) =>
  new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });

interface Form {
  id?: number;
  clientCode: string;
  date: string;
  kind: LedgerKind;
  amount: string;
  narration: string;
}
const emptyForm = (clientCode = ""): Form => ({ clientCode, date: toDateStr(new Date()), kind: "DEPOSIT", amount: "", narration: "" });

export function LedgerView({ data, calcs, actions }: { data: TerminalData; calcs: Map<number, TradeCalc>; actions: TerminalActions }) {
  const today = toDateStr(new Date());
  const [form, setForm] = useState<Form>(() => emptyForm());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [client, setClient] = useState(data.accounts[0]?.code ?? "");
  const [month, setMonth] = useState(monthOf(today));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const nameOf = useMemo(() => new Map(data.accounts.map((a) => [a.code, a.name])), [data.accounts]);
  const formAccount = data.accounts.find((a) => a.code === form.clientCode);

  // ---- Entries -------------------------------------------------------------------
  const save = async () => {
    const amount = Number(form.amount);
    if (!formAccount) return setMessage({ ok: false, text: "Select a valid client" });
    if (!(amount > 0)) return setMessage({ ok: false, text: "Enter an amount" });
    const res = await actions.saveLedgerEntry({
      id: form.id, clientCode: formAccount.code, date: form.date, kind: form.kind, amount, narration: form.narration.trim(),
    });
    if (!res.ok) return setMessage({ ok: false, text: `Not saved: ${res.error}` });
    setMessage({ ok: true, text: `${form.id ? "Updated" : "Saved"}: ${KIND_LABEL[form.kind]} ₹${fmt2(amount)} — ${formAccount.code} ${formAccount.name} on ${fmtDate(form.date)}` });
    setClient(formAccount.code);
    setMonth(monthOf(form.date));
    setForm(emptyForm(formAccount.code));
  };

  const edit = (e: LedgerEntry) => {
    setForm({ id: e.id, clientCode: e.clientCode, date: e.date, kind: e.kind, amount: String(e.amount), narration: e.narration });
    setMessage(null);
  };

  const remove = async (e: LedgerEntry) => {
    if (!confirm(`Delete ${KIND_LABEL[e.kind]} ₹${fmt2(e.amount)} for ${e.clientCode} on ${fmtDate(e.date)}?`)) return;
    const res = await actions.deleteLedgerEntry(e.id);
    setMessage(res.ok ? { ok: true, text: "Entry deleted" } : { ok: false, text: `Not deleted: ${res.error}` });
    if (form.id === e.id) setForm(emptyForm(form.clientCode));
  };

  const entries = data.entries
    .filter((e) => !client || e.clientCode === client)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  // ---- Statement -----------------------------------------------------------------
  const account = data.accounts.find((a) => a.code === client);
  const asOf = monthEnd(month) < today ? monthEnd(month) : today;
  const ledger = useMemo(
    () => (account ? computeClientLedger(account, data.trades, calcs, data.entries, data.settlements, asOf) : null),
    [account, data.trades, calcs, data.entries, data.settlements, asOf]
  );
  const rows: StatementRow[] = (ledger?.rows ?? []).filter((r) => monthOf(r.date) === month);
  const monthInterest = rows.reduce((s, r) => s + r.interest, 0);
  const months = useMemo(() => {
    const set = new Set<string>([monthOf(today)]);
    for (const t of data.trades) if (t.segment === "NSEEQ") set.add(monthOf(t.date));
    for (const e of data.entries) set.add(monthOf(e.date));
    return [...set].sort().reverse();
  }, [data.trades, data.entries, today]);
  const settledThisMonth = ledger?.settlements.find((s) => monthOf(s.periodTo) === month);

  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async () => {
    if (!account || !ledger) return;
    setPdfBusy(true);
    try {
      await downloadLedgerPdf({
        account, monthLabel: monthLabel(month), periodFrom: `${month}-01`, periodTo: asOf, rows,
        summary: {
          money: ledger.money, margin: ledger.margin, funded: ledger.funded, monthInterest,
          monthInterestNote: settledThisMonth ? `billed ${fmtDate(settledThisMonth.periodTo)}` : "accrued, billed at month-end",
          postedInterest: ledger.postedInterest, pendingPnl: ledger.pendingPnl,
        },
      });
    } finally {
      setPdfBusy(false);
    }
  };

  const exportStatement = () =>
    downloadCsv(
      `ledger_${client}_${month}.csv`,
      ["Date", "Particulars", "Debit", "Credit", "Client Money", "Margin Used", "Funded", "Days", "Interest"],
      rows.map((r) => [fmtDate(r.date), r.particulars, r.debit.toFixed(2), r.credit.toFixed(2), crDr(r.money), r.margin.toFixed(2), r.funded.toFixed(2), r.days, r.interest.toFixed(2)])
    );

  return (
    <div className="tt-page">
      {data.ledgerSetupNeeded && (
        <div className="tt-status" style={{ background: "#fde8e7" }}>
          <span className="bad">Ledger tables are not created yet — run supabase/schema.sql in Supabase (SQL Editor → Run). Statements still work; entries can&apos;t be saved until then.</span>
        </div>
      )}

      <div className="tt-card">
        <div className="tt-card-h">Ledger Entry{form.id != null && <span className="tt-muted">— editing #{form.id}</span>}</div>
        <div className="tt-card-b flex flex-wrap items-end gap-x-3 gap-y-1">
          <Field label="Client" required>
            <Suggest value={form.clientCode} onChange={(v) => set("clientCode", v)} width={180}
              options={data.accounts.map((a) => ({ value: a.code, label: `${a.code} - ${a.name}`, hint: a.type }))}
              invalid={!!form.clientCode && !formAccount} placeholder="Client code / name" />
          </Field>
          <Field label="" width={150}>
            <input className="tt-input" readOnly tabIndex={-1} value={formAccount?.name ?? ""} />
          </Field>
          <Field label="Date" width={128}>
            <input type="date" className="tt-input" value={form.date} onChange={(e) => e.target.value && set("date", e.target.value)} />
          </Field>
          <Field label="Type" width={150}>
            <select className="tt-select" value={form.kind} onChange={(e) => set("kind", e.target.value as LedgerKind)}>
              {(Object.keys(KIND_LABEL) as LedgerKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="Amount ₹" required width={130}>
            <input className="tt-input num" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value.replace(/[^\d.]/g, ""))} />
          </Field>
          <Field label="Narration" width={260}>
            <input className="tt-input" value={form.narration} onChange={(e) => set("narration", e.target.value)} placeholder="e.g. RTGS / cheque no." />
          </Field>
          <button type="button" className="tt-btn tt-btn-save" onClick={save}>{form.id != null ? "Update" : "Save"}</button>
          <button type="button" className="tt-btn" onClick={() => { setForm(emptyForm(form.clientCode)); setMessage(null); }}>Cancel</button>
          <span className="tt-muted" style={{ marginLeft: "auto" }}>
            {CREDIT_KINDS.includes(form.kind) ? "Credit — reduces funded amount from this date" : "Debit — increases funded amount from this date"}
          </span>
        </div>
        {message && <div className="tt-status"><span className={message.ok ? "ok" : "bad"}>{message.text}</span></div>}
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Ledger Statement
          <select className="tt-select" style={{ width: 200, fontWeight: 400 }} value={client} onChange={(e) => setClient(e.target.value)}>
            {data.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} - {a.name}</option>)}
          </select>
          <select className="tt-select" style={{ width: 110, fontWeight: 400 }} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <span className="tt-muted" style={{ fontWeight: 400 }}>
            NSE equity · Funded = Margin used − Client money · Interest {account?.interestPct ?? 0}% p.a. on funded · up to {fmtDate(asOf)}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button type="button" className="tt-btn tt-btn-blue" onClick={downloadPdf} disabled={!rows.length || pdfBusy}>{pdfBusy ? "Preparing…" : "Download PDF"}</button>
            <button type="button" className="tt-btn tt-btn-save" onClick={exportStatement} disabled={!rows.length}>Export to Excel</button>
          </span>
        </div>

        {ledger && (
          <div className="tt-status" style={{ height: "auto", flexWrap: "wrap", padding: "4px 8px", gap: "6px 18px" }}>
            <span>Client money <b className={ledger.money < 0 ? "neg" : "pos"}>{crDr(ledger.money)}</b></span>
            <span>Margin used <b>{fmt2(ledger.margin)}</b></span>
            <span>Funded <b className="neg">{fmt2(ledger.funded)}</b></span>
            <span>Interest this month <b>{fmt2(monthInterest)}</b>{settledThisMonth ? <span className="tt-muted"> (billed {fmtDate(settledThisMonth.periodTo)})</span> : <span className="tt-muted"> (accrued, billed at month-end settlement)</span>}</span>
            <span>Interest posted to date <b>{fmt2(ledger.postedInterest)}</b></span>
            <span>Trade P&amp;L awaiting settlement <b className={ledger.pendingPnl < 0 ? "neg" : "pos"}>{fmt2(ledger.pendingPnl)}</b></span>
            {ledger.warnings.map((w) => <span key={w} className="bad">{w}</span>)}
            {ledger.settlements.filter((s) => s.missingPrices.length).map((s) => (
              <span key={s.settlement.id} className="bad">Settlement {fmtDate(s.periodTo)} has no price for: {s.missingPrices.join(", ")}</span>
            ))}
          </div>
        )}

        <div className="tt-grid-wrap" style={{ maxHeight: "52vh" }}>
          <table className="tt-grid">
            <thead>
              <tr>
                <th>Date</th><th>Particulars</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Client Money</th>
                <th className="num">Margin Used</th><th className="num">Funded</th><th className="num">Days</th><th className="num">Interest</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r.kind === "INTEREST" ? "sell" : r.kind === "PNL" || r.kind === "MTM" || r.kind === "BF" ? "editing-soft" : ""}>
                  <td>{fmtDate(r.date)}</td>
                  <td style={{ whiteSpace: "normal", fontWeight: r.kind === "BF" ? 600 : undefined }}>{r.particulars}</td>
                  <td className="num">{r.debit ? fmt2(r.debit) : ""}</td>
                  <td className="num">{r.credit ? fmt2(r.credit) : ""}</td>
                  <td className={`num ${r.money < 0 ? "neg" : ""}`}>{crDr(r.money)}</td>
                  <td className="num">{fmt2(r.margin)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmt2(r.funded)}</td>
                  <td className="num">{r.days || ""}</td>
                  <td className="num">{r.interest ? fmt2(r.interest) : ""}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className="empty">No equity activity for this client in {monthLabel(month)}.</td></tr>}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={7}>Interest for {monthLabel(month)}{settledThisMonth ? "" : " (accrued so far)"}</td>
                  <td className="num">{rows.reduce((s, r) => s + r.days, 0)}</td>
                  <td className="num">{fmt2(monthInterest)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Entries {account ? `— ${account.code} ${account.name}` : ""}
          <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {entries.length}</span>
        </div>
        <div className="tt-grid-wrap" style={{ maxHeight: "30vh" }}>
          <table className="tt-grid">
            <thead>
              <tr><th>Date</th><th>Client</th><th>Type</th><th className="num">Debit</th><th className="num">Credit</th><th>Narration</th><th>User</th><th className="ctr">Edit</th><th className="ctr">Delete</th></tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const credit = CREDIT_KINDS.includes(e.kind);
                return (
                  <tr key={e.id} className={e.id === form.id ? "editing" : credit ? "buy" : "sell"}>
                    <td>{fmtDate(e.date)}</td>
                    <td>{e.clientCode} - {nameOf.get(e.clientCode) ?? "?"}</td>
                    <td>{KIND_LABEL[e.kind]}</td>
                    <td className="num">{credit ? "" : fmt2(e.amount)}</td>
                    <td className="num">{credit ? fmt2(e.amount) : ""}</td>
                    <td>{e.narration}</td>
                    <td>{e.user}</td>
                    <td className="ctr"><button type="button" className="tt-btn tt-btn-blue tt-btn-xs" onClick={() => edit(e)}>Edit</button></td>
                    <td className="ctr"><button type="button" className="tt-btn tt-btn-red tt-btn-xs" onClick={() => remove(e)}>Delete</button></td>
                  </tr>
                );
              })}
              {entries.length === 0 && <tr><td colSpan={9} className="empty">No deposits / payouts / journals for this client.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
