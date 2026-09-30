"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getQuotes, type FeedStatus, type Quote } from "@/lib/angel";
import { checkCredentials, createSessionToken, SESSION_COOKIE, SESSION_HOURS, verifySessionToken } from "@/lib/auth";
import { requestIp } from "@/lib/request-ip";
import { db } from "@/lib/supabase/server";
import {
  accountFromRow, accountToRow, slabFromRow, slabToRow, tradeFromRow, tradeToRow,
  type AccountRow, type SlabInput, type SlabRow, type TradeInput, type TradeRow,
} from "@/lib/terminal/db";
import type { Account, Slab, TerminalData, Trade } from "@/lib/terminal/types";

export type Result<T = null> = { ok: true; data: T } | { ok: false; error: string };

// Server Functions are reachable by direct POST, so each one checks the session.
async function sessionUser(): Promise<string | null> {
  return verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}

const NOT_LOGGED_IN = { ok: false, error: "Session expired — please log in again" } as const;

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

async function fetchAll<T>(table: string, order: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db().from(table).select("*").order(order).range(from, from + PAGE - 1);
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
    return {
      ok: true,
      data: { accounts: accounts.map(accountFromRow), slabs: slabs.map(slabFromRow), trades: trades.map(tradeFromRow) },
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
  const row = tradeToRow(input);
  const query =
    input.id != null
      ? db().from("trades").update(row).eq("id", input.id)
      : db().from("trades").insert({ ...row, user_name: user, ip: await requestIp() });
  const { data, error } = await query.select().single<TradeRow>();
  if (error) return { ok: false, error: friendly(error) };
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
  const row = accountToRow(account);
  const query = originalCode
    ? db().from("accounts").update(row).eq("code", originalCode)
    : db().from("accounts").insert(row);
  const { data, error } = await query.select().single<AccountRow>();
  if (error) return { ok: false, error: error.code === "23505" ? `Account Code ${account.code} already exists` : friendly(error) };
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
