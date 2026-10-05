import { createHmac } from "node:crypto";
import tokens from "@/lib/terminal/angel-tokens.json";
import { db } from "@/lib/supabase/server";
import { parseContract } from "@/lib/terminal/engine";

// Angel One SmartAPI market data, server-only.
//
// Credentials (env): ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN, ANGEL_TOTP_SECRET.
// They can place orders on the account, so they never leave the server.
//
// Login uses a TOTP generated from the secret, so no daily manual step. The
// session is shared through the broker_session table so every server instance
// reuses one login instead of each logging in separately.

const ROOT = "https://apiconnect.angelone.in";
const TOKEN_MAP = tokens as Record<string, string>;
const MAX_TOKENS_PER_CALL = 50; // Angel limit
const CACHE_MS = 2000; // share quotes between screens / users
const BACKOFF_MS = 15_000; // after a rate-limit or login failure

export interface Quote {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Best bid / ask from market depth; null when that side is empty. */
  bid: number | null;
  ask: number | null;
  bidQty: number;
  askQty: number;
}

export type FeedStatus = "live" | "not-configured" | "error";

export function feedConfigured(): boolean {
  return !!(process.env.ANGEL_API_KEY && process.env.ANGEL_CLIENT_CODE && process.env.ANGEL_PIN && process.env.ANGEL_TOTP_SECRET);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238: SHA-1, 30 s, 6 digits) from the base32 secret Angel shows
// when enabling TOTP.
// ---------------------------------------------------------------------------

