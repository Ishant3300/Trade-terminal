import { addDays, parseContract, type TradeCalc } from "./engine";
import type { Account, LedgerEntry, Settlement, Trade } from "./types";

// Client money ledger with interest on the funded amount (NSE equity only).
//
//   Margin used   = value of open delivery lots: cost (net buy rate × qty,
//                   brokerage included), or the settlement price once the lot
//                   has been carried through a settlement. Interest is on what
//                   is open at the end of the day: a lot counts from its buy
//                   day and is released on its sell day. Same-day (intraday) trades and Full Payment buys
//                   use no margin.
//   Client money  = opening balance + deposits − withdrawals ± journals
//                   + P&L and MTM posted at monthly settlements
//                   − interest posted at monthly settlements.
//                   Trade P&L is NOT counted during the month — only when the
//                   month is settled.
//   Funded        = max(0, margin used − client money)
//   Interest/day  = funded × Ledger Interest % ÷ 365
//
// Settlement (on the 1st): open lots are valued at the bhav close of the
// price date and that MTM is posted; P&L of lots sold during the month is
// posted (from bhav if the lot was carried through an earlier settlement);
// the month's interest is posted. From the next day (the 1st) lots still held
// reopen at the settlement price: margin used is revalued to qty × bhav, so the
// MTM just posted to client money is not counted again in the funded amount.

export interface Portion {
  script: string;
  buyDate: string;
  qty: number;
  netBuyRate: number;
  fullPayment: boolean;
  closeDate: string | null;
  sellNetRate: number | null;
}

interface IntradayPnl {
  script: string;
  date: string;
  pnl: number;
}

/**
 * Splits a client's NSE equity trades into delivery lots (FIFO) and intraday
 * P&L. NRM trades are normal executions; BF (brought forward) buys are
 * positions carried in from an earlier month — held from the start of their
 * day, never matched as intraday, no brokerage. CF entries are ignored.
 */
export function buildEquityLots(trades: Trade[], calcs: Map<number, TradeCalc>) {
  const portions: Portion[] = [];
  const intraday: IntradayPnl[] = [];
  const warnings: string[] = [];
  const net = (t: Trade) => calcs.get(t.id)?.netRate ?? t.rate;

  const byScript = new Map<string, Trade[]>();
  for (const t of trades) {
    if (t.segment !== "NSEEQ") continue;
    if (t.tradeType === "CF" || (t.tradeType === "BF" && t.side !== "B")) {
      warnings.push(`${t.script} ${t.date}: ${t.tradeType} ${t.side === "B" ? "buy" : "sell"} entry ignored in ledger`);
      continue;
    }
    const list = byScript.get(t.script);
    if (list) list.push(t);
    else byScript.set(t.script, [t]);
  }

  for (const [script, list] of byScript) {
    const open: { t: Trade; qty: number }[] = []; // FIFO
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.addTime.localeCompare(b.addTime) || a.id - b.id);
    const dates = [...new Set(sorted.map((t) => t.date))];
    for (const date of dates) {
      const day = sorted.filter((t) => t.date === date);
      // Brought-forward positions are already held when the day starts.
      for (const t of day) if (t.tradeType === "BF") open.push({ t, qty: t.qty });
      const buys = day.filter((t) => t.side === "B" && t.tradeType !== "BF").map((t) => ({ t, qty: t.qty }));
      for (const sell of day.filter((t) => t.side === "S")) {
        let left = sell.qty;
        // 1. Same-day buys first: intraday.
        for (const b of buys) {
          const m = Math.min(b.qty, left);
          if (!m) continue;
          intraday.push({ script, date, pnl: (net(sell) - net(b.t)) * m });
          b.qty -= m;
          left -= m;
        }
        // 2. Then the oldest held lots.
        while (left > 0 && open.length) {
          const lot = open[0];
          const m = Math.min(lot.qty, left);
          portions.push({
            script, buyDate: lot.t.date, qty: m, netBuyRate: net(lot.t), fullPayment: !!lot.t.fullPayment,
            closeDate: date, sellNetRate: net(sell),
          });
          lot.qty -= m;
          left -= m;
          if (!lot.qty) open.shift();
        }
        if (left > 0) warnings.push(`${script} ${date}: sold ${left} more than held — ignored in ledger`);
      }
      for (const b of buys) if (b.qty > 0) open.push(b);
    }
    for (const lot of open) {
      portions.push({
        script, buyDate: lot.t.date, qty: lot.qty, netBuyRate: net(lot.t), fullPayment: !!lot.t.fullPayment,
        closeDate: null, sellNetRate: null,
      });
    }
  }
  return { portions, intraday, warnings };
}

