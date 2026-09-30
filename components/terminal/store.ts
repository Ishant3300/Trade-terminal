"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { computeTradeCalcs } from "@/lib/terminal/engine";
import { createEmptyData, INSTRUMENTS } from "@/lib/terminal/seed";
import type { Account, Slab, TerminalData, Trade } from "@/lib/terminal/types";

const STORAGE_KEY = "tradeterminal.v2";

export type Action =
  | { type: "saveTrade"; trade: Omit<Trade, "id"> & { id?: number } }
  | { type: "deleteTrade"; id: number }
  | { type: "saveSlab"; slab: Omit<Slab, "id"> & { id?: number } }
  | { type: "deleteSlab"; id: number }
  | { type: "saveAccount"; account: Account; originalCode?: string }
  | { type: "deleteAccount"; code: string }
  | { type: "reset" };

function reducer(state: TerminalData, action: Action): TerminalData {
  switch (action.type) {
    case "saveTrade": {
      const { id, ...rest } = action.trade;
      if (id != null) return { ...state, trades: state.trades.map((t) => (t.id === id ? { ...rest, id } : t)) };
      return { ...state, trades: [...state.trades, { ...rest, id: state.nextTradeId }], nextTradeId: state.nextTradeId + 1 };
    }
    case "deleteTrade":
      return { ...state, trades: state.trades.filter((t) => t.id !== action.id) };
    case "saveSlab": {
      const { id, ...rest } = action.slab;
      // One slab per client + segment + script scope: saving the same scope updates it.
      const existing =
        id ??
        state.slabs.find(
          (s) => s.clientCode === rest.clientCode && s.segment === rest.segment &&
            s.scriptWise === rest.scriptWise && s.script === rest.script
        )?.id;
      if (existing != null) return { ...state, slabs: state.slabs.map((s) => (s.id === existing ? { ...rest, id: existing } : s)) };
      return { ...state, slabs: [...state.slabs, { ...rest, id: state.nextSlabId }], nextSlabId: state.nextSlabId + 1 };
    }
    case "deleteSlab":
      return { ...state, slabs: state.slabs.filter((s) => s.id !== action.id) };
    case "saveAccount": {
      const orig = action.originalCode;
      if (orig) {
        const recode = <T extends { clientCode: string }>(x: T): T =>
          x.clientCode === orig ? { ...x, clientCode: action.account.code } : x;
        return {
          ...state,
          accounts: state.accounts.map((a) => (a.code === orig ? action.account : a)),
          trades: state.trades.map(recode),
          slabs: state.slabs.map(recode),
        };
      }
      return { ...state, accounts: [...state.accounts, action.account] };
    }
    case "deleteAccount":
      return {
        ...state,
        accounts: state.accounts.filter((a) => a.code !== action.code),
        slabs: state.slabs.filter((s) => s.clientCode !== action.code),
      };
    case "reset":
      return createEmptyData();
  }
}

function load(): TerminalData {
  try {
    localStorage.removeItem("tradeterminal.v1"); // old demo data

    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as TerminalData;
  } catch {
    // Corrupt storage falls back to seed data.
  }
  return createEmptyData();
}

/** Terminal state, persisted to localStorage. Only rendered client-side (ssr: false). */
export function useTerminalStore() {
  const [data, dispatch] = useReducer(reducer, undefined, load);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);
  const calcs = useMemo(() => computeTradeCalcs(data.trades, data.slabs, INSTRUMENTS), [data.trades, data.slabs]);
  return { data, dispatch, calcs };
}

export interface Tick {
  ltp: number;
  low: number;
  high: number;
}

export const tickKey = (segment: string, name: string) => `${segment}|${name}`;

/** Mock market feed: a small random walk on every instrument. */
export function useTicker(intervalMs = 1500) {
  const [ticks, setTicks] = useState<Record<string, Tick>>(() =>
    Object.fromEntries(INSTRUMENTS.map((i) => [tickKey(i.segment, i.name), { ltp: i.ltp, low: i.low, high: i.high }]))
  );
  useEffect(() => {
    const timer = setInterval(() => {
      setTicks((prev) => {
        const next: Record<string, Tick> = {};
        for (const i of INSTRUMENTS) {
          const k = tickKey(i.segment, i.name);
          const p = prev[k];
          const step = i.ltp * 0.0004 * (Math.random() * 2 - 1);
          const ltp = +Math.min(Math.max(p.ltp + step, i.ltp * 0.97), i.ltp * 1.03).toFixed(2);
          next[k] = { ltp, low: Math.min(p.low, ltp), high: Math.max(p.high, ltp) };
        }
        return next;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return ticks;
}
