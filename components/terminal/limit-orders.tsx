"use client";

import { useState } from "react";
import { contractLabel, fmt0, fmt2, istNow, quoteKey } from "@/lib/terminal/engine";
import type { LimitOrder, LimitStatus, TerminalData } from "@/lib/terminal/types";
import { useLiveQuotes } from "./quotes";
import type { TerminalActions } from "./store";

const STATUS_STYLE: Record<LimitStatus, { bg: string; fg: string; label: string }> = {
  PENDING: { bg: "#fff4d6", fg: "#7a4b00", label: "Pending" },
  EXECUTED: { bg: "#e3f4e8", fg: "#1a7f37", label: "Executed" },
  CANCELLED: { bg: "#eef0f3", fg: "#5d6673", label: "Cancelled" },
  EXPIRED: { bg: "#eef0f3", fg: "#5d6673", label: "Expired" },
  REJECTED: { bg: "#fde8e7", fg: "#b71c1c", label: "Rejected" },
};

/** Today's Day limit orders with live price, status, and Modify / Cancel while pending. */
export function LimitOrders({ data, actions, onModify }: { data: TerminalData; actions: TerminalActions; onModify: (o: LimitOrder) => void }) {
  const today = istNow().date;
  const [show, setShow] = useState<"ALL" | LimitStatus>("ALL");
  const [message, setMessage] = useState<string | null>(null);
  const todays = data.limitOrders.filter((o) => o.date === today);
  const pending = todays.filter((o) => o.status === "PENDING");
  const feed = useLiveQuotes(pending.map(quoteKey));
  const nameOf = new Map(data.accounts.map((a) => [a.code, a.name]));
  const rows = todays.filter((o) => show === "ALL" || o.status === show);
  const count = (s: LimitStatus) => todays.filter((o) => o.status === s).length;

  const cancel = async (o: LimitOrder) => {
    if (!confirm(`Cancel limit: ${o.side === "B" ? "BUY" : "SELL"} ${o.qty} ${contractLabel(o)} @ ${o.limitPrice} (${o.clientCode})?`)) return;
    const res = await actions.cancelLimit(o.id);
    setMessage(res.ok ? null : `Not cancelled: ${res.error}`);
  };

  return (
    <div className="tt-card">
      <div className="tt-card-h">
        <span>Limit Orders — {today.split("-").reverse().join("-")}</span>
        <span className="tt-muted" style={{ fontWeight: 400 }}>Day orders · execute at the limit price when the LTP touches it, rising or falling from where it was when placed (terminal must be open)</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {(["ALL", "PENDING", "EXECUTED", "CANCELLED", "REJECTED"] as const).map((s) => (
            <button key={s} type="button" className={`tt-btn tt-btn-xs${show === s ? " tt-btn-blue" : ""}`} onClick={() => setShow(s)}>
              {s === "ALL" ? `All ${todays.length}` : `${STATUS_STYLE[s].label} ${count(s)}`}
            </button>
          ))}
        </span>
      </div>
      {data.limitSetupNeeded && (
        <div className="tt-status"><span className="bad">Limit orders need the database update — run the limit_orders part of supabase/schema.sql in Supabase.</span></div>
      )}
      {message && <div className="tt-status"><span className="bad">{message}</span></div>}
      <div className="tt-grid-wrap" style={{ maxHeight: "35vh" }}>
        <table className="tt-grid">
          <thead>
            <tr>
              <th>Placed</th><th>Customer Name</th><th>Segment</th><th>Script Name</th><th>B/S</th><th className="num">Quantity</th>
              <th className="num">Limit Price</th><th className="num">LTP</th><th>Status</th><th className="ctr">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const q = feed.quotes[quoteKey(o)];
              const live = q && q.ltp > 0 ? q.ltp : null;
              const rising = o.refPrice != null ? o.refPrice <= o.limitPrice : o.side === "S";
              const away = live ? (Math.abs(live - o.limitPrice) / o.limitPrice) * 100 : null;
              const st = STATUS_STYLE[o.status];
              return (
                <tr key={o.id} className={o.side === "B" ? "buy" : "sell"}>
                  <td>{o.createdAt.slice(11)}</td>
                  <td>{o.clientCode} - {nameOf.get(o.clientCode) ?? "?"}</td>
                  <td>{o.segment}</td>
                  <td>{contractLabel(o)}</td>
                  <td className={o.side === "B" ? "b-txt" : "s-txt"}>{o.side === "B" ? "BUY" : "SELL"}</td>
                  <td className="num">{fmt0(o.qty)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{fmt2(o.limitPrice)}</td>
                  <td className="num">
                    {o.status === "PENDING" ? (live ? fmt2(live) : "—") : o.triggerPrice != null ? <span className="tt-muted">{fmt2(o.triggerPrice)}</span> : ""}
                  </td>
                  <td>
                    <span style={{ background: st.bg, color: st.fg, padding: "1px 8px", borderRadius: 3, fontWeight: 600 }} title={o.note}>
                      {st.label}
                      {o.status === "PENDING" && ` · waits for LTP to ${rising ? "rise ↑" : "fall ↓"}`}
                      {o.status === "PENDING" && away != null && ` ${away.toFixed(2)}% away`}
                      {o.status === "EXECUTED" && o.executedAt && ` ${o.executedAt.slice(11)}`}
                    </span>
                    {o.status === "EXECUTED" && o.tradeId != null && <span className="tt-muted"> → trade #{o.tradeId}</span>}
                    {o.status === "REJECTED" && <span className="bad"> {o.note}</span>}
                  </td>
                  <td className="ctr">
                    {o.status === "PENDING" && (
                      <>
                        <button type="button" className="tt-btn tt-btn-blue tt-btn-xs" onClick={() => onModify(o)}>Modify</button>{" "}
                        <button type="button" className="tt-btn tt-btn-red tt-btn-xs" onClick={() => cancel(o)}>Cancel</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={10} className="empty">No limit orders today. Choose Order: Limit in Trade Entry to place one.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