export type RowKind = "BF" | "NCDEX" | "REVALUE" | "BUY" | "RELEASE" | "DEPOSIT" | "WITHDRAWAL" | "JOURNAL_DR" | "JOURNAL_CR" | "PNL" | "MTM" | "INTEREST";

export interface StatementRow {
  date: string; // date the change takes effect
  kind: RowKind;
  particulars: string;
  debit: number; // to client money
  credit: number;
  marginChange: number;
  money: number; // client money after this row (Cr +, Dr −)
  margin: number; // margin used after this row
  funded: number;
  /** Interest from this row's date until the next row (only on the last row of a date). */
  days: number;
  interest: number;
}

export interface SettlementSummary {
  settlement: Settlement;
  periodFrom: string;
  periodTo: string;
  realized: number;
  mtm: number;
  interest: number;
  missingPrices: string[];
}

export interface ClientLedger {
  account: Account;
  rows: StatementRow[];
  settlements: SettlementSummary[];
  postedInterest: number;
  accruedInterest: number; // since the last settlement, up to asOf (not yet posted)
  pendingPnl: number; // P&L of the current month, posted at the next settlement
  money: number;
  margin: number;
  funded: number;
  /** NCDEX weekly settlements posted to client money (no interest on NCDEX). */
  ncdexPostings: NcdexPosting[];
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtQty = (n: number) => n.toLocaleString("en-IN");
const fmtRate = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d: string) => d.split("-").reverse().join("-");

