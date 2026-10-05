"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { liveQuotes, type QuotesResult } from "@/app/actions";
import { liveFeed } from "./live-feed";

const EMPTY: QuotesResult = { status: "live", quotes: {} };

/**
 * Live quotes for the given keys. Streams tick-by-tick over Angel's WebSocket
 * (see live-feed.ts); if the stream is down, falls back to polling the REST
 * quote API every `fallbackMs` (keep ≥ 2 s: ~5,000 calls/hour allowed).
 */
export function useLiveQuotes(keys: string[], fallbackMs = 3000): QuotesResult {
  const signature = [...new Set(keys)].sort().join(",");
  const stream = useSyncExternalStore(liveFeed.subscribe, liveFeed.getSnapshot, liveFeed.getSnapshot);
  const [polled, setPolled] = useState<QuotesResult>(EMPTY);

  useEffect(() => {
    const list = signature ? signature.split(",") : [];
    if (!list.length) return;
    liveFeed.acquire(list);
    return () => liveFeed.release(list);
  }, [signature]);

  const streamDown = stream.status === "error";
  useEffect(() => {
    const list = signature ? signature.split(",") : [];
    if (!list.length || !streamDown) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await liveQuotes(list);
        if (!cancelled) setPolled(res);
      } catch {
        // Network blip: keep the last prices and try again next tick.
      }
    };
    poll();
    const timer = setInterval(poll, fallbackMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [signature, fallbackMs, streamDown]);

  return useMemo<QuotesResult>(() => {
    if (!signature) return EMPTY;
    if (streamDown) return { ...polled, message: polled.message ?? stream.message };
    const quotes: QuotesResult["quotes"] = {};
    for (const k of signature.split(",")) if (k in stream.quotes) quotes[k] = stream.quotes[k];
    return { status: stream.status === "connecting" ? "live" : stream.status, message: stream.message, quotes };
  }, [signature, stream, streamDown, polled]);
}
