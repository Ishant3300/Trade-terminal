import type { Account, LedgerEntry, Settlement, Slab, Trade } from "./types";

// Row shapes of the Supabase tables (see supabase/schema.sql) and mappers to
// the app's camelCase types.

export interface AccountRow {
  code: string;
  name: string;
  type: Account["type"];
  opening_balance: number;
  opening_type: Account["openingType"];
  mobile: string;
  email: string;
  address: string;
  remark: string;
  interest_pct: number;
  max_fut_lots?: number; // absent until schema.sql adds the column
}

export interface SlabRow {
  id: number;
  client_code: string;
  segment: Slab["segment"];
  script_wise: boolean;
  script: string;
  mode: Slab["mode"];
  del_pct: number;
  intra_pct: number;
  fix_del: number;
  fix_intra: number;
  higher_side_only: boolean;
  min_rate: number;
  min_pct: number;
  min_pct_on_del: number;
}

export interface TradeRow {
  id: number;
  ot: Trade["ot"];
  trade_date: string;
  valan: string;
  segment: Trade["segment"];
  script: string;
  option_type: Trade["option"];
  strike: number;
  trade_type: Trade["tradeType"];
  side: Trade["side"];
  lot: number;
  qty: number;
  rate: number;
  client_code: string;
  full_payment?: boolean; // absent until schema.sql adds the column
  user_name: string;
  ip: string;
  add_time: string;
}

/** Fields a client may set on a trade; id / user / IP / time are set by the server. */
export type TradeInput = Omit<Trade, "id" | "user" | "ip" | "addTime"> & { id?: number };
export type SlabInput = Omit<Slab, "id"> & { id?: number };

export const accountFromRow = (r: AccountRow): Account => ({
  code: r.code,
  name: r.name,
  type: r.type,
  openingBalance: Number(r.opening_balance),
  openingType: r.opening_type,
  mobile: r.mobile,
  email: r.email,
  address: r.address,
  remark: r.remark,
  interestPct: Number(r.interest_pct),
  maxFutLots: Number(r.max_fut_lots ?? 0),
});

export const accountToRow = (a: Account): AccountRow => ({
  code: a.code,
  name: a.name,
  type: a.type,
  opening_balance: a.openingBalance,
  opening_type: a.openingType,
  mobile: a.mobile,
  email: a.email,
  address: a.address,
  remark: a.remark,
  interest_pct: a.interestPct,
  max_fut_lots: a.maxFutLots,
});

export const slabFromRow = (r: SlabRow): Slab => ({
  id: r.id,
  clientCode: r.client_code,
  segment: r.segment,
  scriptWise: r.script_wise,
  script: r.script,
  mode: r.mode,
  delPct: Number(r.del_pct),
  intraPct: Number(r.intra_pct),
  fixDel: Number(r.fix_del),
  fixIntra: Number(r.fix_intra),
  higherSideOnly: r.higher_side_only,
  minRate: Number(r.min_rate),
  minPct: Number(r.min_pct),
  minPctOnDel: Number(r.min_pct_on_del),
});

export const slabToRow = (s: SlabInput): Omit<SlabRow, "id"> => ({
  client_code: s.clientCode,
  segment: s.segment,
  script_wise: s.scriptWise,
  script: s.scriptWise ? s.script : "",
  mode: s.mode,
  del_pct: s.delPct,
  intra_pct: s.intraPct,
  fix_del: s.fixDel,
  fix_intra: s.fixIntra,
  higher_side_only: s.higherSideOnly,
  min_rate: s.minRate,
  min_pct: s.minPct,
  min_pct_on_del: s.minPctOnDel,
});

/** Timestamp in Indian time (IST, UTC+5:30) as "YYYY-MM-DD HH:MM:SS", whatever the server's time zone. */
const istStamp = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 19).replace("T", " ");

/** add_time is shown in Indian time. */
export const tradeFromRow = (r: TradeRow): Trade => {
  return {
    id: r.id,
    ot: r.ot,
    date: r.trade_date,
    valan: r.valan,
    segment: r.segment,
    script: r.script,
    option: r.option_type,
    strike: Number(r.strike),
    tradeType: r.trade_type,
    side: r.side,
    lot: r.lot,
    qty: r.qty,
    rate: Number(r.rate),
    clientCode: r.client_code,
    fullPayment: !!r.full_payment,
    user: r.user_name,
    ip: r.ip,
    addTime: istStamp(r.add_time),
  };
};

export const tradeToRow = (t: TradeInput) => ({
  ot: t.ot,
  trade_date: t.date,
  valan: t.valan,
  segment: t.segment,
  script: t.script,
  option_type: t.option,
  strike: t.option ? t.strike : 0,
  trade_type: t.tradeType,
  side: t.side,
  lot: t.lot,
  qty: t.qty,
  rate: t.rate,
  client_code: t.clientCode,
  full_payment: !!t.fullPayment,
});

export interface LedgerEntryRow {
  id: number;
  client_code: string;
  entry_date: string;
  kind: LedgerEntry["kind"];
  amount: number;
  narration: string;
  user_name: string;
}

export const ledgerEntryFromRow = (r: LedgerEntryRow): LedgerEntry => ({
  id: r.id,
  clientCode: r.client_code,
  date: r.entry_date,
  kind: r.kind,
  amount: Number(r.amount),
  narration: r.narration,
  user: r.user_name,
});

export type LedgerEntryInput = Omit<LedgerEntry, "id" | "user"> & { id?: number };

export const ledgerEntryToRow = (e: LedgerEntryInput) => ({
  client_code: e.clientCode,
  entry_date: e.date,
  kind: e.kind,
  amount: e.amount,
  narration: e.narration,
});

export interface SettlementRow {
  id: number;
  settle_date: string;
  price_date: string;
  settlement_prices?: { script: string; price: number; source: string }[];
}

export const settlementFromRow = (r: SettlementRow): Settlement => ({
  id: r.id,
  settleDate: r.settle_date,
  priceDate: r.price_date,
  prices: Object.fromEntries((r.settlement_prices ?? []).map((p) => [p.script, Number(p.price)])),
  sources: Object.fromEntries((r.settlement_prices ?? []).map((p) => [p.script, p.source])),
});