/** Statement and interest for one client, up to `asOf` (inclusive). */
export function computeClientLedger(
  account: Account,
  trades: Trade[],
  calcs: Map<number, TradeCalc>,
  entries: LedgerEntry[],
  allSettlements: Settlement[],
  asOf: string
): ClientLedger {
  const mine = trades.filter((t) => t.clientCode === account.code && t.date <= asOf);
  const { portions, intraday, warnings } = buildEquityLots(mine, calcs);
  const myEntries = entries.filter((e) => e.clientCode === account.code && e.date <= asOf);
  // A settlement is billed at the end of the month's last day (the day before its 1st-of-month key).
  const postDate = (s: Settlement) => addDays(s.settleDate, -1);
  const settlements = allSettlements
    .filter((s) => s.segment !== "NCDEX" && postDate(s) <= asOf)
    .sort((a, b) => a.settleDate.localeCompare(b.settleDate));
  const rate = account.interestPct / 100 / 365;
  // NCDEX weekly: P&L + MTM at the settlement price, posted on the Friday after that day's interest.
  const ncdex = ncdexSettle(mine, calcs, allSettlements.filter((s) => s.segment === "NCDEX" && postDate(s) <= asOf));
  const ncdexAt = new Map<string, NcdexPosting[]>();
  for (const p of ncdex.postings) ncdexAt.set(p.date, [...(ncdexAt.get(p.date) ?? []), p]);

  // --- Settlement P&L per portion: MTM at each bhav, realized at the settlement after the sale.
  const realizedAt = new Map<number, number>(); // settlement index → realized P&L
  const mtmAt = new Map<number, number>();
  const missing = new Map<number, Set<string>>();
  let pendingPnl = 0;
  const add = (m: Map<number, number>, i: number, v: number) => m.set(i, (m.get(i) ?? 0) + v);
  for (const p of portions) {
    let carry = p.netBuyRate;
    settlements.forEach((s, i) => {
      const heldAtPrice = p.buyDate <= s.priceDate && (p.closeDate === null || p.closeDate > s.priceDate);
      if (!heldAtPrice) return;
      const price = s.prices[p.script];
      if (!(price > 0)) {
        if (!missing.has(i)) missing.set(i, new Set());
        missing.get(i)!.add(p.script);
        return;
      }
      add(mtmAt, i, (price - carry) * p.qty);
      carry = price;
    });
    if (p.closeDate !== null) {
      const pnl = (p.sellNetRate! - carry) * p.qty;
      const i = settlements.findIndex((s) => s.priceDate >= p.closeDate!);
      if (i >= 0) add(realizedAt, i, pnl);
      else pendingPnl += pnl;
    }
  }
  for (const x of intraday) {
    const i = settlements.findIndex((s) => s.priceDate >= x.date);
    if (i >= 0) add(realizedAt, i, x.pnl);
    else pendingPnl += x.pnl;
  }

  // --- Effective-dated changes (settlement rows are added during the walk).
  type Change = { date: string; kind: RowKind; particulars: string; money: number; margin: number };
  const changes: Change[] = [];
  const revalue = new Map<number, number>(); // settlement index → margin change on its 1st
  for (const p of portions) {
    if (p.fullPayment) continue;
    let amount = p.netBuyRate * p.qty;
    changes.push({
      date: p.buyDate, kind: "BUY", money: 0, margin: amount,
      particulars: `BUY ${fmtQty(p.qty)} ${p.script} @ ${fmtRate(p.netBuyRate)} (net)`,
    });
    // Still held on a settlement's 1st: reopens at that settlement's price.
    settlements.forEach((s, i) => {
      const price = s.prices[p.script];
      const held = p.buyDate <= s.priceDate && (p.closeDate === null || p.closeDate >= s.settleDate);
      if (!held || !(price > 0) || s.settleDate > asOf) return;
      add(revalue, i, price * p.qty - amount);
      amount = price * p.qty;
    });
    if (p.closeDate !== null && p.closeDate <= asOf) {
      changes.push({
        date: p.closeDate, kind: "RELEASE", money: 0, margin: -amount,
        particulars: `SOLD ${fmtQty(p.qty)} ${p.script} @ ${fmtRate(p.sellNetRate!)} (net) — margin released`,
      });
    }
  }
  revalue.forEach((delta, i) => {
    const s = settlements[i];
    if (Math.abs(delta) < 0.005) return;
    changes.push({
      date: s.settleDate, kind: "REVALUE", money: 0, margin: delta,
      particulars: `Open positions reopened at settlement price (bhav ${dmy(s.priceDate)})`,
    });
  });
  const ENTRY_LABEL: Record<LedgerEntry["kind"], string> = {
    DEPOSIT: "Deposit", WITHDRAWAL: "Withdrawal / Payout", JOURNAL_CR: "Journal Cr", JOURNAL_DR: "Journal Dr",
  };
  for (const e of myEntries) {
    const credit = e.kind === "DEPOSIT" || e.kind === "JOURNAL_CR";
    changes.push({
      date: e.date, kind: e.kind, margin: 0, money: credit ? e.amount : -e.amount,
      particulars: `${ENTRY_LABEL[e.kind]}${e.narration ? ` — ${e.narration}` : ""}`,
    });
  }
  const order: RowKind[] = ["PNL", "MTM", "INTEREST", "REVALUE", "DEPOSIT", "JOURNAL_CR", "WITHDRAWAL", "JOURNAL_DR", "BUY", "RELEASE"];
  changes.sort((a, b) => a.date.localeCompare(b.date) || order.indexOf(a.kind) - order.indexOf(b.kind));

  const opening = account.openingType === "Cr" ? account.openingBalance : -account.openingBalance;
  const firstDate = [changes[0]?.date, settlements[0] && postDate(settlements[0]), ncdex.postings[0]?.date].filter(Boolean).sort()[0];
  const rows: StatementRow[] = [];
  const summaries: SettlementSummary[] = [];
  let money = opening;
  let margin = 0;
  let periodInterest = 0;
  let postedInterest = 0;
  let periodFrom = firstDate ?? asOf;
  let ci = 0;
  let si = 0;

  const push = (date: string, kind: RowKind, particulars: string, moneyDelta: number, marginDelta: number) => {
    money += moneyDelta;
    margin += marginDelta;
    if (Math.abs(margin) < 0.005) margin = 0;
    rows.push({
      date, kind, particulars,
      debit: moneyDelta < 0 ? -moneyDelta : 0, credit: moneyDelta > 0 ? moneyDelta : 0, marginChange: marginDelta,
      money, margin, funded: Math.max(0, margin - money), days: 0, interest: 0,
    });
  };

  if (firstDate) {
    push(firstDate, "BF", "Opening balance", 0, 0);
    rows[0].money = money = opening;
    rows[0].credit = opening > 0 ? opening : 0;
    rows[0].debit = opening < 0 ? -opening : 0;
    rows[0].funded = Math.max(0, margin - money);

    for (let d = firstDate; d <= asOf; d = addDays(d, 1)) {
      // Month boundary: a b/f row so each month's interest stays within that month.
      if (d.endsWith("-01") && d !== firstDate) push(d, "BF", "Balance brought forward", 0, 0);
      while (ci < changes.length && changes[ci].date === d) {
        const c = changes[ci++];
        push(d, c.kind, c.particulars, c.money, c.margin);
      }
      const dayInterest = Math.max(0, margin - money) * rate;
      periodInterest += dayInterest;
      const last = rows[rows.length - 1];
      last.days += 1;
      last.interest += dayInterest;

      for (const p of ncdexAt.get(d) ?? []) {
        push(d, "NCDEX", `NCDEX weekly settlement ${dmy(addDays(d, -4))} to ${dmy(d)}: P&L & MTM @ settlement price ${dmy(p.settlement.priceDate)}${p.missing.length ? ` (no price: ${p.missing.join(", ")})` : ""}`, p.amount, 0);
      }

      // Month-end billing, after the day's interest: P&L, MTM @ bhav and the period's interest.
      // The new balance applies from the next day (the 1st).
      while (si < settlements.length && postDate(settlements[si]) === d) {
        const st = settlements[si];
        const realized = realizedAt.get(si) ?? 0;
        const mtm = mtmAt.get(si) ?? 0;
        const interest = round2(periodInterest);
        if (realized) push(d, "PNL", `Settlement ${dmy(d)}: P&L on trades closed till ${dmy(st.priceDate)}`, round2(realized), 0);
        if (mtm) push(d, "MTM", `Settlement ${dmy(d)}: MTM of open positions @ bhav ${dmy(st.priceDate)}`, round2(mtm), 0);
        if (interest) push(d, "INTEREST", `Interest ${dmy(periodFrom)} to ${dmy(d)} @ ${account.interestPct}%`, -interest, 0);
        summaries.push({
          settlement: st, periodFrom, periodTo: d, realized: round2(realized), mtm: round2(mtm), interest,
          missingPrices: [...(missing.get(si) ?? [])].sort(),
        });
        postedInterest += interest;
        periodInterest = 0;
        periodFrom = addDays(d, 1);
        si++;
      }
    }
  }

  return {
    account, rows, settlements: summaries, postedInterest, accruedInterest: periodInterest, pendingPnl,
    money, margin, funded: Math.max(0, margin - money), ncdexPostings: ncdex.postings, warnings,
  };
}

