"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { angelTradeBook, getQuotes, streamSetup, type AngelFill, type FeedStatus, type Quote, type StreamSetup } from "@/lib/angel";
import { checkCredentials, createSessionToken, SESSION_COOKIE, SESSION_HOURS, verifySessionToken } from "@/lib/auth";
import { settlementPrices, type SettlementPrices } from "@/lib/bhav";
import { requestIp } from "@/lib/request-ip";
import { db } from "@/lib/supabase/server";
import {
  accountFromRow, accountToRow, slabFromRow, slabToRow, tradeFromRow, tradeToRow,
  type AccountRow, type SlabInput, type SlabRow, type TradeInput, type TradeRow,
  ledgerEntryFromRow, ledgerEntryToRow, settlementFromRow,
  type LedgerEntryInput, type LedgerEntryRow, type SettlementRow,
} from "@/lib/terminal/db";
import { findInstrument, lotFromQty, valanFor } from "@/lib/terminal/engine";
import { INSTRUMENTS } from "@/lib/terminal/seed";
import type { Account, LedgerEntry, OptionType, Segment, Settlement, Slab, TerminalData, Trade } from "@/lib/terminal/types";

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
    return {
      ok: true,
      data: {
        accounts: accounts.map(accountFromRow),
        slabs: slabs.map(slabFromRow),
        trades: trades.map(tradeFromRow),
        entries: entries.map(ledgerEntryFromRow),
        settlements: settlements.map(settlementFromRow),
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

export interface SettlementInput {
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
  const { data: settlement, error } = await db()
    .from("settlements")
    .upsert({ settle_date: input.settleDate, price_date: input.priceDate, user_name: user }, { onConflict: "settle_date" })
    .select()
    .single<SettlementRow>();
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
// Import from Angel One (today's trade book)
// ---------------------------------------------------------------------------

export interface AngelTradeRow extends AngelFill {
  segment: Segment | null;
  script: string;
  option: OptionType;
  strike: number;
  lotSize: number;
  /** Already imported as this trade id. */
  importedAs: number | null;
  /** Why it cannot be imported (unknown contract, MCX/NCDEX …). */
  problem: string | null;
}

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** Angel contract key → trade fields. NSE only: MCX/NCDEX quantity units differ from this app's. */
function contractOf(fill: AngelFill): Pick<AngelTradeRow, "segment" | "script" | "option" | "strike" | "lotSize" | "problem"> {
  const none = { segment: null, script: fill.symbol, option: "" as OptionType, strike: 0, lotSize: 0 };
  if (!fill.key) return { ...none, problem: "Contract not found in the script list" };
  const [seg, name, strike, opt] = fill.key.split("|");
  if (seg !== "NSEEQ" && seg !== "NSEFUT" && seg !== "NSEOPT") return { ...none, problem: `${seg} import not supported — enter in Trade Entry` };
  const inst = findInstrument(INSTRUMENTS, seg, name);
  if (!inst) return { ...none, problem: "Contract not found in the script list" };
  return {
    segment: seg, script: inst.name, option: (seg === "NSEOPT" ? opt : "") as OptionType, strike: seg === "NSEOPT" ? Number(strike) : 0,
    lotSize: inst.lotSize, problem: !(fill.qty > 0) || !(fill.price > 0) ? "No quantity / price" : null,
  };
}

async function angelRows(): Promise<{ date: string; rows: AngelTradeRow[] }> {
  const fills = await angelTradeBook();
  const ids = fills.map((f) => f.id);
  const imported = new Map<string, number>();
  if (ids.length) {
    const { data, error } = await db().from("trades").select("id, ext_id").in("ext_id", ids);
    if (error) throw new Error(/ext_id/.test(error.message) ? "Angel import needs the database update — run supabase/schema.sql" : error.message);
    for (const r of data as { id: number; ext_id: string }[]) imported.set(r.ext_id, r.id);
  }
  return { date: istToday(), rows: fills.map((f) => ({ ...f, ...contractOf(f), importedAs: imported.get(f.id) ?? null })) };
}

export async function angelTrades(): Promise<Result<{ date: string; rows: AngelTradeRow[] }>> {
  if (!(await sessionUser())) return NOT_LOGGED_IN;
  try {
    return { ok: true, data: await angelRows() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Imports the chosen fills for the given clients. Quantity, price and contract are
 * read again from Angel One here — never taken from the browser.
 */
export async function importAngelTrades(items: { id: string; clientCode: string }[]): Promise<Result<{ imported: number }>> {
  const user = await sessionUser();
  if (!user) return NOT_LOGGED_IN;
  try {
    const { date, rows } = await angelRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const { data: accounts } = await db().from("accounts").select("code");
    const codes = new Set((accounts ?? []).map((a: { code: string }) => a.code));
    const ip = await requestIp();
    const insert = [];
    for (const item of items) {
      const r = byId.get(item.id);
      const client = item.clientCode.trim().toUpperCase();
      if (!r) return { ok: false, error: `Trade ${item.id} is no longer in the Angel One trade book` };
      if (r.importedAs != null) continue;
      if (r.problem || !r.segment) return { ok: false, error: `${r.symbol}: ${r.problem}` };
      if (!codes.has(client)) return { ok: false, error: `${r.symbol} ${r.time}: unknown client code "${item.clientCode}"` };
      insert.push({
        ...tradeToRow({
          ot: "O", date, valan: valanFor(date), segment: r.segment, script: r.script, option: r.option, strike: r.strike,
          tradeType: "NRM", side: r.side, lot: lotFromQty(r.qty, r.lotSize), qty: r.qty, rate: r.price, clientCode: client,
        }),
        ext_id: r.id, user_name: user, ip, add_time: `${date}T${r.time}+05:30`,
      });
    }
    if (!insert.length) return { ok: true, data: { imported: 0 } };
    const { error } = await db().from("trades").insert(insert);
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true, data: { imported: insert.length } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
