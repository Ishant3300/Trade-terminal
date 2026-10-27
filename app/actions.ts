"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getQuotes, streamSetup, type FeedStatus, type Quote, type StreamSetup } from "@/lib/angel";
import { checkCredentials, createSessionToken, SESSION_COOKIE, SESSION_HOURS, verifySessionToken } from "@/lib/auth";
import { ncdexSettlementPrices, settlementPrices, type SettlementPrices } from "@/lib/bhav";
import { requestIp } from "@/lib/request-ip";
import { db } from "@/lib/supabase/server";
import {
  accountFromRow, accountToRow, slabFromRow, slabToRow, tradeFromRow, tradeToRow,
  type AccountRow, type SlabInput, type SlabRow, type TradeInput, type TradeRow,
  ledgerEntryFromRow, ledgerEntryToRow, settlementFromRow,
  type LedgerEntryInput, type LedgerEntryRow, type SettlementRow,
  limitOrderFromRow, type LimitOrderRow,
} from "@/lib/terminal/db";
import { addDays, findInstrument, istNow, limitBlockedReason, lotFromQty, openFutLots, quoteKey, valanFor } from "@/lib/terminal/engine";
import { INSTRUMENTS } from "@/lib/terminal/seed";
import type { Account, LedgerEntry, LimitOrder, Settlement, Slab, TerminalData, Trade } from "@/lib/terminal/types";

export type Result<T = null> = { ok: true; data: T } | { ok: false; error: string };

// Server Functions are reachable by direct POST, so each one checks the session.
async function sessionUser(): Promise<string | null> {
  return verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}

const NOT_LOGGED_IN = { ok: false, error: "Session expired — please log in again", expired: true } as const;

/** Postgres errors → messages an operator can act on. */
function friendly(e: { code?: string; message: string }): string {
  if (e.code === "23505") return "Already exists";
  if (e.code === "23503") return "Account is in use (has trades) or does not exist";
  if (e.code === "23514") return "Invalid value: " + e.message;
  return e.message;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function login(username: string, password: string): Promise<Result> {
  if (!checkCredentials(username, password)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down password guessing
    return { ok: false, error: "Wrong username or password" };
  }
  (await cookies()).set(SESSION_COOKIE, createSessionToken(username.trim().toLowerCase()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  return { ok: true, data: null };
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const PAGE = 1000; // Supabase returns at most 1000 rows per request

async function fetchAll<T>(table: string, order: string, columns = "*"): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db().from(table).select(columns).order(order).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data as T[]));
    if (data.length < PAGE) return rows;
  }
}

