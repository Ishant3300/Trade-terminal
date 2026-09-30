"use server";

import { redirect } from "next/navigation";
import { requestIp } from "@/lib/request-ip";
import { createClient } from "@/lib/supabase/server";
import {
  accountFromRow, accountToRow, slabFromRow, slabToRow, tradeFromRow, tradeToRow,
  type AccountRow, type SlabInput, type SlabRow, type TradeInput, type TradeRow,
} from "@/lib/terminal/db";
import type { Account, Slab, Trade } from "@/lib/terminal/types";

export type Result<T = null> = { ok: true; data: T } | { ok: false; error: string };

/** Every action re-checks that the caller is signed in and an active staff member. */
async function staff() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Session expired — please log in again" } as const;
  const { data: profile } = await supabase.from("profiles").select("display_name, active").eq("id", user.id).maybeSingle();
  if (!profile?.active) return { error: "Your login is not activated" } as const;
  return { supabase, user, name: profile.display_name as string };
}

/** Postgres errors → messages an operator can act on. */
function friendly(e: { code?: string; message: string }): string {
  if (e.code === "23505") return "Already exists";
  if (e.code === "23503") return "Account is in use (has trades) or does not exist";
  if (e.code === "23514") return "Invalid value: " + e.message;
  if (e.code === "42501") return "Not allowed";
  return e.message;
}

export async function saveTrade(input: TradeInput): Promise<Result<Trade>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error! };
  const row = tradeToRow(input);
  const query =
    input.id != null
      ? s.supabase.from("trades").update(row).eq("id", input.id)
      : s.supabase.from("trades").insert({ ...row, user_id: s.user.id, user_name: s.name, ip: await requestIp() });
  const { data, error } = await query.select().single<TradeRow>();
  if (error) return { ok: false, error: friendly(error) };
  return { ok: true, data: tradeFromRow(data) };
}

export async function deleteTrade(id: number): Promise<Result> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error! };
  const { error } = await s.supabase.from("trades").delete().eq("id", id);
  return error ? { ok: false, error: friendly(error) } : { ok: true, data: null };
}

/** Saving the same client + segment + script scope updates the existing slab. */
export async function saveSlab(input: SlabInput): Promise<Result<Slab>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error! };
  const row = slabToRow(input);
  const query =
    input.id != null
      ? s.supabase.from("brokerage_slabs").update(row).eq("id", input.id)
      : s.supabase.from("brokerage_slabs").upsert(row, { onConflict: "client_code,segment,script_wise,script" });
  const { data, error } = await query.select().single<SlabRow>();
  if (error) return { ok: false, error: friendly(error) };
  return { ok: true, data: slabFromRow(data) };
}

export async function deleteSlab(id: number): Promise<Result> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error! };
  const { error } = await s.supabase.from("brokerage_slabs").delete().eq("id", id);
  return error ? { ok: false, error: friendly(error) } : { ok: true, data: null };
}

/** originalCode set = update (code may change; trades and slabs follow via ON UPDATE CASCADE). */
export async function saveAccount(account: Account, originalCode?: string): Promise<Result<Account>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error! };
  const row = accountToRow(account);
  const query = originalCode
    ? s.supabase.from("accounts").update(row).eq("code", originalCode)
    : s.supabase.from("accounts").insert(row);
  const { data, error } = await query.select().single<AccountRow>();
  if (error) return { ok: false, error: error.code === "23505" ? `Account Code ${account.code} already exists` : friendly(error) };
  return { ok: true, data: accountFromRow(data) };
}

export async function deleteAccount(code: string): Promise<Result> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error! };
  const { error } = await s.supabase.from("accounts").delete().eq("code", code);
  return error ? { ok: false, error: friendly(error) } : { ok: true, data: null };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
