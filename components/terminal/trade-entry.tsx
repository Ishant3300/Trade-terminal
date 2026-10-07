"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  computeTradeCalcs, fmt2, fmt0, fmtDate, findInstrument, findListed, instrumentKey, openFutLots, quoteKey, lotFromQty, snapQty,
  toDateStr, toTimeStr, valanFor, type TradeCalc,
} from "@/lib/terminal/engine";
import { INSTRUMENTS } from "@/lib/terminal/seed";
import { DERIVATIVE_SEGMENTS, SEGMENTS, type OptionType, type Segment, type Side, type TerminalData, type Trade, type TradeType } from "@/lib/terminal/types";
import { useLiveQuotes } from "./quotes";
import type { TerminalActions } from "./store";
import { Field, Suggest } from "./ui";

interface Form {
  date: string;
  valan: string;
  segment: Segment;
  side: Side;
  tradeType: TradeType;
  checkHL: boolean;
  fullPayment: boolean;
  script: string;
  option: OptionType;
  strike: string;
  lot: string;
  qty: string;
  rate: string;
  clientCode: string;
}

const today = () => toDateStr(new Date());

const initialForm = (): Form => ({
  date: today(), valan: valanFor(today()), segment: "NSEFUT", side: "B", tradeType: "NRM", checkHL: true, fullPayment: false,
  script: "", option: "", strike: "", lot: "", qty: "", rate: "", clientCode: "",
});

const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

