"use client";

import { useState } from "react";
import { angelTrades, type AngelTradeRow } from "@/app/actions";
import { fmt0, fmt2, fmtDate } from "@/lib/terminal/engine";
import type { TerminalData } from "@/lib/terminal/types";
import type { TerminalActions } from "./store";

/**
 * Today's executed trades from the Angel One account, to be booked to clients.
 * Angel One gives only the current day's trade book, so import on the same day.
 */
export function AngelImport({ data, actions }: { data: TerminalData; actions: TerminalActions }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [book, setBook] = useState<{ date: string; rows: AngelTradeRow[] } | null>(null);
  const [client, setClient] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [allClient, setAllClient] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await angelTrades();
      if (!res.ok) return setMessage({ ok: false, text: res.error });
      setBook(res.data);
      setPicked((p) => {
        const next: Record<string, boolean> = {};
        for (const r of res.data.rows) next[r.id] = r.importedAs == null && !r.problem && (p[r.id] ?? true);
        return next;
      });
      if (!res.data.rows.length) setMessage({ ok: true, text: "No trades in the Angel One trade book today" });
    } catch {
      setMessage({ ok: false, text: "Connection problem — please try again" });
    } finally {
      setBusy(false);
    }
  };

  const importable = (book?.rows ?? []).filter((r) => r.importedAs == null && !r.problem);
  const chosen = importable.filter((r) => picked[r.id]);

  const applyAll = () => {
    if (!allClient) return;
    setClient((c) => {
      const next = { ...c };
      for (const r of importable) if (!next[r.id]) next[r.id] = allClient;
      return next;
    });
  };

  const doImport = async () => {
    const missing = chosen.filter((r) => !client[r.id]);
    if (missing.length) return setMessage({ ok: false, text: `Choose a client for ${missing.length} selected trade(s)` });
    if (!chosen.length) return setMessage({ ok: false, text: "Nothing selected" });
    if (!confirm(`Import ${chosen.length} Angel One trade(s) of ${fmtDate(book!.date)}?`)) return;
    setBusy(true);
    const res = await actions.importAngelTrades(chosen.map((r) => ({ id: r.id, clientCode: client[r.id] })));
    setBusy(false);
    if (!res.ok) return setMessage({ ok: false, text: `Not imported: ${res.error}` });
    setMessage({ ok: true, text: `Imported ${(res.data as { imported: number }).imported} trade(s)` });
    await load();
  };

  return (
    <div className="tt-card">
      <div className="tt-card-h">
        <span>Import from Angel One</span>
        <span className="tt-muted" style={{ fontWeight: 400 }}>today&apos;s executed trades · NSE equity, futures &amp; options</span>
        <button type="button" className="tt-btn tt-btn-blue tt-btn-xs" style={{ marginLeft: "auto" }} disabled={busy}
          onClick={() => { setOpen(true); load(); }}>
          {busy ? "Loading…" : book ? "Refresh" : "Load trades"}
        </button>
        {open && <button type="button" className="tt-btn tt-btn-xs" onClick={() => setOpen(false)}>Hide</button>}
      </div>
      {open && book && book.rows.length > 0 && (
        <>
          <div className="tt-card-b flex flex-wrap items-center gap-2">
            <span>Client for all unassigned:</span>
            <select className="tt-select" style={{ width: 200 }} value={allClient} onChange={(e) => setAllClient(e.target.value)}>
              <option value="">—</option>
              {data.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} - {a.name}</option>)}
            </select>
            <button type="button" className="tt-btn tt-btn-xs" onClick={applyAll}>Apply</button>
            <button type="button" className="tt-btn tt-btn-save" style={{ marginLeft: "auto" }} disabled={busy || !chosen.length} onClick={doImport}>
              Import selected ({chosen.length})
            </button>
          </div>
          <div className="tt-grid-wrap" style={{ maxHeight: "40vh" }}>
            <table className="tt-grid">
              <thead>
                <tr>
                  <th className="ctr">
                    <input type="checkbox" checked={importable.length > 0 && chosen.length === importable.length}
                      onChange={(e) => setPicked(Object.fromEntries(importable.map((r) => [r.id, e.target.checked])))} />
                  </th>
                  <th>Time</th><th>Angel Symbol</th><th>Product</th><th>Script</th><th>B/S</th>
                  <th className="num">Quantity</th><th className="num">Price</th><th>Client</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {book.rows.map((r) => {
                  const can = r.importedAs == null && !r.problem;
                  return (
                    <tr key={r.id} className={r.side === "B" ? "buy" : "sell"}>
                      <td className="ctr">
                        {can && <input type="checkbox" checked={!!picked[r.id]} onChange={(e) => setPicked((p) => ({ ...p, [r.id]: e.target.checked }))} />}
                      </td>
                      <td>{r.time}</td>
                      <td>{r.exchange} {r.symbol}</td>
                      <td>{r.product}</td>
                      <td>{r.segment ? `${r.segment} ${r.script}${r.option ? ` ${r.strike} ${r.option}` : ""}` : ""}</td>
                      <td className={r.side === "B" ? "b-txt" : "s-txt"}>{r.side === "B" ? "BUY" : "SELL"}</td>
                      <td className="num">{fmt0(r.qty)}</td>
                      <td className="num">{fmt2(r.price)}</td>
                      <td>
                        {can && (
                          <select className="tt-select" style={{ width: 170 }} value={client[r.id] ?? ""}
                            onChange={(e) => setClient((c) => ({ ...c, [r.id]: e.target.value }))}>
                            <option value="">—</option>
                            {data.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} - {a.name}</option>)}
                          </select>
                        )}
                      </td>
                      <td>
                        {r.importedAs != null ? <span className="pos">Imported #{r.importedAs}</span> : r.problem ? <span className="neg">{r.problem}</span> : "New"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {message && <div className="tt-status"><span className={message.ok ? "ok" : "bad"}>{message.text}</span></div>}
    </div>
  );
}