export async function loadAll(): Promise<Result<TerminalData>> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  try {
    const [accounts, slabs, trades] = await Promise.all([
      fetchAll<AccountRow>("accounts", "code"),
      fetchAll<SlabRow>("brokerage_slabs", "id"),
      fetchAll<TradeRow>("trades", "id"),
    ]);
    // Ledger tables come from a later schema.sql; work without them until it is run.
    let entries: LedgerEntryRow[] = [];
    let settlements: SettlementRow[] = [];
    let ledgerSetupNeeded = false;
    try {
      [entries, settlements] = await Promise.all([
        fetchAll<LedgerEntryRow>("ledger_entries", "id"),
        fetchAll<SettlementRow>("settlements", "settle_date", "*, settlement_prices(*)"),
      ]);
    } catch {
      ledgerSetupNeeded = true;
    }
    // Limit orders (later schema.sql): Day orders past their date expire; load the last 30 days.
    let limitOrders: LimitOrderRow[] = [];
    let limitSetupNeeded = false;
    const today = istNow().date;
    const expired = await db().from("limit_orders").update({ status: "EXPIRED", note: "Day order not filled" }).eq("status", "PENDING").lt("order_date", today);
    if (expired.error) limitSetupNeeded = true;
    else {
      const { data, error } = await db().from("limit_orders").select("*").gte("order_date", addDays(today, -30)).order("id", { ascending: false }).limit(1000);
      if (error) limitSetupNeeded = true;
      else limitOrders = data as LimitOrderRow[];
    }
    return {
      ok: true,
      data: {
        accounts: accounts.map(accountFromRow),
        slabs: slabs.map(slabFromRow),
        trades: trades.map(tradeFromRow),
        entries: entries.map(ledgerEntryFromRow),
        settlements: settlements.map(settlementFromRow),
        limitOrders: limitOrders.map(limitOrderFromRow),
        limitSetupNeeded,
        ledgerSetupNeeded,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function saveTrade(input: TradeInput): Promise<Result<Trade>> {
  const user = await sessionUser();
  if (!user) return NOT_LOGGED_IN;
  const write = (row: Partial<TradeRow>) =>
    (input.id != null
      ? db().from("trades").update(row).eq("id", input.id)
      : db().from("trades").insert({ ...row, user_name: user })
    ).select().single<TradeRow>();
  const row: Partial<TradeRow> = tradeToRow(input);
  if (input.id == null) row.ip = await requestIp();
  let { data, error } = await write(row);
  // Database not yet migrated (no full_payment column): save without it.
  if (error && /full_payment/.test(error.message)) {
    if (input.fullPayment) return { ok: false, error: "Full Payment needs the database update — run supabase/schema.sql" };
    delete row.full_payment;
    ({ data, error } = await write(row));
  }
  if (error || !data) return { ok: false, error: error ? friendly(error) : "Not saved" };
  return { ok: true, data: tradeFromRow(data) };
}

export async function deleteTrade(id: number): Promise<Result> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  const { error } = await db().from("trades").delete().eq("id", id);
  return error ? { ok: false, error: friendly(error) } : { ok: true, data: null };
}

/** Saving the same client + segment + script scope updates the existing slab. */
export async function saveSlab(input: SlabInput): Promise<Result<Slab>> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  const row = slabToRow(input);
  const query =
    input.id != null
      ? db().from("brokerage_slabs").update(row).eq("id", input.id)
      : db().from("brokerage_slabs").upsert(row, { onConflict: "client_code,segment,script_wise,script" });
  const { data, error } = await query.select().single<SlabRow>();
  if (error) return { ok: false, error: friendly(error) };
  return { ok: true, data: slabFromRow(data) };
}

export async function deleteSlab(id: number): Promise<Result> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  const { error } = await db().from("brokerage_slabs").delete().eq("id", id);
  return error ? { ok: false, error: friendly(error) } : { ok: true, data: null };
}

/** originalCode set = update (code may change; trades and slabs follow via ON UPDATE CASCADE). */
export async function saveAccount(account: Account, originalCode?: string): Promise<Result<Account>> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  const write = (row: AccountRow) =>
    (originalCode ? db().from("accounts").update(row).eq("code", originalCode) : db().from("accounts").insert(row))
      .select()
      .single<AccountRow>();
  const row = accountToRow(account);
  let { data, error } = await write(row);
  // Database not yet migrated (no max_fut_lots column): save without it.
  if (error && /max_fut_lots/.test(error.message)) {
    if (account.maxFutLots) return { ok: false, error: "Max NSEFUT Lots needs the database update — run supabase/schema.sql" };
    delete row.max_fut_lots;
    ({ data, error } = await write(row));
  }
  if (error || !data) return { ok: false, error: !error ? "Not saved" : error.code === "23505" ? `Account Code ${account.code} already exists` : friendly(error) };
  return { ok: true, data: accountFromRow(data) };
}

