"use client";

import { useEffect, useState } from "react";
import { liveQuotes, type QuotesResult } from "@/app/actions";

const EMPTY: QuotesResult = { status: "live", quotes: {} };

/**
 * Polls live quotes for the given keys every `intervalMs` while the tab is
 * visible. Keep intervals ≥ 2 s: Angel allows ~5,000 quote calls an hour.
 */
export function useLiveQuotes(keys: string[], intervalMs = 3000): QuotesResult {
  const [result, setResult] = useState<QuotesResult>(EMPTY);
  const signature = [...new Set(keys)].sort().join(",");

  useEffect(() => {
    const list = signature ? signature.split(",") : [];
    if (!list.length) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await liveQuotes(list);
        if (!cancelled) setResult(res);
      } catch {
        // Network blip: keep the last prices and try again next tick.
      }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [signature, intervalMs]);

  return signature ? result : EMPTY;
}