function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/[\s=-]/g, "").toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error("ANGEL_TOTP_SECRET is not valid base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, "0");
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function headers(jwt?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": process.env.ANGEL_API_KEY!,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

// Most endpoints answer { status, errorcode }, some { success, errorCode }.
interface AngelResponse<T> {
  status?: boolean;
  success?: boolean;
  message: string;
  errorcode?: string;
  errorCode?: string;
  data: T;
}

class AngelError extends Error {
  constructor(message: string, readonly code: string, readonly http: number) {
    super(message);
  }
}

/** Angel's firewall answers blocked requests with an HTML "Request Rejected" page. */
function describeNonJson(text: string): string {
  if (!/^\s*</.test(text)) return text.slice(0, 160);
  const support = /support id is:?\s*([\w-]+)/i.exec(text)?.[1];
  if (/request rejected/i.test(text)) return `Blocked by Angel One firewall (Request Rejected${support ? `, Support ID ${support}` : ""})`;
  const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
  return `Unexpected HTML response${title ? `: ${title}` : ""}`;
}

async function post<T>(path: string, body: unknown, jwt?: string): Promise<T> {
  const res = await fetch(ROOT + path, { method: "POST", headers: headers(jwt), body: JSON.stringify(body), cache: "no-store" });
  const text = await res.text();
  let json: AngelResponse<T> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // Rate limiting and gateway errors come back as plain text.
  }
  if (!res.ok || !(json?.status ?? json?.success)) {
    const msg = json?.message || describeNonJson(text) || `HTTP ${res.status}`;
    throw new AngelError(msg, json?.errorcode || json?.errorCode || "", res.status);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface Session {
  jwt: string;
  /** Market-data-only token for the WebSocket stream (cannot place orders). */
  feedToken: string;
  day: string; // IST date the login was made; sessions end daily
}

let session: Session | null = null;
let blockedUntil = 0;
let lastError = "";

const istDay = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

async function loadStoredSession(): Promise<Session | null> {
  try {
    const { data } = await db().from("broker_session").select("jwt, feed_token, day").eq("id", 1).maybeSingle();
    return data?.jwt && data.feed_token && data.day === istDay()
      ? { jwt: data.jwt, feedToken: data.feed_token, day: data.day }
      : null;
  } catch {
    return null; // table missing → memory-only session
  }
}

async function storeSession(s: Session) {
  try {
    await db().from("broker_session").upsert({ id: 1, jwt: s.jwt, feed_token: s.feedToken, day: s.day, updated_at: new Date().toISOString() });
  } catch {
    // Non-fatal: falls back to per-instance sessions.
  }
}

async function login(): Promise<Session> {
  const data = await post<{ jwtToken: string; feedToken: string }>("/rest/auth/angelbroking/user/v1/loginByPassword", {
    clientcode: process.env.ANGEL_CLIENT_CODE,
    password: process.env.ANGEL_PIN,
    totp: totp(process.env.ANGEL_TOTP_SECRET!),
  });
  const s = { jwt: data.jwtToken, feedToken: data.feedToken, day: istDay() };
  await storeSession(s);
  return s;
}

async function getSession(forceLogin = false): Promise<Session> {
  if (!forceLogin && session && session.day === istDay()) return session;
  if (!forceLogin) {
    const stored = await loadStoredSession();
    if (stored) return (session = stored);
  }
  return (session = await login());
}

const isAuthError = (e: unknown) =>
  e instanceof AngelError && (/^AG800[1-3]$/.test(e.code) || e.http === 401 || /invalid token|token expired/i.test(e.message));

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; quote: Quote | null }>();

interface Fetched {
  exchange: string;
  symbolToken: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  depth?: { buy?: DepthLevel[]; sell?: DepthLevel[] };
}

interface DepthLevel {
  price: number;
  quantity: number;
}

/** Top of book; Angel pads empty depth levels with price 0. */
const best = (levels: DepthLevel[] | undefined) => {
  const top = levels?.find((l) => +l.price > 0 && +l.quantity > 0);
  return top ? { price: +top.price, qty: +top.quantity } : null;
};

async function fetchTokens(byExchange: Record<string, string[]>, jwt: string) {
  const data = await post<{ fetched: Fetched[] }>(
    "/rest/secure/angelbroking/market/v1/quote/",
    { mode: "FULL", exchangeTokens: byExchange },
    jwt
  );
  return data.fetched ?? [];
}

/**
 * Quotes for the given quote keys (see quoteKey()). Unknown contracts map to
 * null. Results are cached for CACHE_MS so several screens polling at once
 * cost one Angel request.
 */
export async function getQuotes(keys: string[]): Promise<{ status: FeedStatus; message?: string; quotes: Record<string, Quote | null> }> {
  const quotes: Record<string, Quote | null> = {};
  if (!feedConfigured()) return { status: "not-configured", quotes };

  const now = Date.now();
  const stale: string[] = [];
  for (const key of new Set(keys)) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) quotes[key] = hit.quote;
    else if (!TOKEN_MAP[key]) quotes[key] = null;
    else stale.push(key);
  }
  if (!stale.length) return { status: "live", quotes };

  if (now < blockedUntil) {
    for (const key of stale) quotes[key] = cache.get(key)?.quote ?? null;
    return { status: "error", message: lastError, quotes };
  }

  try {
    const keyByToken = new Map(stale.map((k) => [TOKEN_MAP[k], k]));
    for (let i = 0; i < stale.length; i += MAX_TOKENS_PER_CALL) {
      const batch: Record<string, string[]> = {};
      for (const key of stale.slice(i, i + MAX_TOKENS_PER_CALL)) {
        const [exch, token] = TOKEN_MAP[key].split(":");
        (batch[exch] ??= []).push(token);
      }
      let fetched: Fetched[];
      try {
        fetched = await fetchTokens(batch, (await getSession()).jwt);
      } catch (e) {
        if (!isAuthError(e)) throw e;
        fetched = await fetchTokens(batch, (await getSession(true)).jwt);
      }
      for (const f of fetched) {
        const key = keyByToken.get(`${f.exchange}:${f.symbolToken}`);
        if (!key) continue;
        const bid = best(f.depth?.buy);
        const ask = best(f.depth?.sell);
        const quote: Quote = {
          ltp: +f.ltp, open: +f.open, high: +f.high, low: +f.low, close: +f.close,
          bid: bid?.price ?? null, ask: ask?.price ?? null, bidQty: bid?.qty ?? 0, askQty: ask?.qty ?? 0,
        };
        cache.set(key, { at: Date.now(), quote });
        quotes[key] = quote;
      }
    }
    for (const key of stale) quotes[key] ??= null;
    lastError = "";
    return { status: "live", quotes };
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    blockedUntil = Date.now() + BACKOFF_MS;
    for (const key of stale) quotes[key] = cache.get(key)?.quote ?? null;
    return { status: "error", message: lastError, quotes };
  }
}