export function TradeEntry({
  data, actions, calcs,
}: {
  data: TerminalData;
  actions: TerminalActions;
  calcs: Map<number, TradeCalc>;
}) {
  const [form, setForm] = useState<Form>(initialForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  /** Rate follows the live Ask (buy) / Bid (sell) until the user types a rate. */
  const [rateLive, setRateLive] = useState(true);

  const dateRef = useRef<HTMLInputElement>(null);
  const valanRef = useRef<HTMLInputElement>(null);
  const segRef = useRef<HTMLSelectElement>(null);
  const scriptRef = useRef<HTMLInputElement>(null);
  const optionRef = useRef<HTMLSelectElement>(null);
  const strikeRef = useRef<HTMLInputElement>(null);
  const lotRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => scriptRef.current?.focus(), []);

  const isOpt = form.segment === "NSEOPT";
  const inst = findInstrument(INSTRUMENTS, form.segment, form.script);
  const lotSize = inst?.lotSize ?? 0;
  const liveKey = !inst
    ? null
    : !isOpt
      ? quoteKey({ segment: form.segment, script: inst.name, option: "", strike: 0 })
      : form.option && num(form.strike) > 0
        ? quoteKey({ segment: form.segment, script: inst.name, option: form.option, strike: num(form.strike) })
        : null;
  const feed = useLiveQuotes(liveKey ? [liveKey] : [], 2000);
  const tick = liveKey ? feed.quotes[liveKey] ?? undefined : undefined;
  const livePrice = tick ? (form.side === "B" ? tick.ask ?? tick.ltp : tick.bid ?? tick.ltp) : null;
  const rateStr = rateLive && livePrice ? String(livePrice) : form.rate;
  const account = data.accounts.find((a) => a.code === form.clientCode.trim().toUpperCase());

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setSide = (side: Side) => {
    set("side", side);
    setRateLive(true);
  };
  const setManualRate = (rate: string) => {
    setRateLive(false);
    set("rate", rate);
  };

  const setScript = (script: string) => {
    setRateLive(true);
    return setForm((f) => {
      const next = { ...f, script };
      const i = findInstrument(INSTRUMENTS, f.segment, script);
      const lot = num(f.lot);
      if (i && lot > 0) next.qty = String(lot * i.lotSize);
      return next;
    });
  };

  const setLot = (lot: string) =>
    setForm((f) => {
      const l = num(lot);
      return { ...f, lot, qty: lotSize && l >= 0 ? String(l * lotSize) : f.qty };
    });

  const setQty = (qty: string) =>
    setForm((f) => {
      const q = num(qty);
      return { ...f, qty, lot: lotSize && q >= 0 ? String(lotFromQty(q, lotSize)) : f.lot };
    });

  const snapQtyOnBlur = () => {
    const q = num(form.qty);
    if (!lotSize || !(q > 0)) return;
    const snapped = snapQty(q, lotSize, form.segment);
    if (snapped !== q) setMessage({ ok: true, text: `Quantity rounded to ${fmt0(snapped)} (${snapped / lotSize} lot × ${lotSize})` });
    setForm((f) => ({ ...f, qty: String(snapped), lot: String(lotFromQty(snapped, lotSize)) }));
  };

  // ---- Draft trade & live net rate -------------------------------------------------
  const draft = useMemo((): Trade | null => {
    const qty = num(form.qty);
    const rate = num(rateStr);
    if (!inst || !account || !(qty > 0) || !(rate > 0)) return null;
    const original = editingId != null ? data.trades.find((t) => t.id === editingId) : undefined;
    return {
      id: editingId ?? -1,
      ot: original?.ot ?? "T",
      date: form.date,
      valan: form.valan,
      segment: form.segment,
      script: inst.name,
      option: isOpt ? form.option : "",
      strike: isOpt ? num(form.strike) || 0 : 0,
      tradeType: form.tradeType,
      side: form.side,
      lot: lotFromQty(qty, inst.lotSize),
      qty,
      rate,
      clientCode: account.code,
      fullPayment: form.segment === "NSEEQ" && form.side === "B" && form.fullPayment,
      user: "",
      ip: "",
      addTime: original?.addTime ?? `${form.date} ${toTimeStr(new Date())}`,
    };
  }, [form, rateStr, inst, account, isOpt, editingId, data.trades]);

  const draftCalc = useMemo(() => {
    if (!draft) return null;
    const key = instrumentKey(draft);
    const peers = data.trades.filter(
      (t) => t.id !== draft.id && t.date === draft.date && t.clientCode === draft.clientCode && instrumentKey(t) === key
    );
    return computeTradeCalcs([...peers, draft], data.slabs, INSTRUMENTS).get(draft.id) ?? null;
  }, [draft, data.trades, data.slabs]);

  // ---- Actions ---------------------------------------------------------------------
  const resetForm = (keepHeader = true) => {
    setRateLive(true);
    setForm((f) => (keepHeader ? { ...initialForm(), date: f.date, valan: f.valan, segment: f.segment, side: f.side, tradeType: f.tradeType, checkHL: f.checkHL } : initialForm()));
    setEditingId(null);
    setTimeout(() => scriptRef.current?.focus(), 0);
  };

  const fail = (text: string, focus?: HTMLElement | null) => {
    setMessage({ ok: false, text });
    focus?.focus();
  };

  const save = async () => {
    if (saving) return;
    if (!inst) return fail(`Invalid script "${form.script}" for ${form.segment}`, scriptRef.current);
    const original = editingId != null ? data.trades.find((t) => t.id === editingId) : undefined;
    if (original?.script !== inst.name) {
      if (!findListed(INSTRUMENTS, form.segment, inst.name)) return fail(`${inst.name} is not a listed ${form.segment} contract`, scriptRef.current);
      if (inst.expiry && inst.expiry < form.date) return fail(`${inst.name} expired on ${fmtDate(inst.expiry)}`, scriptRef.current);
    }
    if (isOpt && !form.option) return fail("Select CE / PE for option trade", optionRef.current);
    if (isOpt && !(num(form.strike) > 0)) return fail("Enter strike price", strikeRef.current);
    const qty = num(form.qty);
    if (!(qty > 0)) return fail("Enter quantity / lot", lotRef.current);
    if (DERIVATIVE_SEGMENTS.has(form.segment) && qty % inst.lotSize !== 0)
      return fail(`Quantity must be a multiple of lot size ${inst.lotSize}`, qtyRef.current);
    const rate = num(rateStr);
    if (!(rate > 0)) return fail("Enter rate", rateRef.current);
    if (form.checkHL && form.date === today()) { // day range only means something for today
      if (!tick) return fail("Check HL: no live high/low for this contract — untick Check HL to save", rateRef.current);
      if (rate < tick.low || rate > tick.high)
        return fail(`Rate ${fmt2(rate)} outside day range L ${fmt2(tick.low)} – H ${fmt2(tick.high)}`, rateRef.current);
    }
    if (!account) return fail(`Invalid client code "${form.clientCode}"`, clientRef.current);
    if (!draft) return;
    if (form.segment === "NSEFUT" && account.maxFutLots > 0) {
      // Limit on open lots across all NSEFUT contracts; trades that reduce the position are always allowed.
      const others = data.trades.filter((t) => t.id !== editingId);
      const before = openFutLots(data.trades, INSTRUMENTS, account.code, draft.date);
      const after = openFutLots([...others, draft], INSTRUMENTS, account.code, draft.date);
      if (after > account.maxFutLots && after > before)
        return fail(`${account.code} limit is ${fmt0(account.maxFutLots)} NSEFUT lots — open now ${fmt0(before)}, this trade would make ${fmt0(after)}`, lotRef.current);
    }

    setSaving(true);
    const res = await actions.saveTrade(editingId != null ? draft : { ...draft, id: undefined });
    setSaving(false);
    if (!res.ok) return fail(`Not saved: ${res.error}`);
    const net = draftCalc ? fmt2(draftCalc.netRate) : fmt2(rate);
    setMessage({
      ok: true,
      text: `${editingId != null ? "Updated" : "Saved"}: ${form.side === "B" ? "BUY" : "SELL"} ${fmt0(qty)} ${inst.name}${isOpt ? ` ${form.strike} ${form.option}` : ""} @ ${fmt2(rate)} (net ${net}) — ${account.code} ${account.name}`,
    });
    setEditingId(null);
    setForm((f) => ({ ...f, lot: "", qty: "", rate: "", fullPayment: false }));
    setRateLive(true);
    setTimeout(() => lotRef.current?.focus(), 0);
  };

  const edit = (t: Trade) => {
    setRateLive(false); // keep the trade's own rate
    setEditingId(t.id);
    setForm((f) => ({
      ...f, date: t.date, valan: t.valan, segment: t.segment, side: t.side, tradeType: t.tradeType,
      script: t.script, option: t.option, strike: t.strike ? String(t.strike) : "",
      lot: String(t.lot), qty: String(t.qty), rate: String(t.rate), clientCode: t.clientCode, fullPayment: !!t.fullPayment,
    }));
    setMessage({ ok: true, text: `Editing trade #${t.id} — change fields and press Alt+S / Save` });
    setTimeout(() => qtyRef.current?.focus(), 0);
  };

  const remove = async (t: Trade) => {
    if (!confirm(`Delete trade #${t.id}: ${t.side === "B" ? "BUY" : "SELL"} ${t.qty} ${t.script} @ ${t.rate} (${t.clientCode})?`)) return;
    const res = await actions.deleteTrade(t.id);
    if (!res.ok) return setMessage({ ok: false, text: `Not deleted: ${res.error}` });
    if (editingId === t.id) resetForm();
    setMessage({ ok: true, text: `Trade #${t.id} deleted` });
  };

  // ---- Keyboard ---------------------------------------------------------------------
  const onGlobalKey = useEffectEvent((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (e.key === "F1" || e.key === "F2") {
      e.preventDefault();
      setSide(e.key === "F1" ? "B" : "S");
    } else if ((e.key === "+" || e.key === "-") && !target.dataset.allowSign) {
      e.preventDefault();
      setSide(e.key === "+" ? "B" : "S");
    } else if (e.altKey && (e.key === "s" || e.key === "S" || e.code === "KeyS")) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      resetForm();
      setMessage(null);
    }
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onGlobalKey(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const focusOrder = () =>
    [dateRef, valanRef, segRef, scriptRef, optionRef, strikeRef, lotRef, qtyRef, rateRef, clientRef, saveRef]
      .map((r) => r.current)
      .filter((el): el is HTMLInputElement | HTMLSelectElement | HTMLButtonElement => !!el && !el.disabled);

  const onFormKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (e.key !== "Enter" || target.tagName === "BUTTON") return;
    e.preventDefault();
    if (target === qtyRef.current) snapQtyOnBlur();
    const order = focusOrder();
    const idx = order.indexOf(target as HTMLInputElement);
    const next = order[idx + 1];
    next?.focus();
    if (next instanceof HTMLInputElement) next.select();
  };

  // ---- Grid -------------------------------------------------------------------------
  const nameOf = useMemo(() => new Map(data.accounts.map((a) => [a.code, a.name])), [data.accounts]);
  const rows = useMemo(() => {
    const q = search.trim().toUpperCase();
    return data.trades
      .filter((t) => t.date === form.date)
      .filter((t) => {
        if (!q) return true;
        const hay = `${t.clientCode} ${nameOf.get(t.clientCode) ?? ""} ${t.segment} ${t.script} ${t.option} ${t.strike || ""} ${t.side === "B" ? "BUY" : "SELL"} ${t.tradeType}`;
        return hay.toUpperCase().includes(q);
      })
      .sort((a, b) => b.addTime.localeCompare(a.addTime) || b.id - a.id);
  }, [data.trades, form.date, search, nameOf]);

  const buyCount = rows.filter((t) => t.side === "B").length;
  const scriptOptions = useMemo(
    () =>
      INSTRUMENTS.filter((i) => i.segment === form.segment && (!i.expiry || i.expiry >= form.date)).map((i) => ({
        value: i.name, label: i.name, hint: `Lot ${i.lotSize}`,
      })),
    [form.segment, form.date]
  );
  const clientOptions = data.accounts.map((a) => ({ value: a.code, label: `${a.code} - ${a.name}`, hint: a.type }));
  const sideName = form.side === "B" ? "BUY" : "SELL";

  return (
    <div className="tt-page">
      <div className={`tt-card tt-entry${form.side === "S" ? " sell" : ""}`} onKeyDown={onFormKeyDown}>
        <div className="tt-card-h">
          <span className="tt-side-tag">{sideName}</span>
          <span>Trade Entry{editingId != null && <span className="tt-muted"> — editing #{editingId}</span>}</span>
          <span className="tt-keys tt-muted" style={{ marginLeft: "auto" }}>
            <kbd>F1</kbd>/<kbd>+</kbd> Buy &nbsp; <kbd>F2</kbd>/<kbd>-</kbd> Sell &nbsp; <kbd>Enter</kbd> Next &nbsp; <kbd>Alt+S</kbd> Save &nbsp; <kbd>Esc</kbd> Clear
          </span>
        </div>

        <div className="tt-card-b" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Header action strip */}
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <Field label="Date" width={128}>
              <input ref={dateRef} type="date" className="tt-input" value={form.date}
                onChange={(e) => e.target.value && setForm((f) => ({ ...f, date: e.target.value, valan: valanFor(e.target.value) }))} />
            </Field>
            <Field label="Valan" width={86}>
              <input ref={valanRef} className="tt-input" data-allow-sign="1" value={form.valan} onChange={(e) => set("valan", e.target.value.toUpperCase())} />
            </Field>
            <Field label="Segment" width={86}>
              <select ref={segRef} className="tt-select" value={form.segment}
                onChange={(e) => {
                  const segment = e.target.value as Segment;
                  setForm((f) => ({
                    ...f, segment, option: segment === "NSEOPT" ? f.option : "", strike: segment === "NSEOPT" ? f.strike : "",
                    script: findInstrument(INSTRUMENTS, segment, f.script) ? f.script : "",
                  }));
                }}>
                {SEGMENTS.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <div className="flex items-center gap-2" style={{ height: 26 }}>
              <label className={`tt-check tt-radio-buy${form.side === "B" ? " on" : ""}`}>
                <input type="radio" name="side" checked={form.side === "B"} onChange={() => setSide("B")} /> Buy
              </label>
              <label className={`tt-check tt-radio-sell${form.side === "S" ? " on" : ""}`}>
                <input type="radio" name="side" checked={form.side === "S"} onChange={() => setSide("S")} /> Sell
              </label>
            </div>
            <div className="flex items-center gap-2" style={{ height: 26, borderLeft: "1px solid #c3cad5", paddingLeft: 10 }}>
              <span className="tt-label">Type</span>
              {(["NRM", "CF", "BF"] as TradeType[]).map((tt) => (
                <label key={tt} className="tt-check">
                  <input type="radio" name="ttype" checked={form.tradeType === tt} onChange={() => set("tradeType", tt)} /> {tt}
                </label>
              ))}
            </div>
            <label className="tt-check" style={{ height: 26, borderLeft: "1px solid #c3cad5", paddingLeft: 10 }}>
              <input type="checkbox" checked={form.checkHL} onChange={(e) => set("checkHL", e.target.checked)} /> Check HL
            </label>
            {form.segment === "NSEEQ" && form.side === "B" && (
              <label className="tt-check" style={{ height: 26, borderLeft: "1px solid #c3cad5", paddingLeft: 10 }}
                title="Client paid the full amount — no interest is charged on this buy">
                <input type="checkbox" checked={form.fullPayment} onChange={(e) => set("fullPayment", e.target.checked)} /> Full Payment
              </label>
            )}
            <div className="tt-ticker" style={{ marginLeft: "auto" }}
              title={feed.status === "not-configured" ? "Live feed not configured (Angel One)" : feed.status === "error" ? `Live feed error: ${feed.message}` : liveKey ?? "Select a script"}>
              <span><i className={`tt-feed-dot ${liveKey && tick ? "on" : feed.status === "error" ? "err" : ""}`} />{inst ? inst.symbol : "—"}</span>
              <span>L: <b className="l">{tick ? fmt2(tick.low) : "—"}</b></span>
              <span className="m-click" onClick={() => tick && setManualRate(String(tick.ltp))} title="Click to use as Rate">
                M: <b className="m">{tick ? fmt2(tick.ltp) : "—"}</b>
              </span>
              <span>H: <b className="h">{tick ? fmt2(tick.high) : "—"}</b></span>
              <span className="m-click" onClick={() => tick?.bid && setManualRate(String(tick.bid))}
                title={tick?.bid ? `Best bid: ${tick.bidQty} qty — click to use as Rate` : "No bid"}>
                B: <b className="bid">{tick?.bid ? fmt2(tick.bid) : "—"}</b>
              </span>
              <span className="m-click" style={{ borderRight: 0 }} onClick={() => tick?.ask && setManualRate(String(tick.ask))}
                title={tick?.ask ? `Best ask: ${tick.askQty} qty — click to use as Rate` : "No offer"}>
                A: <b className="ask">{tick?.ask ? fmt2(tick.ask) : "—"}</b>
              </span>
            </div>
          </div>

          {/* Entry row */}
          <div className="flex flex-wrap items-end gap-x-2 gap-y-1">
            <Field label="Script Name" required>
              <Suggest inputRef={scriptRef} allowSign value={form.script} onChange={setScript} options={scriptOptions}
                width={180} placeholder="NIFTY / CRUDEOIL…" invalid={!!form.script && !inst} />
            </Field>
            <Field label="Option" width={58}>
              <select ref={optionRef} className="tt-select" disabled={!isOpt} value={form.option} onChange={(e) => set("option", e.target.value as OptionType)}>
                <option value=""></option>
                <option>CE</option>
                <option>PE</option>
              </select>
            </Field>
            <Field label="Strike" width={72}>
              <input ref={strikeRef} className="tt-input num" disabled={!isOpt} inputMode="decimal" value={form.strike}
                onChange={(e) => set("strike", e.target.value.replace(/[^\d.]/g, ""))} />
            </Field>
            <Field label="Lot Size" width={62}>
              <input className="tt-input num" readOnly tabIndex={-1} value={lotSize || ""} />
            </Field>
            <Field label="Lot" width={56}>
              <input ref={lotRef} className="tt-input num" inputMode="numeric" value={form.lot}
                onChange={(e) => setLot(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <Field label="Quantity" required width={78}>
              <input ref={qtyRef} className="tt-input num" inputMode="numeric" value={form.qty}
                onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} onBlur={snapQtyOnBlur} />
            </Field>
            <Field
              label={
                <>
                  Rate<span className="tt-req">*</span>{" "}
                  <span
                    className={`tt-rate-mode ${rateLive ? "live" : ""}`}
                    title={rateLive ? `Following live ${form.side === "B" ? "Ask" : "Bid"} — type to enter your own rate` : "Click to follow the live price again"}
                    onClick={(e) => {
                      e.preventDefault();
                      if (!rateLive) setRateLive(true);
                    }}
                  >
                    {rateLive ? (form.side === "B" ? "● ASK" : "● BID") : "MANUAL ↺"}
                  </span>
                </>
              }
              width={110}
            >
              <input ref={rateRef} className={`tt-input num${rateLive && livePrice ? (form.side === "B" ? " live-buy" : " live-sell") : ""}`}
                inputMode="decimal" value={rateStr}
                onChange={(e) => setManualRate(e.target.value.replace(/[^\d.]/g, ""))} />
            </Field>
            <Field label="Client Code" required>
              <Suggest inputRef={clientRef} value={form.clientCode} onChange={(v) => set("clientCode", v)} options={clientOptions}
                width={92} invalid={!!form.clientCode && !account} />
            </Field>
            <Field label="Customer Name" width={150}>
              <input className="tt-input" readOnly tabIndex={-1} value={account?.name ?? ""} />
            </Field>
            <Field label="Net Rate" width={92}>
              <input className="tt-input num" readOnly tabIndex={-1} value={draftCalc ? fmt2(draftCalc.netRate) : ""}
                style={{ fontWeight: 700, color: form.side === "B" ? "#0d47a1" : "#b71c1c" }} />
            </Field>
            <div className="flex gap-1">
              <button ref={saveRef} type="button" className="tt-btn tt-btn-save" onClick={save} disabled={saving}>
                {saving ? "Saving…" : editingId != null ? "Update" : "Save"}
              </button>
              <button type="button" className="tt-btn" onClick={() => { resetForm(); setMessage(null); }}>Cancel</button>
            </div>
          </div>
        </div>

        <div className="tt-status">
          {draftCalc ? <BrokerageInfo calc={draftCalc} qty={num(form.qty)} rate={num(rateStr)} side={form.side} tradeType={form.tradeType} />
            : <span className="tt-muted">Net Rate = Rate ± brokerage per unit from the client&apos;s slab (script-wise, else segment-wise)</span>}
          {message && <span className={message.ok ? "ok" : "bad"} style={{ marginLeft: "auto" }}>{message.text}</span>}
        </div>
      </div>

      <div className="tt-card">
        <div className="tt-card-h">
          <span>Trades — {form.date.split("-").reverse().join("-")}</span>
          <input className="tt-input" style={{ width: 220, fontWeight: 400 }} placeholder="Search client / script / segment…"
            data-allow-sign="1" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="tt-muted" style={{ fontWeight: 400 }}>
            <span className="b-txt">Buy {buyCount}</span> · <span className="s-txt">Sell {rows.length - buyCount}</span>
          </span>
          <span className="tt-badge" style={{ marginLeft: "auto" }}>Count: {rows.length}</span>
        </div>
        <div className="tt-grid-wrap" style={{ maxHeight: "calc(100vh - 260px)" }}>
          <table className="tt-grid">
            <thead>
              <tr>
                <th>O/T</th><th>Customer Name</th><th>Segment</th><th>Script Name</th><th>CE/PE</th><th>Type</th>
                <th>B/S</th><th className="num">Lot</th><th className="num">Quantity</th><th className="num">Rate</th>
                <th className="num">Net Rate</th><th>User</th><th>Time</th><th className="ctr">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const c = calcs.get(t.id);
                return (
                  <tr key={t.id} className={`${t.side === "B" ? "buy" : "sell"}${t.id === editingId ? " editing" : ""}`} onDoubleClick={() => edit(t)}>
                    <td className="ctr">{t.ot}</td>
                    <td>{t.clientCode} - {nameOf.get(t.clientCode) ?? "?"}</td>
                    <td>{t.segment}</td>
                    <td>{t.script}</td>
                    <td>{t.option ? `${t.strike} ${t.option}` : ""}</td>
                    <td>{t.tradeType}{t.fullPayment && <span className="tt-muted" title="Full payment — no interest"> FP</span>}</td>
                    <td className={t.side === "B" ? "b-txt" : "s-txt"}>{t.side === "B" ? "BUY" : "SELL"}</td>
                    <td className="num">{fmt0(t.lot)}</td>
                    <td className="num">{fmt0(t.qty)}</td>
                    <td className="num">{fmt2(t.rate)}</td>
                    <td className="num" style={{ fontWeight: 600 }}
                      title={c ? `Brokerage ₹${fmt2(c.brokerage)} (${fmt2(c.brokPerUnit)}/unit) · Intraday ${c.intraQty}${c.intraWaived ? " (higher side waived)" : ""} · Delivery ${c.delQty}` : ""}>
                      {fmt2(c?.netRate ?? t.rate)}
                    </td>
                    <td>{t.user}</td>
                    <td>{t.addTime.slice(11)}</td>
                    <td className="ctr">
                      <span className="flex justify-center gap-1">
                        <button type="button" className="tt-btn tt-btn-blue tt-btn-xs" onClick={() => edit(t)}>Edit</button>
                        <button type="button" className="tt-btn tt-btn-red tt-btn-xs" onClick={() => remove(t)}>Delete</button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={14} className="empty">No trades for this date.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BrokerageInfo({ calc, qty, rate, side, tradeType }: { calc: TradeCalc; qty: number; rate: number; side: Side; tradeType: TradeType }) {
  if (tradeType !== "NRM") return <span>{tradeType} entry — no brokerage · Net Rate = Rate</span>;
  const s = calc.slab;
  const slabText = !s
    ? "No slab configured — brokerage 0"
    : s.mode === "FIX"
      ? `Fix ${s.scriptWise ? `[${s.script}]` : "[segment]"} Del ₹${s.fixDel} / Intra ₹${s.fixIntra} per lot${s.higherSideOnly ? " · Higher side" : ""}`
      : `% ${s.scriptWise ? `[${s.script}]` : "[segment]"} Del ${s.delPct}% / Intra ${s.intraPct}%${s.minRate ? ` · Min rate ${s.minRate}` : ""}${s.minPct ? ` · Min% ${s.minPct}` : ""}${s.minPctOnDel ? ` · Min% Del ${s.minPctOnDel}` : ""}${s.higherSideOnly ? " · Higher side" : ""}`;
  return (
    <span>
      {slabText} &nbsp;|&nbsp; Intraday <b>{fmt0(calc.intraQty)}</b>{calc.intraWaived && " (waived: lower side)"} · Delivery <b>{fmt0(calc.delQty)}</b>
      &nbsp;|&nbsp; Brokerage <b>₹{fmt2(calc.brokerage)}</b> = <b>{fmt2(calc.brokPerUnit)}</b>/unit
      &nbsp;|&nbsp; Obligation <b>₹{fmt2(calc.netRate * qty)}</b>
      <span className="tt-muted"> ({fmt2(rate)} {side === "B" ? "+" : "−"} {fmt2(calc.brokPerUnit)})</span>
    </span>
  );
}
