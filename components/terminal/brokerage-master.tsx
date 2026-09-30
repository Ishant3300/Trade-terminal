"use client";

import { useState } from "react";
import { INSTRUMENTS } from "@/lib/terminal/seed";
import { SEGMENTS, type Segment, type Slab, type SlabMode, type TerminalData } from "@/lib/terminal/types";
import type { TerminalActions } from "./store";
import { Field, Suggest } from "./ui";

interface Form {
  clientCode: string;
  segment: Segment;
  mode: SlabMode;
  scriptWise: boolean;
  script: string;
  del: string;
  intra: string;
  higherSideOnly: boolean;
  minRate: string;
  minPct: string;
  minPctOnDel: string;
}

const empty = (clientCode = "", segment: Segment = "NSEFUT"): Form => ({
  clientCode, segment, mode: "PCT", scriptWise: false, script: "", del: "", intra: "",
  higherSideOnly: false, minRate: "", minPct: "", minPctOnDel: "",
});

const n = (s: string) => Number(s) || 0;
const show = (v: number) => (v ? String(v) : "");

export function BrokerageMaster({ data, actions }: { data: TerminalData; actions: TerminalActions }) {
  const [form, setForm] = useState<Form>(() => empty());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const account = data.accounts.find((a) => a.code === form.clientCode);
  const symbols = [...new Set(INSTRUMENTS.filter((i) => i.segment === form.segment).map((i) => i.symbol))];
  const isFix = form.mode === "FIX";
  const unit = isFix ? "₹/lot" : "%";

  const save = async () => {
    if (!account) return setMessage({ ok: false, text: "Select a valid account" });
    if (form.scriptWise && !form.script) return setMessage({ ok: false, text: "Select script for script-wise slab" });
    const slab: Omit<Slab, "id"> & { id?: number } = {
      id: editingId ?? undefined,
      clientCode: account.code,
      segment: form.segment,
      scriptWise: form.scriptWise,
      script: form.scriptWise ? form.script : "",
      mode: form.mode,
      delPct: isFix ? 0 : n(form.del),
      intraPct: isFix ? 0 : n(form.intra),
      fixDel: isFix ? n(form.del) : 0,
      fixIntra: isFix ? n(form.intra) : 0,
      higherSideOnly: form.higherSideOnly,
      minRate: n(form.minRate),
      minPct: n(form.minPct),
      minPctOnDel: n(form.minPctOnDel),
    };
    const res = await actions.saveSlab(slab);
    if (!res.ok) return setMessage({ ok: false, text: `Not saved: ${res.error}` });
    setMessage({ ok: true, text: `Slab saved for ${account.code} ${form.segment}${form.scriptWise ? ` / ${form.script}` : ""}. Net rates recalculated.` });
    setEditingId(null);
    setForm(empty(account.code, form.segment));
  };

  const edit = (s: Slab) => {
    setEditingId(s.id);
    setForm({
      clientCode: s.clientCode, segment: s.segment, mode: s.mode, scriptWise: s.scriptWise, script: s.script,
      del: show(s.mode === "FIX" ? s.fixDel : s.delPct), intra: show(s.mode === "FIX" ? s.fixIntra : s.intraPct),
      higherSideOnly: s.higherSideOnly, minRate: show(s.minRate), minPct: show(s.minPct), minPctOnDel: show(s.minPctOnDel),
    });
    setMessage(null);
  };

  const remove = async (s: Slab) => {
    if (!confirm(`Delete ${s.segment}${s.scriptWise ? ` / ${s.script}` : ""} slab for ${s.clientCode}?`)) return;
    const res = await actions.deleteSlab(s.id);
    if (!res.ok) return setMessage({ ok: false, text: `Not deleted: ${res.error}` });
    if (editingId === s.id) setEditingId(null);
  };

  const list = data.slabs
    .filter((s) => !account || s.clientCode === account.code)
    .sort((a, b) => a.clientCode.localeCompare(b.clientCode) || a.segment.localeCompare(b.segment) || Number(a.scriptWise) - Number(b.scriptWise));

  const numInput = (k: "del" | "intra" | "minRate" | "minPct" | "minPctOnDel") => (
    <input className="tt-input num" inputMode="decimal" value={form[k]} onChange={(e) => set(k, e.target.value.replace(/[^\d.]/g, ""))} />
  );

  return (
    <div className="tt-page">
      <div className="tt-card">
        <div className="tt-card-h">
          Brokerage Slab Master{editingId != null && <span className="tt-muted">— editing slab #{editingId}</span>}
        </div>
        <div className="tt-card-b">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <Field label="Account Name" required>
              <Suggest value={form.clientCode} onChange={(v) => set("clientCode", v)} width={200}
                options={data.accounts.map((a) => ({ value: a.code, label: `${a.code} - ${a.name}`, hint: a.type }))}
                invalid={!!form.clientCode && !account} placeholder="Search account…" />
            </Field>
            <Field label="" width={160}>
              <input className="tt-input" readOnly tabIndex={-1} value={account?.name ?? ""} />
            </Field>
            <Field label="Segment" width={92}>
              <select className="tt-select" value={form.segment}
                onChange={(e) => setForm((f) => ({ ...f, segment: e.target.value as Segment, script: "" }))}>
                {SEGMENTS.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <div className="flex items-center gap-2" style={{ height: 26 }}>
              <span className="tt-label">Option</span>
              <label className="tt-check"><input type="radio" checked={!isFix} onChange={() => set("mode", "PCT")} /> % (Wise)</label>
              <label className="tt-check"><input type="radio" checked={isFix} onChange={() => set("mode", "FIX")} /> Fix</label>
            </div>
            <label className="tt-check" style={{ height: 26 }}>
              <input type="checkbox" checked={form.scriptWise} onChange={(e) => setForm((f) => ({ ...f, scriptWise: e.target.checked, script: "" }))} /> Script-Wise
            </label>
            <Field label="Script Name" width={130}>
              <select className="tt-select" disabled={!form.scriptWise} value={form.script} onChange={(e) => set("script", e.target.value)}>
                <option value="">{form.scriptWise ? "-- select --" : "(all scripts)"}</option>
                {symbols.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
          </div>

          <div className="tt-section">Slabs</div>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <Field label={isFix ? "Fix Delivery (₹/lot)" : "% Delivery"} width={110}>{numInput("del")}</Field>
            <Field label={isFix ? "Fix IntraDay (₹/lot)" : "% IntraDay"} width={110}>{numInput("intra")}</Field>
            <label className="tt-check" style={{ height: 26 }}>
              <input type="checkbox" checked={form.higherSideOnly} onChange={(e) => set("higherSideOnly", e.target.checked)} /> Higher Side Only
            </label>
            <Field label="Minimum Rate" width={90}>{numInput("minRate")}</Field>
            <Field label="Minimum %" width={80}>{numInput("minPct")}</Field>
            <Field label="Min % On Del" width={86}>{numInput("minPctOnDel")}</Field>
            <button type="button" className="tt-btn tt-btn-save" onClick={save}>{editingId != null ? "Update" : "Save"}</button>
            <button type="button" className="tt-btn" onClick={() => { setEditingId(null); setForm(empty(form.clientCode)); setMessage(null); }}>Cancel</button>
          </div>
          <div className="tt-muted" style={{ marginTop: 6 }}>
            {isFix
              ? `Fix: brokerage = amount (${unit}) × qty ÷ lot size (per unit for equity).`
              : "%: brokerage/unit = rate × % ÷ 100, floored by Minimum Rate. Minimum % / Min % On Del act as floors on the intraday / delivery %."}{" "}
            Higher Side Only charges intraday brokerage only on the side with the larger turnover. Script-wise slabs override segment slabs.
          </div>
        </div>
        {message && (
          <div className="tt-status"><span className={message.ok ? "ok" : "bad"}>{message.text}</span></div>
        )}
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          Configured Slabs {account ? `— ${account.code} ${account.name}` : "— all accounts"}
          <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {list.length}</span>
        </div>
        <div className="tt-grid-wrap" style={{ maxHeight: "calc(100vh - 300px)" }}>
          <table className="tt-grid">
            <thead>
              <tr>
                {!account && <th>Account</th>}
                <th>Segment</th><th>Script Name</th><th className="num">% Delivery</th><th className="num">% IntraDay</th>
                <th className="num">Fix Delivery</th><th className="num">Fix IntraDay</th><th className="ctr">Intraday Higher Side</th>
                <th className="num">Minimum Rate</th><th className="num">Minimum %</th><th className="ctr">Edit</th><th className="ctr">Delete</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className={s.id === editingId ? "editing" : ""}>
                  {!account && <td>{s.clientCode} - {data.accounts.find((a) => a.code === s.clientCode)?.name}</td>}
                  <td>{s.segment}</td>
                  <td>{s.scriptWise ? s.script : <span className="tt-muted">ALL</span>}</td>
                  <td className="num">{s.mode === "PCT" ? s.delPct.toFixed(4) : ""}</td>
                  <td className="num">{s.mode === "PCT" ? s.intraPct.toFixed(4) : ""}</td>
                  <td className="num">{s.mode === "FIX" ? s.fixDel.toFixed(2) : ""}</td>
                  <td className="num">{s.mode === "FIX" ? s.fixIntra.toFixed(2) : ""}</td>
                  <td className="ctr">{s.higherSideOnly ? "Yes" : "No"}</td>
                  <td className="num">{s.minRate.toFixed(2)}</td>
                  <td className="num">{s.minPct.toFixed(4)}</td>
                  <td className="ctr"><button type="button" className="tt-btn tt-btn-blue tt-btn-xs" onClick={() => edit(s)}>Edit</button></td>
                  <td className="ctr"><button type="button" className="tt-btn tt-btn-red tt-btn-xs" onClick={() => remove(s)}>Delete</button></td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={12} className="empty">No slabs configured — trades for this account carry zero brokerage.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
