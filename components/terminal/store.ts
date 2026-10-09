"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as server from "@/app/actions";
import type { Result } from "@/app/actions";
import type { LedgerEntryInput, SlabInput, TradeInput } from "@/lib/terminal/db";
import { computeTradeCalcs } from "@/lib/terminal/engine";
import { INSTRUMENTS } from "@/lib/terminal/seed";
import type { Account, TerminalData } from "@/lib/terminal/types";

/**
 * Wraps a server action: network failures become an error result, and an
 * expired login sends the user back to the login page.
 */
async function safe<T>(call: Promise<Result<T>>): Promise<Result<T>> {
  try {
    const res = await call;
    if (!res.ok && "expired" in res && res.expired) window.location.replace(`${window.location.origin}/login`);
    return res;
  } catch {
    return { ok: false, error: "Connection problem — please try again" };
  }
}

/** How often to pick up other operators' changes while the tab is visible. */
const REFRESH_MS = 15_000;

export interface TerminalActions {
  saveTrade(trade: TradeInput): Promise<Result<unknown>>;
  deleteTrade(id: number): Promise<Result<unknown>>;
  saveSlab(slab: SlabInput): Promise<Result<unknown>>;
  deleteSlab(id: number): Promise<Result<unknown>>;
  saveAccount(account: Account, originalCode?: string): Promise<Result<unknown>>;
  deleteAccount(code: string): Promise<Result<unknown>>;
  saveLedgerEntry(entry: LedgerEntryInput): Promise<Result<unknown>>;
  deleteLedgerEntry(id: number): Promise<Result<unknown>>;
  saveSettlement(input: server.SettlementInput): Promise<Result<unknown>>;
  deleteSettlement(id: number): Promise<Result<unknown>>;
}

/**
 * Terminal data. All reads and writes go through server actions (the browser
 * never talks to the database); data reloads after each write and every
 * REFRESH_MS while the tab is visible.
 */
export function useTerminalStore() {
  const [data, setData] = useState<TerminalData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await safe(server.loadAll());
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled && document.visibilityState === "visible") reload();
    };
    safe(server.loadAll()).then((res) => {
      if (cancelled) return;
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [reload]);

  const actions = useMemo<TerminalActions>(() => {
    const after = async <T,>(res: Result<T>) => {
      if (res.ok) await reload();
      return res;
    };
    return {
      saveTrade: (t) => safe(server.saveTrade(t)).then(after),
      deleteTrade: (id) => safe(server.deleteTrade(id)).then(after),
      saveSlab: (s) => safe(server.saveSlab(s)).then(after),
      deleteSlab: (id) => safe(server.deleteSlab(id)).then(after),
      saveAccount: (a, orig) => safe(server.saveAccount(a, orig)).then(after),
      deleteAccount: (code) => safe(server.deleteAccount(code)).then(after),
      saveLedgerEntry: (e) => safe(server.saveLedgerEntry(e)).then(after),
      deleteLedgerEntry: (id) => safe(server.deleteLedgerEntry(id)).then(after),
      saveSettlement: (x) => safe(server.saveSettlement(x)).then(after),
      deleteSettlement: (id) => safe(server.deleteSettlement(id)).then(after),
    };
  }, [reload]);

  const calcs = useMemo(
    () => computeTradeCalcs(data?.trades ?? [], data?.slabs ?? [], INSTRUMENTS),
    [data?.trades, data?.slabs]
  );
  return { data, error, actions, calcs };
}
