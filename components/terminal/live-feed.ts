"use client";

import { liveStreamSetup } from "@/app/actions";
import type { FeedStatus, Quote } from "@/lib/angel";

// One shared WebSocket to Angel One's SmartAPI stream (WebSocket 2.0) for the
// whole app. Screens acquire the quote keys they show; the feed subscribes to
// exactly those, decodes the binary SNAP_QUOTE packets (LTP, OHLC, best bid /
// ask) and notifies at most every FLUSH_MS.

const MODE_SNAP_QUOTE = 3;
const EXCHANGE_TYPE: Record<string, number> = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, NCDEX: 7, CDS: 13 };
const PAISE = 100; // stream prices are in paise
const FLUSH_MS = 150;
const HEARTBEAT_MS = 10_000;
const RETRY_MS = [1000, 2000, 5000, 10_000, 15_000];

export interface FeedSnapshot {
  status: FeedStatus | "connecting";
  message?: string;
  quotes: Record<string, Quote | null>;
}

type Listener = () => void;

const i64 = (dv: DataView, at: number) => Number(dv.getBigInt64(at, true));

/** Decodes one SNAP_QUOTE packet (layout from Angel's smartWebSocketV2). */
function decode(buf: ArrayBuffer): { exchangeType: number; token: string; quote: Quote } | null {
  if (buf.byteLength < 123) return null;
  const dv = new DataView(buf);
  let token = "";
  for (let i = 2; i < 27; i++) {
    const c = dv.getUint8(i);
    if (!c) break;
    token += String.fromCharCode(c);
  }
  const quote: Quote = {
    ltp: i64(dv, 43) / PAISE,
    open: i64(dv, 91) / PAISE,
    high: i64(dv, 99) / PAISE,
    low: i64(dv, 107) / PAISE,
    close: i64(dv, 115) / PAISE,
    bid: null,
    ask: null,
    bidQty: 0,
    askQty: 0,
  };
  if (dv.getUint8(0) === MODE_SNAP_QUOTE && buf.byteLength >= 347) {
    // Best 5 each side, 20 bytes per level: flag (1 = buy, 0 = sell), qty, price, orders.
    for (let i = 0; i < 10; i++) {
      const at = 147 + i * 20;
      const isBuy = dv.getUint16(at, true) === 1;
      const qty = i64(dv, at + 2);
      const price = i64(dv, at + 10) / PAISE;
      if (price <= 0 || qty <= 0) continue;
      if (isBuy && quote.bid === null) {
        quote.bid = price;
        quote.bidQty = qty;
      } else if (!isBuy && quote.ask === null) {
        quote.ask = price;
        quote.askQty = qty;
      }
    }
  }
  return { exchangeType: dv.getUint8(1), token, quote };
}

class LiveFeed {
  private snapshot: FeedSnapshot = { status: "connecting", quotes: {} };
  private quotes: Record<string, Quote | null> = {};
  private listeners = new Set<Listener>();
  private refs = new Map<string, number>();
  private tokenOf = new Map<string, string>(); // quote key → "NFO:48704"
  private keyOf = new Map<string, string>(); // "2:48704" → quote key
  private unknown = new Set<string>(); // keys Angel has no token for
  private subscribed = new Set<string>();
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private retry = 0;
  private setupInFlight = false;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  acquire(keys: string[]) {
    for (const k of keys) this.refs.set(k, (this.refs.get(k) ?? 0) + 1);
    this.scheduleSync();
  }

  release(keys: string[]) {
    for (const k of keys) {
      const n = (this.refs.get(k) ?? 0) - 1;
      if (n > 0) this.refs.set(k, n);
      else this.refs.delete(k);
    }
    this.scheduleSync();
  }

  private publish(status: FeedSnapshot["status"], message?: string) {
    this.snapshot = { status, message, quotes: this.quotes };
    this.listeners.forEach((l) => l());
  }

  private scheduleFlush() {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      this.quotes = { ...this.quotes };
      this.publish(this.snapshot.status, this.snapshot.message);
    }, FLUSH_MS);
  }

  private scheduleSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.sync(), 50);
  }

  /** Make the socket's subscriptions match the keys screens are showing. */
  private async sync(refresh = false) {
    const wanted = [...this.refs.keys()];
    if (!wanted.length) return;
    const missing = wanted.filter((k) => !this.tokenOf.has(k) && !this.unknown.has(k));
    if ((missing.length || !this.url || refresh) && !this.setupInFlight) {
      this.setupInFlight = true;
      try {
        const setup = await liveStreamSetup(missing.length ? missing : wanted.slice(0, 1), refresh);
        for (const k of missing) {
          const t = setup.tokens[k];
          if (!t) {
            this.unknown.add(k);
            this.quotes[k] = null;
            continue;
          }
          this.tokenOf.set(k, t);
          const [exch, token] = t.split(":");
          this.keyOf.set(`${EXCHANGE_TYPE[exch]}:${token}`, k);
        }
        if (setup.status !== "live" || !setup.url) {
          this.publish(setup.status, setup.message);
          return;
        }
        if (setup.url !== this.url) {
          this.url = setup.url;
          this.ws?.close();
          this.ws = null;
        }
      } catch {
        this.publish("error", "Connection problem");
        return;
      } finally {
        this.setupInFlight = false;
      }
    }
    if (!this.ws) return this.connect();
    if (this.ws.readyState === WebSocket.OPEN) this.diff();
  }

  private connect() {
    if (!this.url) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.subscribed.clear();
    ws.onopen = () => {
      this.retry = 0;
      this.publish("live");
      this.heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), HEARTBEAT_MS);
      this.diff();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") return; // "pong" / control messages
      const tick = decode(e.data as ArrayBuffer);
      const key = tick && this.keyOf.get(`${tick.exchangeType}:${tick.token}`);
      if (!tick || !key) return;
      this.quotes[key] = tick.quote;
      this.scheduleFlush();
    };
    ws.onclose = () => {
      clearInterval(this.heartbeat);
      if (this.ws !== ws) return; // replaced on purpose
      this.ws = null;
      if (!this.refs.size) return;
      const wait = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
      this.retry++;
      // After repeated failures, report an error so screens fall back to polling.
      if (this.retry >= 3) this.publish("error", "Live stream disconnected — retrying");
      // A rejected feed token closes the socket immediately: refresh it on retry.
      setTimeout(() => void this.sync(this.retry >= 2), wait);
    };
  }

  private send(action: 0 | 1, keys: string[]) {
    if (!keys.length || this.ws?.readyState !== WebSocket.OPEN) return;
    const byType = new Map<number, string[]>();
    for (const k of keys) {
      const [exch, token] = this.tokenOf.get(k)!.split(":");
      const type = EXCHANGE_TYPE[exch];
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(token);
    }
    this.ws.send(
      JSON.stringify({
        correlationID: "tt",
        action,
        params: { mode: MODE_SNAP_QUOTE, tokenList: [...byType].map(([exchangeType, tokens]) => ({ exchangeType, tokens })) },
      })
    );
  }

  private diff() {
    const wanted = [...this.refs.keys()].filter((k) => this.tokenOf.has(k));
    const add = wanted.filter((k) => !this.subscribed.has(k));
    const drop = [...this.subscribed].filter((k) => !this.refs.has(k));
    this.send(1, add);
    this.send(0, drop);
    add.forEach((k) => this.subscribed.add(k));
    drop.forEach((k) => this.subscribed.delete(k));
  }
}

export const liveFeed = new LiveFeed();