export interface NcdexPosting {
  settlement: Settlement;
  date: string; // billing Friday (settleDate − 1)
  amount: number; // P&L + MTM, net of brokerage
  missing: string[]; // open contracts without a settlement price (carried to the next week)
}

/**
 * NCDEX weekly settlement for one client. Per contract, each week's amount is
 *   Σ trade cash (sell +, buy −, at net rates) + open qty × settlement price
 *   − open qty carried in × last week's settlement price,
 * i.e. realized P&L plus MTM; open positions (long or short) carry forward at the
 * settlement price. A contract expiring in the week settles at its expiry price.
 * A contract still open without a price is left for the next settlement.
 * `settlements`: NCDEX settlements to apply (any order).
 */
export function ncdexSettle(trades: Trade[], calcs: Map<number, TradeCalc>, settlements: Settlement[]) {
  const weeks = settlements.filter((s) => s.segment === "NCDEX").sort((a, b) => a.settleDate.localeCompare(b.settleDate));
  const byContract = new Map<string, Trade[]>();
  for (const t of trades) if (t.segment === "NCDEX") byContract.set(t.script, [...(byContract.get(t.script) ?? []), t]);

  const amounts = weeks.map(() => 0);
  const missing = weeks.map(() => [] as string[]);
  const active = weeks.map(() => false);
  /** Last settlement per contract: from its settleDate the position stands at qty @ price. */
  const settled = new Map<string, { settleDate: string; qty: number; price: number }>();
  for (const [contract, list] of byContract) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.addTime.localeCompare(b.addTime) || a.id - b.id);
    const expiry = parseContract(contract)?.expiry ?? "9999-12-31";
    let i = 0;
    let qty = 0;
    let basis = 0; // carried qty × last settlement price
    let cash = 0;
    weeks.forEach((s, w) => {
      const friday = addDays(s.settleDate, -1);
      for (; i < list.length && list[i].date <= friday; i++) {
        const t = list[i];
        const net = calcs.get(t.id)?.netRate ?? t.rate;
        qty += t.side === "B" ? t.qty : -t.qty;
        cash += (t.side === "B" ? -1 : 1) * net * t.qty;
      }
      if (!qty && !cash && !basis) return;
      const price = s.prices[contract];
      if (qty && !(price > 0)) {
        missing[w].push(contract);
        return;
      }
      active[w] = true;
      amounts[w] += cash + (qty ? qty * price : 0) - basis;
      if (expiry <= friday) qty = 0; // expired: closed at its final settlement price
      cash = 0;
      basis = qty ? qty * price : 0;
      settled.set(contract, { settleDate: s.settleDate, qty, price: qty ? price : 0 });
    });
  }
  const postings: NcdexPosting[] = weeks
    .map((s, w) => ({ settlement: s, date: addDays(s.settleDate, -1), amount: round2(amounts[w]), missing: missing[w].sort() }))
    .filter((p, w) => active[w] || p.missing.length);
  return { postings, settled };
}

