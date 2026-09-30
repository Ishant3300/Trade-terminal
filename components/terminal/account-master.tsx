"use client";

import { useState, type Dispatch } from "react";
import { fmt2 } from "@/lib/terminal/engine";
import type { Account, AccountType, TerminalData } from "@/lib/terminal/types";
import type { Action } from "./store";
import { Field } from "./ui";

interface Form {
  name: string;
  type: AccountType;
  code: string;
  openingBalance: string;
  openingType: "Dr" | "Cr";
  mobile: string;
  email: string;
  address: string;
  remark: string;
  interestPct: string;
}

const PREFIX: Record<AccountType, string> = { Customer: "C", Self: "S", Broker: "B" };

function nextCode(accounts: Account[], type: AccountType): string {
  const p = PREFIX[type];
  const max = accounts
    .filter((a) => a.code.startsWith(p))
    .reduce((m, a) => Math.max(m, Number(a.code.slice(1)) || 0), 0);
  return `${p}${String(max + 1).padStart(3, "0")}`;
}

const empty = (accounts: Account[]): Form => ({
  name: "", type: "Customer", code: nextCode(accounts, "Customer"), openingBalance: "", openingType: "Cr",
  mobile: "", email: "", address: "", remark: "", interestPct: "",
});

export function AccountMaster({ data, dispatch }: { data: TerminalData; dispatch: Dispatch<Action> }) {
  const [form, setForm] = useState<Form>(() => empty(data.accounts));
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [search, setSearch] = useState("");
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    const name = form.name.trim().toUpperCase();
    const code = form.code.trim().toUpperCase();
    if (!name) return setMessage({ ok: false, text: "Account Name is required" });
    if (!/^[A-Z0-9]{2,10}$/.test(code)) return setMessage({ ok: false, text: "Account Code must be 2–10 letters/digits" });
    if (code !== editing && data.accounts.some((a) => a.code === code))
      return setMessage({ ok: false, text: `Account Code ${code} already exists` });
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) return setMessage({ ok: false, text: "Invalid email" });
    if (form.mobile && !/^\d{10,11}$/.test(form.mobile)) return setMessage({ ok: false, text: "Mobile must be 10–11 digits" });

    const account: Account = {
      code, name, type: form.type,
      openingBalance: Math.abs(Number(form.openingBalance) || 0), openingType: form.openingType,
      mobile: form.mobile, email: form.email.trim(), address: form.address.trim(), remark: form.remark.trim(),
      interestPct: Number(form.interestPct) || 0,
    };
    dispatch({ type: "saveAccount", account, originalCode: editing ?? undefined });
    setMessage({ ok: true, text: `Account ${code} - ${name} ${editing ? "updated" : "created"}` });
    setEditing(null);
    setForm(empty(editing ? data.accounts : [...data.accounts, account]));
  };

  const edit = (a: Account) => {
    setEditing(a.code);
    setForm({
      name: a.name, type: a.type, code: a.code, openingBalance: a.openingBalance ? String(a.openingBalance) : "",
      openingType: a.openingType, mobile: a.mobile, email: a.email, address: a.address, remark: a.remark,
      interestPct: a.interestPct ? String(a.interestPct) : "",
    });
    setMessage(null);
  };

  const remove = (a: Account) => {
    const count = data.trades.filter((t) => t.clientCode === a.code).length;
    if (count) return setMessage({ ok: false, text: `Cannot delete ${a.code}: ${count} trade(s) exist for this account` });
    if (!confirm(`Delete account ${a.code} - ${a.name}? Its brokerage slabs are removed too.`)) return;
    dispatch({ type: "deleteAccount", code: a.code });
    if (editing === a.code) { setEditing(null); setForm(empty(data.accounts)); }
  };

  const q = search.trim().toUpperCase();
  const list = data.accounts.filter((a) => !q || `${a.code} ${a.name} ${a.type} ${a.mobile}`.toUpperCase().includes(q));

  return (
    <div className="tt-page">
      <div className="tt-card">
        <div className="tt-card-h">Account Master{editing && <span className="tt-muted">— editing {editing}</span>}</div>
        <div className="tt-card-b">
          <div className="tt-section" style={{ marginTop: 0 }}>Basic Information</div>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <Field label="Account Name" required width={230}>
              <input className="tt-input" value={form.name} onChange={(e) => set("name", e.target.value.toUpperCase())} autoFocus />
            </Field>
            <Field label="Account Type" width={100}>
              <select className="tt-select" value={form.type}
                onChange={(e) => {
                  const type = e.target.value as AccountType;
                  setForm((f) => ({ ...f, type, code: editing ? f.code : nextCode(data.accounts, type) }));
                }}>
                <option>Customer</option><option>Self</option><option>Broker</option>
              </select>
            </Field>
            <Field label="Account Code" required width={90}>
              <input className="tt-input" value={form.code} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
            </Field>
            <Field label="Opening Balance" width={110}>
              <input className="tt-input num" inputMode="decimal" value={form.openingBalance}
                onChange={(e) => set("openingBalance", e.target.value.replace(/[^\d.]/g, ""))} />
            </Field>
            <div className="flex items-center gap-2" style={{ height: 24 }}>
              <label className={`tt-check tt-radio-sell${form.openingType === "Dr" ? " on" : ""}`}>
                <input type="radio" checked={form.openingType === "Dr"} onChange={() => set("openingType", "Dr")} /> Debit
              </label>
              <label className={`tt-check tt-radio-buy${form.openingType === "Cr" ? " on" : ""}`}>
                <input type="radio" checked={form.openingType === "Cr"} onChange={() => set("openingType", "Cr")} /> Credit
              </label>
            </div>
          </div>

          <div className="tt-section">Additional Details</div>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <Field label="Mobile Number" width={110}>
              <input className="tt-input" inputMode="tel" value={form.mobile} onChange={(e) => set("mobile", e.target.value.replace(/\D/g, "").slice(0, 11))} />
            </Field>
            <Field label="Email" width={190}>
              <input className="tt-input" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label="Address" width={260}>
              <input className="tt-input" value={form.address} onChange={(e) => set("address", e.target.value)} />
            </Field>
            <Field label="Remark" width={170}>
              <input className="tt-input" value={form.remark} onChange={(e) => set("remark", e.target.value)} />
            </Field>
            <Field label="Ledger Interest %" width={100}>
              <input className="tt-input num" inputMode="decimal" value={form.interestPct} onChange={(e) => set("interestPct", e.target.value.replace(/[^\d.]/g, ""))} />
            </Field>
            <button type="button" className="tt-btn tt-btn-save" onClick={save}>{editing ? "Update" : "Save"}</button>
            <button type="button" className="tt-btn" onClick={() => { setEditing(null); setForm(empty(data.accounts)); setMessage(null); }}>Cancel</button>
          </div>
        </div>
        {message && <div className="tt-status"><span className={message.ok ? "ok" : "bad"}>{message.text}</span></div>}
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Accounts
          <input className="tt-input" style={{ width: 200, fontWeight: 400 }} placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {list.length}</span>
        </div>
        <div className="tt-grid-wrap" style={{ maxHeight: "calc(100vh - 330px)" }}>
          <table className="tt-grid">
            <thead>
              <tr>
                <th>Code</th><th>Account Name</th><th>Type</th><th className="num">Opening Balance</th><th className="ctr">Dr/Cr</th>
                <th>Mobile</th><th>Email</th><th>Address</th><th>Remark</th><th className="num">Interest %</th><th className="ctr">Edit</th><th className="ctr">Delete</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.code} className={a.code === editing ? "editing" : ""}>
                  <td style={{ fontWeight: 600 }}>{a.code}</td>
                  <td>{a.name}</td>
                  <td>{a.type}</td>
                  <td className="num">{fmt2(a.openingBalance)}</td>
                  <td className={`ctr ${a.openingType === "Dr" ? "s-txt" : "b-txt"}`}>{a.openingType}</td>
                  <td>{a.mobile}</td>
                  <td>{a.email}</td>
                  <td>{a.address}</td>
                  <td>{a.remark}</td>
                  <td className="num">{a.interestPct ? a.interestPct.toFixed(2) : ""}</td>
                  <td className="ctr"><button type="button" className="tt-btn tt-btn-blue tt-btn-xs" onClick={() => edit(a)}>Edit</button></td>
                  <td className="ctr"><button type="button" className="tt-btn tt-btn-red tt-btn-xs" onClick={() => remove(a)}>Delete</button></td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={12} className="empty">No accounts.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
