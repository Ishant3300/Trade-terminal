"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { contractLabel, fmt0, fmt2, istNow, limitTouched, marketOpen, quoteKey } from "@/lib/terminal/engine";
import type { TerminalData } from "@/lib/terminal/types";
import { useLiveQuotes } from "./quotes";
import type { TerminalActions } from "./store";

/**
 * Runs on every screen while the terminal is open: checks each of today's pending
 * limit orders against the live feed and executes it (a trade at the limit price)
 * as soon as the price reaches the limit during market hours.
 */
export function LimitWatcher({ data, actions }: { data: TerminalData; actions: TerminalActions }) {
  const today = istNow().date;
  const pending = useMemo(() => data.limitOrders.filter((o) => o.status === "PENDING" && o.date === today), [data.limitOrders, today]);
  const feed = useLiveQuotes(pending.map(quoteKey));
  const inFlight = useRef(new Set<number>());
  const [notices, setNotices] = useState<{ id: number; ok: boolean; text: string }[]>([]);

  useEffect(() => {
    for (const o of pending) {
      const q = feed.quotes[quoteKey(o)];
      if (!q || inFlight.current.has(o.id) || !marketOpen(o.segment)) continue;
      const hit = limitTouched(o, q.ltp);
      if (hit == null) continue;
      inFlight.current.add(o.id);
      const what = `${o.side === "B" ? "BUY" : "SELL"} ${fmt0(o.qty)} ${contractLabel(o)} @ ${fmt2(o.limitPrice)} — ${o.clientCode}`;
      actions.executeLimit(o.id, hit).then((res) => {
        const note = !res.ok
          ? { ok: false, text: `Limit not executed: ${what} — ${res.error}` }
          : res.data.status === "REJECTED"
            ? { ok: false, text: `Limit rejected (lot limit): ${what}` }
            : res.data.tradeId != null
              ? { ok: true, text: `Limit executed: ${what} (LTP ${fmt2(hit)}) → trade #${res.data.tradeId}` }
              : null;
        if (note) setNotices((n) => [{ id: o.id, ...note }, ...n].slice(0, 3));
        if (!res.ok) setTimeout(() => inFlight.current.delete(o.id), 10_000); // retry later
      });
    }
  }, [pending, feed.quotes, actions]);

  if (!notices.length) return null;
  return (
    <div className="tt-status" style={{ background: notices[0].ok ? "#e6f4ea" : "#fde8e7" }}>
      <span className={notices[0].ok ? "ok" : "bad"}>{notices[0].text}</span>
      <button type="button" className="tt-btn tt-btn-xs" style={{ marginLeft: "auto", alignSelf: "center" }} onClick={() => setNotices([])}>Dismiss</button>
    </div>
  );
}