export async function deleteAccount(code: string): Promise<Result> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  const { error } = await db().from("accounts").delete().eq("code", code);
  return error ? { ok: false, error: friendly(error) } : { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// Live prices (Angel One SmartAPI)
// ---------------------------------------------------------------------------

export interface QuotesResult {
  status: FeedStatus;
  message?: string;
  quotes: Record<string, Quote | null>;
}

/** Quotes for quote keys (see quoteKey()); capped to keep within Angel's rate limits. */
export async function liveQuotes(keys: string[]): Promise<QuotesResult> {
  if (!(await sessionUser())) return { status: "error", message: NOT_LOGGED_IN.error, quotes: {} };
  if (!Array.isArray(keys)) return { status: "error", message: "Bad request", quotes: {} };
  return getQuotes(keys.filter((k) => typeof k === "string").slice(0, 250));
}

/** Stream URL (read-only feed token) and Angel tokens for live WebSocket quotes. */
export async function liveStreamSetup(keys: string[], refresh = false): Promise<StreamSetup> {
  if (!(await sessionUser())) return { status: "error", message: NOT_LOGGED_IN.error, url: null, tokens: {} };
  if (!Array.isArray(keys)) return { status: "error", message: "Bad request", url: null, tokens: {} };
  return streamSetup(keys.filter((k) => typeof k === "string").slice(0, 900), refresh === true);
}

// ---------------------------------------------------------------------------
// Ledger entries (deposit / withdrawal / journals)
// ---------------------------------------------------------------------------

const LEDGER_SETUP = "Ledger tables missing — run supabase/schema.sql in Supabase";
const setupError = (e: { message: string }) => (/ledger_entries|settlement/.test(e.message) ? LEDGER_SETUP : friendly(e));

export async function saveLedgerEntry(input: LedgerEntryInput): Promise<Result<LedgerEntry>> {
  const user = await sessionUser();
  if (!user) return NOT_LOGGED_IN;
  if (!(input.amount > 0)) return { ok: false, error: "Amount must be more than 0" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, error: "Invalid date" };
  const row = ledgerEntryToRow(input);
  const query =
    input.id != null
      ? db().from("ledger_entries").update(row).eq("id", input.id)
      : db().from("ledger_entries").insert({ ...row, user_name: user });
  const { data, error } = await query.select().single<LedgerEntryRow>();
  if (error || !data) return { ok: false, error: error ? setupError(error) : "Not saved" };
  return { ok: true, data: ledgerEntryFromRow(data) };
}

export async function deleteLedgerEntry(id: number): Promise<Result> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  const { error } = await db().from("ledger_entries").delete().eq("id", id);
  return error ? { ok: false, error: setupError(error) } : { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// Monthly settlement
// ---------------------------------------------------------------------------

/** Bhav close (NSE, Angel fallback) on the last trading day on or before `monthEnd`. */
export async function fetchSettlementPrices(monthEnd: string, scripts: string[]): Promise<Result<SettlementPrices>> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monthEnd) || !Array.isArray(scripts)) return { ok: false, error: "Bad request" };
  return { ok: true, data: await settlementPrices(monthEnd, scripts.filter((x) => typeof x === "string").slice(0, 2000)) };
}

/** NCDEX settlement prices for the week ending `friday` (contracts as "CASTOR 16OCT2026"). */
export async function fetchNcdexPrices(friday: string, contracts: string[]): Promise<Result<SettlementPrices>> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(friday) || !Array.isArray(contracts)) return { ok: false, error: "Bad request" };
  return { ok: true, data: await ncdexSettlementPrices(friday, contracts.filter((x) => typeof x === "string").slice(0, 500)) };
}

export interface SettlementInput {
  segment: Settlement["segment"];
  settleDate: string;
  priceDate: string;
  prices: Record<string, { price: number; source: string }>;
}