/**
 * Trades as they stand after the last settlements on or before `asOf` (for the
 * Reports page), so P&L runs from the last settlement:
 * - NSE equity before the last monthly settlement is replaced by one BF buy per
 *   lot still held, at the price it was carried at (bhav close, else earlier carry).
 * - NCDEX trades before a contract's last weekly settlement are replaced by one BF
 *   trade for the open position (long or short) at that settlement price.
 * Carried positions have no brokerage. Other segments are unchanged. A settlement
 * billed on `asOf` itself is not applied, so a billing-day report shows that
 * period's P&L.
 */
export function carryToSettlement(
  trades: Trade[],
  calcs: Map<number, TradeCalc>,
  allSettlements: Settlement[],
  asOf: string
): { trades: Trade[]; calcs: Map<number, TradeCalc>; since: Settlement | null; ncdexSince: Settlement | null } {
  const applied = allSettlements.filter((s) => s.settleDate <= asOf).sort((a, b) => a.settleDate.localeCompare(b.settleDate));
  const monthly = applied.filter((s) => s.segment !== "NCDEX");
  const weekly = applied.filter((s) => s.segment === "NCDEX");
  const since = monthly[monthly.length - 1] ?? null;
  const ncdexSince = weekly[weekly.length - 1] ?? null;
  if (!since && !ncdexSince) return { trades, calcs, since, ncdexSince };

  const outCalcs = new Map(calcs);
  const carried: Trade[] = [];
  let id = 0;
  const carry = (clientCode: string, segment: "NSEEQ" | "NCDEX", script: string, side: "B" | "S", qty: number, rate: number, date: string, fullPayment = false) => {
    const t: Trade = {
      id: --id, ot: "T", date, valan: "", segment, script, option: "", strike: 0, tradeType: "BF", side, lot: qty, qty, rate,
      clientCode, fullPayment, user: "", ip: "", addTime: `${date} 00:00:00`,
    };
    carried.push(t);
    outCalcs.set(t.id, { slab: null, lotSize: 1, intraQty: 0, delQty: qty, intraWaived: false, brokerage: 0, brokPerUnit: 0, netRate: rate });
  };

  // NSE equity (monthly).
  const settledEq = (t: Trade) => !!since && t.segment === "NSEEQ" && t.date < since.settleDate;
  const eqByClient = new Map<string, Trade[]>();
  for (const t of trades) if (settledEq(t)) eqByClient.set(t.clientCode, [...(eqByClient.get(t.clientCode) ?? []), t]);
  for (const [clientCode, list] of eqByClient) {
    for (const p of buildEquityLots(list, calcs).portions) {
      if (p.closeDate !== null) continue;
      let price = p.netBuyRate;
      for (const s of monthly) if (p.buyDate <= s.priceDate && s.prices[p.script] > 0) price = s.prices[p.script];
      carry(clientCode, "NSEEQ", p.script, "B", p.qty, price, since!.settleDate, p.fullPayment);
    }
  }

  // NCDEX (weekly), per client and contract.
  const settledAt = new Map<string, string>(); // client|contract → settleDate
  if (ncdexSince) {
    const byClient = new Map<string, Trade[]>();
    for (const t of trades) if (t.segment === "NCDEX") byClient.set(t.clientCode, [...(byClient.get(t.clientCode) ?? []), t]);
    for (const [clientCode, list] of byClient) {
      for (const [contract, st] of ncdexSettle(list, calcs, weekly).settled) {
        settledAt.set(`${clientCode}|${contract}`, st.settleDate);
        if (st.qty) carry(clientCode, "NCDEX", contract, st.qty > 0 ? "B" : "S", Math.abs(st.qty), st.price, st.settleDate);
      }
    }
  }
  const settledNcdex = (t: Trade) => {
    const at = t.segment === "NCDEX" ? settledAt.get(`${t.clientCode}|${t.script}`) : undefined;
    return !!at && t.date < at;
  };
  return { trades: [...trades.filter((t) => !settledEq(t) && !settledNcdex(t)), ...carried], calcs: outCalcs, since, ncdexSince };
}

