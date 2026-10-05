import { MCX_FUTURES, NCDEX_FUTURES } from "./exchange-master";
import { FO_LOTS } from "./fo-master";
import {
  DERIVATIVE_SEGMENTS,
  type Account,
  type Instrument,
  type Segment,
  type Slab,
  type Trade,
} from "./types";

// ---------------------------------------------------------------------------
// Dates & formatting
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toTimeStr(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return toDateStr(new Date(y, m - 1, d + days));
}

/** Weekly settlement label: Monday–Friday of the date's week, e.g. "SEP 28-02". */
export function valanFor(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const offset = (date.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(y, m - 1, d - offset);
  const friday = new Date(y, m - 1, d - offset + 4);
  return `${MONTHS[monday.getMonth()]} ${pad(monday.getDate())}-${pad(friday.getDate())}`;
}

/** DD-MM-YYYY for grids. */
export function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}-${m}-${y}`;
}

const nf2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export const fmt2 = (n: number) => nf2.format(Math.abs(n) < 0.005 ? 0 : n);
export const fmt0 = (n: number) => nf0.format(n);

// ---------------------------------------------------------------------------
// Script & lot size engine
// ---------------------------------------------------------------------------

/** "NIFTY" + "2026-10-27" → "NIFTY 27OCT2026" */
export function contractName(symbol: string, expiry: string): string {
  const [y, m, d] = expiry.split("-");
  return `${symbol} ${d}${MONTHS[Number(m) - 1]}${y}`;
}

/** "NIFTY 27OCT2026" → { symbol: "NIFTY", expiry: "2026-10-27" } */
export function parseContract(name: string): { symbol: string; expiry: string } | null {
  const m = /^(\S+) (\d{2})([A-Z]{3})(\d{4})$/.exec(name.trim().toUpperCase());
  const month = m ? MONTHS.indexOf(m[3]) : -1;
  if (!m || month < 0) return null;
  return { symbol: m[1], expiry: `${m[4]}-${pad(month + 1)}-${m[2]}` };
}

const instrumentIndex = new WeakMap<Instrument[], Map<string, Instrument>>();

/** Contract currently in the script master (listed), or undefined. */
export function findListed(instruments: Instrument[], segment: Segment, name: string) {
  let index = instrumentIndex.get(instruments);
  if (!index) {
    index = new Map(instruments.map((i) => [`${i.segment}|${i.name}`, i]));
    instrumentIndex.set(instruments, index);
  }
  return index.get(`${segment}|${name.trim().toUpperCase()}`);
}

/**
 * Listed contract, or — for derivative contracts that have since expired and
 * dropped out of the master — one rebuilt from the symbol's lot size, so old
 * trades keep their lot size and script-wise slabs.
 */
export function findInstrument(instruments: Instrument[], segment: Segment, name: string): Instrument | undefined {
  const listed = findListed(instruments, segment, name);
  if (listed || segment === "NSEEQ") return listed;
  const parsed = parseContract(name);
  const lotSize = !parsed
    ? undefined
    : segment === "MCXFUT"
      ? MCX_FUTURES[parsed.symbol]?.lot
      : segment === "NCDEX"
        ? NCDEX_FUTURES[parsed.symbol]?.lot
        : FO_LOTS[parsed.symbol];
  if (!parsed || !lotSize) return undefined;
  return { name: name.trim().toUpperCase(), symbol: parsed.symbol, segment, lotSize, expiry: parsed.expiry };
}

export function qtyFromLot(lot: number, lotSize: number): number {
  return lot * lotSize;
}

export function lotFromQty(qty: number, lotSize: number): number {
  return lotSize > 0 ? Math.floor(qty / lotSize) : 0;
}

/** Derivative quantities snap to the nearest whole lot (minimum one lot). */
export function snapQty(qty: number, lotSize: number, segment: Segment): number {
  if (!DERIVATIVE_SEGMENTS.has(segment) || lotSize <= 1 || qty <= 0) return qty;
  return Math.max(1, Math.round(qty / lotSize)) * lotSize;
}

/** Identity of a tradable contract (options include type + strike). */
export function instrumentKey(t: Pick<Trade, "segment" | "script" | "option" | "strike">): string {
  return `${t.segment}|${t.script}|${t.option}|${t.option ? t.strike : ""}`;
}

/** Live-quote key; matches scripts/update-angel-tokens.mjs. */
export function quoteKey(t: Pick<Trade, "segment" | "script" | "option" | "strike">): string {
  return t.option ? `${t.segment}|${t.script}|${t.strike}|${t.option}` : `${t.segment}|${t.script}`;
}

export function contractLabel(t: Pick<Trade, "script" | "option" | "strike">): string {
  return t.option ? `${t.script} ${t.strike} ${t.option}` : t.script;
}

// ---------------------------------------------------------------------------
// Brokerage engine
// ---------------------------------------------------------------------------

/** Script-wise slab (matched on underlying symbol) wins over the segment-wise slab. */
export function findSlab(slabs: Slab[], clientCode: string, segment: Segment, symbol: string): Slab | null {
  return (
    slabs.find((s) => s.clientCode === clientCode && s.segment === segment && s.scriptWise && s.script === symbol) ??
    slabs.find((s) => s.clientCode === clientCode && s.segment === segment && !s.scriptWise) ??
    null
  );
}

/** Brokerage for one portion (intraday or delivery) of an execution. */
export function portionBrokerage(
  slab: Slab,
  portion: "intra" | "del",
  rate: number,
  qty: number,
  lotSize: number
): number {
  if (qty <= 0) return 0;
  if (slab.mode === "FIX") {
    const amount = portion === "intra" ? slab.fixIntra : slab.fixDel;
    return amount * (qty / Math.max(1, lotSize));
  }
  // Minimum % / Min % On Del act as floors on the configured percentage.
  const pct = portion === "intra" ? Math.max(slab.intraPct, slab.minPct) : Math.max(slab.delPct, slab.minPctOnDel);
  let perUnit = rate * (pct / 100);
  if (slab.minRate > 0 && perUnit < slab.minRate) perUnit = slab.minRate;
  return perUnit * qty;
}

export interface TradeCalc {
  slab: Slab | null;
  lotSize: number;
  intraQty: number;
  delQty: number;
  /** Intraday portion was waived because the opposite side had higher turnover. */
  intraWaived: boolean;
  brokerage: number;
  brokPerUnit: number;
  netRate: number;
}

/**
 * Computes brokerage and net rate for every trade.
 *
 * Trades are grouped by date + client + contract. Within a group the matched
 * quantity min(ΣBuy, ΣSell) is intraday, allocated FIFO by entry time on each
 * side; the remainder is delivery. With "Higher Side Only" the intraday
 * portion is charged only on the side with the larger intraday turnover.
 * CF / BF entries are settlement carry-overs: no brokerage, not matched.
 */
export function computeTradeCalcs(
  trades: Trade[],
  slabs: Slab[],
  instruments: Instrument[]
): Map<number, TradeCalc> {
  const result = new Map<number, TradeCalc>();
  const groups = new Map<string, Trade[]>();

  for (const t of trades) {
    const inst = findInstrument(instruments, t.segment, t.script);
    const lotSize = inst?.lotSize ?? 1;
    if (t.tradeType !== "NRM") {
      result.set(t.id, {
        slab: null, lotSize, intraQty: 0, delQty: t.qty, intraWaived: false,
        brokerage: 0, brokPerUnit: 0, netRate: t.rate,
      });
      continue;
    }
    const key = `${t.date}|${t.clientCode}|${instrumentKey(t)}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  for (const list of groups.values()) {
    const first = list[0];
    const inst = findInstrument(instruments, first.segment, first.script);
    const lotSize = inst?.lotSize ?? 1;
    const slab = findSlab(slabs, first.clientCode, first.segment, inst?.symbol ?? first.script);

    const ordered = [...list].sort((a, b) => a.addTime.localeCompare(b.addTime) || a.id - b.id);
    const buys = ordered.filter((t) => t.side === "B");
    const sells = ordered.filter((t) => t.side === "S");
    const matched = Math.min(
      buys.reduce((s, t) => s + t.qty, 0),
      sells.reduce((s, t) => s + t.qty, 0)
    );

    const intraBySide = (side: Trade[]) => {
      let left = matched;
      return side.map((t) => {
        const intra = Math.min(t.qty, left);
        left -= intra;
        return { t, intra };
      });
    };
    const buyAlloc = intraBySide(buys);
    const sellAlloc = intraBySide(sells);

    let chargeBuyIntra = true;
    let chargeSellIntra = true;
    if (slab?.higherSideOnly && matched > 0) {
      const buyTurn = buyAlloc.reduce((s, a) => s + a.t.rate * a.intra, 0);
      const sellTurn = sellAlloc.reduce((s, a) => s + a.t.rate * a.intra, 0);
      chargeBuyIntra = buyTurn >= sellTurn;
      chargeSellIntra = !chargeBuyIntra;
    }

    for (const { t, intra } of [...buyAlloc, ...sellAlloc]) {
      const del = t.qty - intra;
      const chargeIntra = t.side === "B" ? chargeBuyIntra : chargeSellIntra;
      let brokerage = 0;
      if (slab) {
        if (chargeIntra) brokerage += portionBrokerage(slab, "intra", t.rate, intra, lotSize);
        brokerage += portionBrokerage(slab, "del", t.rate, del, lotSize);
      }
      const brokPerUnit = t.qty > 0 ? brokerage / t.qty : 0;
      result.set(t.id, {
        slab,
        lotSize,
        intraQty: intra,
        delQty: del,
        intraWaived: intra > 0 && !chargeIntra,
        brokerage,
        brokPerUnit,
        netRate: t.side === "B" ? t.rate + brokPerUnit : t.rate - brokPerUnit,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Positions & ledger
// ---------------------------------------------------------------------------

export interface Position {
  key: string;
  clientCode: string;
  segment: Segment;
  label: string;
  buyQty: number;
  sellQty: number;
  avgBuy: number; // net-rate average
  avgSell: number;
  netQty: number;
  lastRate: number; // live price, else last traded rate in this contract
  live: boolean; // lastRate came from the live feed
  quoteKey: string;
  realized: number; // on net rates (brokerage included)
  mtm: number; // unrealized on open qty vs last rate, net rates
  grossRealized: number; // on trade rates
  grossMtm: number;
  brokerage: number;
}

/**
 * MTM is marked to the live price when `livePrices` (by quoteKey) has one,
 * otherwise to the last rate traded in the contract.
 */
export function computePositions(
  trades: Trade[],
  calcs: Map<number, TradeCalc>,
  livePrices: Record<string, number> = {}
): Position[] {
  const lastTraded = new Map<string, number>();
  for (const t of [...trades].sort((a, b) => a.addTime.localeCompare(b.addTime) || a.id - b.id)) {
    lastTraded.set(instrumentKey(t), t.rate);
  }

  const map = new Map<string, { sample: Trade; bq: number; bn: number; bg: number; sq: number; sn: number; sg: number; brk: number }>();
  for (const t of trades) {
    const c = calcs.get(t.id);
    const key = `${t.clientCode}|${instrumentKey(t)}`;
    let p = map.get(key);
    if (!p) {
      p = { sample: t, bq: 0, bn: 0, bg: 0, sq: 0, sn: 0, sg: 0, brk: 0 };
      map.set(key, p);
    }
    const net = (c?.netRate ?? t.rate) * t.qty;
    const gross = t.rate * t.qty;
    if (t.side === "B") {
      p.bq += t.qty; p.bn += net; p.bg += gross;
    } else {
      p.sq += t.qty; p.sn += net; p.sg += gross;
    }
    p.brk += c?.brokerage ?? 0;
  }

  const out: Position[] = [];
  for (const [key, p] of map) {
    const t = p.sample;
    const live = livePrices[quoteKey(t)];
    const lastRate = live ?? lastTraded.get(instrumentKey(t)) ?? t.rate;
    const avgBuy = p.bq ? p.bn / p.bq : 0;
    const avgSell = p.sq ? p.sn / p.sq : 0;
    const gAvgBuy = p.bq ? p.bg / p.bq : 0;
    const gAvgSell = p.sq ? p.sg / p.sq : 0;
    const matched = Math.min(p.bq, p.sq);
    const netQty = p.bq - p.sq;
    const unreal = (aBuy: number, aSell: number) =>
      netQty > 0 ? (lastRate - aBuy) * netQty : netQty < 0 ? (aSell - lastRate) * -netQty : 0;
    out.push({
      key,
      clientCode: t.clientCode,
      segment: t.segment,
      label: contractLabel(t),
      buyQty: p.bq,
      sellQty: p.sq,
      avgBuy,
      avgSell,
      netQty,
      lastRate,
      live: live != null,
      quoteKey: quoteKey(t),
      realized: (avgSell - avgBuy) * matched,
      mtm: unreal(avgBuy, avgSell),
      grossRealized: (gAvgSell - gAvgBuy) * matched,
      grossMtm: unreal(gAvgBuy, gAvgSell),
      brokerage: p.brk,
    });
  }
  return out.sort((a, b) => a.clientCode.localeCompare(b.clientCode) || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Interest on funded delivery buys (equity)
// ---------------------------------------------------------------------------

/** Calendar days from `from` to `to`, counting both days (24-Aug → 24-Aug = 1). */
export function daysInclusive(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

export interface InterestLine {
  clientCode: string;
  script: string;
  buyDate: string;
  /** Sell date that closed this part, or null while still open. */
  toDate: string | null;
  qty: number;
  netRate: number;
  amount: number; // qty × net buy rate (brokerage included)
  days: number;
  ratePct: number; // annual %
  interest: number;
}

/**
 * Interest = buy amount × annual % ÷ 365 × days held, per account's Ledger
 * Interest %. Equity (NSEEQ) only. For each client + script, sells first
 * close same-day buys (intraday — no interest), then the oldest open buys
 * (FIFO); each closed part is charged from its buy date to its sell date and
 * open parts up to `asOf`, both days counted. "Full payment" buys and CF/BF
 * entries carry no interest.
 */
export function computeInterest(
  trades: Trade[],
  calcs: Map<number, TradeCalc>,
  accounts: Account[],
  asOf: string
): InterestLine[] {
  const rateOf = new Map(accounts.map((a) => [a.code, a.interestPct]));
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    if (t.segment !== "NSEEQ" || t.date > asOf || !(rateOf.get(t.clientCode)! > 0)) continue;
    const k = `${t.clientCode}|${t.script}`;
    const list = groups.get(k);
    if (list) list.push(t);
    else groups.set(k, [t]);
  }

  const lines: InterestLine[] = [];
  for (const list of groups.values()) {
    const ratePct = rateOf.get(list[0].clientCode)!;
    const charge = (lot: { t: Trade; qty: number }, toDate: string | null) => {
      if (lot.qty <= 0 || lot.t.fullPayment || lot.t.tradeType !== "NRM") return;
      const netRate = calcs.get(lot.t.id)?.netRate ?? lot.t.rate;
      const amount = netRate * lot.qty;
      const days = daysInclusive(lot.t.date, toDate ?? asOf);
      lines.push({
        clientCode: lot.t.clientCode, script: lot.t.script, buyDate: lot.t.date, toDate, qty: lot.qty,
        netRate, amount, days, ratePct, interest: (amount * ratePct) / 100 / 365 * days,
      });
    };

    const open: { t: Trade; qty: number }[] = []; // FIFO queue of held buys
    const byDate = new Map<string, Trade[]>();
    for (const t of [...list].sort((a, b) => a.addTime.localeCompare(b.addTime) || a.id - b.id)) {
      const d = byDate.get(t.date);
      if (d) d.push(t);
      else byDate.set(t.date, [t]);
    }
    for (const date of [...byDate.keys()].sort()) {
      const day = byDate.get(date)!;
      const buys = day.filter((t) => t.side === "B").map((t) => ({ t, qty: t.qty }));
      let sellQty = day.filter((t) => t.side === "S").reduce((s, t) => s + t.qty, 0);
      // 1. Intraday: same-day sells close same-day buys — no interest.
      for (const b of buys) {
        const m = Math.min(b.qty, sellQty);
        b.qty -= m;
        sellQty -= m;
      }
      // 2. Remaining sells close the oldest held buys.
      while (sellQty > 0 && open.length) {
        const lot = open[0];
        const m = Math.min(lot.qty, sellQty);
        charge({ t: lot.t, qty: m }, date);
        lot.qty -= m;
        sellQty -= m;
        if (lot.qty === 0) open.shift();
      }
      for (const b of buys) if (b.qty > 0) open.push(b);
    }
    for (const lot of open) charge(lot, null);
  }
  return lines.sort((a, b) => a.clientCode.localeCompare(b.clientCode) || a.buyDate.localeCompare(b.buyDate) || a.script.localeCompare(b.script));
}

export interface LedgerRow {
  account: Account;
  opening: number; // signed: Cr positive, Dr negative
  grossRealized: number;
  brokerage: number;
  interest: number;
  balance: number;
  unrealized: number;
  equity: number;
}

/** Current Balance = Opening (+Cr / −Dr) + Realized P&L − Brokerage − Interest. */
export function computeLedger(accounts: Account[], positions: Position[], interest: InterestLine[] = []): LedgerRow[] {
  return accounts.map((account) => {
    const mine = positions.filter((p) => p.clientCode === account.code);
    const opening = account.openingType === "Cr" ? account.openingBalance : -account.openingBalance;
    const grossRealized = mine.reduce((s, p) => s + p.grossRealized, 0);
    const brokerage = mine.reduce((s, p) => s + p.brokerage, 0);
    const int = interest.filter((l) => l.clientCode === account.code).reduce((s, l) => s + l.interest, 0);
    const unrealized = mine.reduce((s, p) => s + p.grossMtm, 0);
    const balance = opening + grossRealized - brokerage - int;
    return { account, opening, grossRealized, brokerage, interest: int, balance, unrealized, equity: balance + unrealized };
  });
}

/** "12,345.00 Cr" / "12,345.00 Dr" */
export function drCr(n: number): string {
  if (Math.abs(n) < 0.005) return "0.00";
  return `${fmt2(Math.abs(n))} ${n >= 0 ? "Cr" : "Dr"}`;
}
