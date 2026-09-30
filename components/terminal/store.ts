"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as server from "@/app/actions";
import type { Result } from "@/app/actions";
import { createClient } from "@/lib/supabase/client";
import {
  accountFromRow, slabFromRow, tradeFromRow,
  type AccountRow, type SlabInput, type SlabRow, type TradeInput, type TradeRow,
} from "@/lib/terminal/db";
import { computeTradeCalcs } from "@/lib/terminal/engine";
import { INSTRUMENTS } from "@/lib/terminal/seed";
import type { Account, TerminalData } from "@/lib/terminal/types";

type Table = "accounts" | "brokerage_slabs" | "trades";
const ORDER: Record<Table, string> = { accounts: "code", brokerage_slabs: "id", trades: "id" };
const PAGE = 1000; // Supabase returns at most 1000 rows per request

type Supabase = ReturnType<typeof createClient>;

async function fetchAll<T>(supabase: Supabase, table: Table): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select("*").order(ORDER[table]).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data as T[]));
    if (data.length < PAGE) return rows;
  }
}

async function load(supabase: Supabase, table: Table): Promise<Partial<TerminalData>> {
  if (table === "accounts") return { accounts: (await fetchAll<AccountRow>(supabase, table)).map(accountFromRow) };
  if (table === "brokerage_slabs") return { slabs: (await fetchAll<SlabRow>(supabase, table)).map(slabFromRow) };
  return { trades: (await fetchAll<TradeRow>(supabase, table)).map(tradeFromRow) };
}

export interface TerminalActions {
  saveTrade(trade: TradeInput): Promise<Result<unknown>>;
  deleteTrade(id: number): Promise<Result<unknown>>;
  saveSlab(slab: SlabInput): Promise<Result<unknown>>;
  deleteSlab(id: number): Promise<Result<unknown>>;
  saveAccount(account: Account, originalCode?: string): Promise<Result<unknown>>;
  deleteAccount(code: string): Promise<Result<unknown>>;
}

/**
 * Terminal data from Supabase. Writes go through server actions (which stamp
 * user + IP); every table is reloaded after a write and whenever another
 * operator changes it (Supabase Realtime).
 */
export function useTerminalStore() {
  const supabase = useMemo(() => createClient(), []);
  const [data, setData] = useState<TerminalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<Partial<Record<Table, ReturnType<typeof setTimeout>>>>({});

  const reload = useCallback(
    async (table: Table) => {
      try {
        const part = await load(supabase, table);
        setData((d) => (d ? { ...d, ...part } : d));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [supabase]
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all((["accounts", "brokerage_slabs", "trades"] as Table[]).map((t) => load(supabase, t)))
      .then((parts) => {
        if (!cancelled) setData(Object.assign({ accounts: [], slabs: [], trades: [] }, ...parts));
      })
      .catch((e: Error) => !cancelled && setError(e.message));

    const pending = timers.current;
    const channel = supabase.channel("terminal-changes");
    for (const table of ["accounts", "brokerage_slabs", "trades"] as Table[]) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, () => {
        clearTimeout(pending[table]);
        pending[table] = setTimeout(() => reload(table), 250);
      });
    }
    channel.subscribe();
    return () => {
      cancelled = true;
      Object.values(pending).forEach(clearTimeout);
      supabase.removeChannel(channel);
    };
  }, [supabase, reload]);

  const actions = useMemo<TerminalActions>(() => {
    const after = <T,>(tables: Table[]) => async (res: Result<T>) => {
      if (res.ok) await Promise.all(tables.map(reload));
      return res;
    };
    return {
      saveTrade: (t) => server.saveTrade(t).then(after(["trades"])),
      deleteTrade: (id) => server.deleteTrade(id).then(after(["trades"])),
      saveSlab: (s) => server.saveSlab(s).then(after(["brokerage_slabs"])),
      deleteSlab: (id) => server.deleteSlab(id).then(after(["brokerage_slabs"])),
      saveAccount: (a, orig) => server.saveAccount(a, orig).then(after(["accounts", "brokerage_slabs", "trades"])),
      deleteAccount: (code) => server.deleteAccount(code).then(after(["accounts", "brokerage_slabs"])),
    };
  }, [reload]);

  const calcs = useMemo(
    () => computeTradeCalcs(data?.trades ?? [], data?.slabs ?? [], INSTRUMENTS),
    [data?.trades, data?.slabs]
  );
  return { data, error, actions, calcs };
}