// ---------------------------------------------------------------------------
// Diagnostics (/feed-status)
// ---------------------------------------------------------------------------

export interface FeedCheck {
  step: string;
  ok: boolean;
  detail: string;
}

const describe = (e: unknown) =>
  e instanceof AngelError
    ? `${e.message}${e.code ? ` (code ${e.code})` : ""}${e.http !== 200 ? ` [HTTP ${e.http}]` : ""}`
    : e instanceof Error
      ? e.message
      : String(e);

/** Step-by-step feed check: settings → server → Angel login → one NIFTY quote. Never reveals secrets. */
export async function diagnoseFeed(): Promise<FeedCheck[]> {
  const checks: FeedCheck[] = [];
  const vars = ["ANGEL_API_KEY", "ANGEL_CLIENT_CODE", "ANGEL_PIN", "ANGEL_TOTP_SECRET"];
  const missing = vars.filter((v) => !process.env[v]);
  checks.push({ step: "Angel settings", ok: !missing.length, detail: missing.length ? `Missing: ${missing.join(", ")}` : "All 4 present" });

  let ip = "unknown";
  try {
    ip = (await (await fetch("https://api.ipify.org", { cache: "no-store" })).text()).trim();
  } catch {
    // informational only
  }
  checks.push({ step: "Server", ok: true, detail: `Region ${process.env.VERCEL_REGION ?? "local"}, public IP ${ip}` });
  if (missing.length) return checks;

  let jwt: string;
  try {
    jwt = (await getSession(true)).jwt;
    checks.push({ step: "Angel login", ok: true, detail: "Logged in" });
  } catch (e) {
    checks.push({ step: "Angel login", ok: false, detail: describe(e) });
    return checks;
  }

  const today = istDay();
  const niftyFut = Object.keys(TOKEN_MAP)
    .filter((k) => k.startsWith("NSEFUT|NIFTY "))
    .map((k) => ({ k, exp: parseContract(k.slice(7))?.expiry ?? "" }))
    .filter((x) => x.exp >= today)
    .sort((a, b) => a.exp.localeCompare(b.exp))[0]?.k;
  if (!niftyFut) {
    checks.push({ step: "Quote", ok: false, detail: "No NIFTY futures contract in angel-tokens.json — run npm run update:fo" });
    return checks;
  }
  try {
    const [exch, token] = TOKEN_MAP[niftyFut].split(":");
    const f = (await fetchTokens({ [exch]: [token] }, jwt))[0];
    checks.push({ step: "Quote", ok: !!f, detail: f ? `${niftyFut.slice(7)} LTP ${f.ltp}` : "Angel returned no data" });
  } catch (e) {
    checks.push({ step: "Quote", ok: false, detail: describe(e) });
  }
  blockedUntil = 0; // a successful check clears any back-off
  return checks;
}

// ---------------------------------------------------------------------------
// Streaming (browser WebSocket)
// ---------------------------------------------------------------------------

export interface StreamSetup {
  status: FeedStatus;
  message?: string;
  /** wss URL including the read-only feed token; null when unavailable. */
  url: string | null;
  /** quote key → "<angel exchange>:<token>" for the requested keys that exist. */
  tokens: Record<string, string>;
}

/**
 * What the browser needs to stream quotes straight from Angel: the stream URL
 * (client code, API key and the market-data-only feed token — never the PIN,
 * TOTP secret or trading JWT) and the Angel tokens for the requested keys.
 */
export async function streamSetup(keys: string[], refresh = false): Promise<StreamSetup> {
  const tokens: Record<string, string> = {};
  for (const k of keys) if (TOKEN_MAP[k]) tokens[k] = TOKEN_MAP[k];
  if (!feedConfigured()) return { status: "not-configured", url: null, tokens };
  try {
    const s = await getSession(refresh);
    const q = new URLSearchParams({
      clientCode: process.env.ANGEL_CLIENT_CODE!,
      feedToken: s.feedToken,
      apiKey: process.env.ANGEL_API_KEY!,
    });
    return { status: "live", url: `wss://smartapisocket.angelone.in/smart-stream?${q}`, tokens };
  } catch (e) {
    return { status: "error", message: describe(e), url: null, tokens };
  }
}