/** Creates or replaces the settlement for `settleDate` with the given prices. */
export async function saveSettlement(input: SettlementInput): Promise<Result<Settlement>> {
  const user = await sessionUser();
  if (!user) return NOT_LOGGED_IN;
  const bad = Object.entries(input.prices).filter(([, p]) => !(p.price > 0)).map(([s]) => s);
  if (bad.length) return { ok: false, error: `Enter a price for: ${bad.join(", ")}` };
  if (input.segment !== "NSEEQ" && input.segment !== "NCDEX") return { ok: false, error: "Bad segment" };
  const head = { settle_date: input.settleDate, price_date: input.priceDate, user_name: user };
  let { data: settlement, error } = await db()
    .from("settlements")
    .upsert({ ...head, segment: input.segment }, { onConflict: "segment,settle_date" })
    .select()
    .single<SettlementRow>();
  // Database not yet migrated (no segment column): NSE monthly still works.
  if (error && /segment|constraint matching/i.test(error.message)) {
    if (input.segment !== "NSEEQ") return { ok: false, error: "NCDEX weekly settlement needs the database update — run supabase/schema.sql" };
    ({ data: settlement, error } = await db().from("settlements").upsert(head, { onConflict: "settle_date" }).select().single<SettlementRow>());
  }
  if (error || !settlement) return { ok: false, error: error ? setupError(error) : "Not saved" };
  const del = await db().from("settlement_prices").delete().eq("settlement_id", settlement.id);
  if (del.error) return { ok: false, error: setupError(del.error) };
  const rows = Object.entries(input.prices).map(([script, p]) => ({ settlement_id: settlement.id, script, price: p.price, source: p.source }));
  if (rows.length) {
    const ins = await db().from("settlement_prices").insert(rows);
    if (ins.error) return { ok: false, error: setupError(ins.error) };
  }
  return { ok: true, data: settlementFromRow({ ...settlement, settlement_prices: rows }) };
}

export async function deleteSettlement(id: number): Promise<Result> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  const { error } = await db().from("settlements").delete().eq("id", id);
  return error ? { ok: false, error: setupError(error) } : { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// Limit orders (Day)
// ---------------------------------------------------------------------------

export type LimitInput = Pick<LimitOrder, "segment" | "script" | "option" | "strike" | "side" | "qty" | "limitPrice" | "clientCode"> & {
  /** LTP the terminal showed; the server's own live quote is preferred. */
  ltp?: number | null;
};

const limitSetup = (e: { message: string }) =>
  /limit_orders|ref_price/.test(e.message) ? "Limit orders need the database update — run supabase/schema.sql" : e.message;

/** Server copy of the Trade Entry lot-limit check: would this NSEFUT order take the client over Max NSEFUT Lots? */
async function futLotCheck(clientCode: string, script: string, side: "B" | "S", qty: number, date: string): Promise<string | null> {
  const { data: acc } = await db().from("accounts").select("max_fut_lots").eq("code", clientCode).maybeSingle();
  const max = Number((acc as { max_fut_lots?: number } | null)?.max_fut_lots ?? 0);
  if (!max) return null;
  const { data, error } = await db().from("trades").select("*").eq("client_code", clientCode).eq("segment", "NSEFUT");
  if (error) return error.message;
  const trades = (data as TradeRow[]).map(tradeFromRow);
  const before = openFutLots(trades, INSTRUMENTS, clientCode, date);
  const probe: Trade = {
    id: -1, ot: "T", date, valan: "", segment: "NSEFUT", script, option: "", strike: 0, tradeType: "NRM", side, lot: 0, qty,
    rate: 0, clientCode, user: "", ip: "", addTime: "",
  };
  const after = openFutLots([...trades, probe], INSTRUMENTS, clientCode, date);
  const f = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return after > max && after > before ? `${clientCode} limit is ${max} NSEFUT lots — open ${f(before)}, this order would make ${f(after)}` : null;
}

function validLimit(x: LimitInput): string | null {
  if (!findInstrument(INSTRUMENTS, x.segment, x.script)) return `Invalid script "${x.script}" for ${x.segment}`;
  if (!(x.qty > 0) || !Number.isInteger(x.qty)) return "Enter a whole quantity";
  if (!(x.limitPrice > 0)) return "Enter a limit price";
  if (x.side !== "B" && x.side !== "S") return "Bad side";
  return null;
}

/** Places a Day limit order for today (IST), or with `id` modifies one that is still pending. */
export async function saveLimit(input: LimitInput & { id?: number }): Promise<Result<LimitOrder>> {
  const user = await sessionUser();
  if (!user) return NOT_LOGGED_IN;
  const bad = validLimit(input) ?? limitBlockedReason(input.segment);
  if (bad) return { ok: false, error: bad };
  const today = istNow().date;
  if (input.segment === "NSEFUT") {
    const over = await futLotCheck(input.clientCode, input.script, input.side, input.qty, today);
    if (over) return { ok: false, error: over };
  }
  // Touch-style: remember where the LTP is now, so the order waits for the price to come to the limit.
  let ref = Number(input.ltp) > 0 ? Number(input.ltp) : null;
  try {
    const key = quoteKey({ segment: input.segment, script: input.script, option: input.option, strike: input.strike });
    const q = (await getQuotes([key])).quotes[key];
    if (q && q.ltp > 0) ref = q.ltp;
  } catch {
    // live quote unavailable: keep the terminal's LTP
  }
  if (ref == null) return { ok: false, error: "No live price for this contract — a limit needs the current LTP" };
  const row = {
    segment: input.segment, script: input.script, option_type: input.option, strike: input.option ? input.strike : 0,
    side: input.side, qty: input.qty, limit_price: input.limitPrice, ref_price: ref, client_code: input.clientCode,
  };
  const query = input.id != null
    ? db().from("limit_orders").update(row).eq("id", input.id).eq("status", "PENDING")
    : db().from("limit_orders").insert({ ...row, order_date: today, user_name: user });
  const { data, error } = await query.select().maybeSingle<LimitOrderRow>();
  if (error) return { ok: false, error: limitSetup(error) };
  if (!data) return { ok: false, error: "This limit is no longer pending" };
  return { ok: true, data: limitOrderFromRow(data) };
}

export async function cancelLimit(id: number): Promise<Result> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  const { data, error } = await db().from("limit_orders").update({ status: "CANCELLED" }).eq("id", id).eq("status", "PENDING").select("id");
  if (error) return { ok: false, error: limitSetup(error) };
  return data?.length ? { ok: true, data: null } : { ok: false, error: "This limit is no longer pending" };
}