export interface NcdexBillLine {
  date: string;
  time: string; // HH:MM:SS, "" for B/F and C/F
  kind: "BF" | "BUY" | "SELL" | "CF" | "EXPIRY";
  qty: number;
  rate: number; // trade rate, or settlement price for B/F / C/F
  brokerage: number;
  netRate: number;
  amount: number; // + credit (sell side), − debit (buy side), at net rate
}

export interface NcdexBillContract {
  contract: string;
  lines: NcdexBillLine[];
  grossPnl: number; // before brokerage
  brokerage: number;
  netPnl: number; // = Σ amount
  /** Still open without a settlement price: not billed this week. */
  unpriced: boolean;
}

/**
 * Weekly NCDEX bill of one client for `settlement`: positions brought forward
 * at the last settlement price, the week's trades, positions carried forward at
 * this settlement's price (expired contracts closed at their expiry price).
 * Net P&L per contract equals what ncdexSettle posts for that week.
 */
export function ncdexBill(trades: Trade[], calcs: Map<number, TradeCalc>, settlements: Settlement[], settlement: Settlement) {
  const friday = addDays(settlement.settleDate, -1);
  const mine = trades.filter((t) => t.segment === "NCDEX" && t.date <= friday);
  const earlier = settlements.filter((s) => s.segment === "NCDEX" && s.settleDate < settlement.settleDate);
  const prior = ncdexSettle(mine, calcs, earlier).settled;
  const byContract = new Map<string, Trade[]>();
  for (const t of mine) byContract.set(t.script, [...(byContract.get(t.script) ?? []), t]);

  const contracts: NcdexBillContract[] = [];
  for (const [contract, list] of [...byContract].sort(([a], [b]) => a.localeCompare(b))) {
    const from = prior.get(contract);
    const week = list
      .filter((t) => !from || t.date >= from.settleDate)
      .sort((a, b) => a.date.localeCompare(b.date) || a.addTime.localeCompare(b.addTime) || a.id - b.id);
    if (!week.length && !from?.qty) continue;
    const lines: NcdexBillLine[] = [];
    let qty = 0;
    if (from?.qty) {
      qty = from.qty;
      lines.push({
        date: addDays(from.settleDate, -1), time: "", kind: "BF", qty: Math.abs(from.qty), rate: from.price, brokerage: 0, netRate: from.price,
        amount: -from.qty * from.price,
      });
    }
    let brokerage = 0;
    for (const t of week) {
      const c = calcs.get(t.id);
      const net = c?.netRate ?? t.rate;
      brokerage += c?.brokerage ?? 0;
      qty += t.side === "B" ? t.qty : -t.qty;
      lines.push({
        date: t.date, time: t.addTime.slice(11, 19), kind: t.side === "B" ? "BUY" : "SELL", qty: t.qty, rate: t.rate,
        brokerage: c?.brokerage ?? 0, netRate: net, amount: (t.side === "B" ? -1 : 1) * net * t.qty,
      });
    }
    const price = settlement.prices[contract];
    const unpriced = !!qty && !(price > 0);
    if (qty && !unpriced) {
      const expired = (parseContract(contract)?.expiry ?? "9999-12-31") <= friday;
      lines.push({
        date: friday, time: "", kind: expired ? "EXPIRY" : "CF", qty: Math.abs(qty), rate: price, brokerage: 0, netRate: price,
        amount: qty * price,
      });
    }
    const netPnl = unpriced ? 0 : round2(lines.reduce((s, l) => s + l.amount, 0));
    contracts.push({ contract, lines, grossPnl: unpriced ? 0 : round2(netPnl + brokerage), brokerage: round2(brokerage), netPnl, unpriced });
  }
  const sum = (k: "grossPnl" | "brokerage" | "netPnl") => round2(contracts.filter((c) => !c.unpriced).reduce((s, c) => s + c[k], 0));
  return { friday, monday: addDays(friday, -4), contracts, grossPnl: sum("grossPnl"), brokerage: sum("brokerage"), netPnl: sum("netPnl") };
}