/**
 * Executes a pending limit (a terminal saw the live price reach it): books a trade at
 * the limit price, now, for the client. Only one caller can move it out of PENDING, so
 * two open terminals never create two trades.
 */
export async function executeLimit(id: number, triggerPrice: number): Promise<Result<{ tradeId: number | null; status: LimitOrder["status"] }>> {
  const user = await sessionUser();
  if (!user) return NOT_LOGGED_IN;
  const now = istNow();
  const { data: claimed, error } = await db()
    .from("limit_orders")
    .update({ status: "EXECUTED", trigger_price: triggerPrice, executed_at: new Date().toISOString() })
    .eq("id", id).eq("status", "PENDING").eq("order_date", now.date)
    .select().maybeSingle<LimitOrderRow>();
  if (error) return { ok: false, error: limitSetup(error) };
  if (!claimed) return { ok: true, data: { tradeId: null, status: "EXECUTED" } }; // handled by another terminal
  const o = limitOrderFromRow(claimed);
  if (o.segment === "NSEFUT") {
    const over = await futLotCheck(o.clientCode, o.script, o.side, o.qty, now.date);
    if (over) {
      await db().from("limit_orders").update({ status: "REJECTED", note: over, executed_at: null }).eq("id", id);
      return { ok: true, data: { tradeId: null, status: "REJECTED" } };
    }
  }
  const inst = findInstrument(INSTRUMENTS, o.segment, o.script);
  const { data: trade, error: tErr } = await db()
    .from("trades")
    .insert({
      ...tradeToRow({
        ot: "O", date: now.date, valan: valanFor(now.date), segment: o.segment, script: o.script, option: o.option, strike: o.strike,
        tradeType: "NRM", side: o.side, lot: lotFromQty(o.qty, inst?.lotSize ?? 1), qty: o.qty, rate: o.limitPrice, clientCode: o.clientCode,
      }),
      user_name: `${o.user || user} (limit)`, ip: await requestIp(),
    })
    .select("id").single<{ id: number }>();
  if (tErr || !trade) {
    await db().from("limit_orders").update({ status: "PENDING", trigger_price: null, executed_at: null }).eq("id", id);
    return { ok: false, error: tErr ? friendly(tErr) : "Trade not saved" };
  }
  await db().from("limit_orders").update({ trade_id: trade.id }).eq("id", id);
  return { ok: true, data: { tradeId: trade.id, status: "EXECUTED" } };
}
