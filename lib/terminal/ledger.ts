import { addDays, type TradeCalc } from "./engine";
import type { Account, LedgerEntry, Settlement, Trade } from "./types";

// Client money ledger with interest on the funded amount (NSE equity only).
//
//   Margin used   = value of open delivery lots: cost (net buy rate × qty,
//                   brokerage included), or the settlement price once the lot
//                   has been carried through a settlement; a lot counts from
//                   its buy day through its sell day. Same-day (intraday) trades and Full Payment buys
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

export type RowKind = "BF" | "REVALUE" | "BUY" | "RELEASE" | "DEPOSIT" | "WITHDRAWAL" | "JOURNAL_DR" | "JOURNAL_CR" | "PNL" | "MTM" | "INTEREST";

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
  const settlements = allSettlements.filter((s) => postDate(s) <= asOf).sort((a, b) => a.settleDate.localeCompare(b.settleDate));
  const rate = account.interestPct / 100 / 365;

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
    if (p.closeDate !== null && addDays(p.closeDate, 1) <= asOf) {
      changes.push({
        date: addDays(p.closeDate, 1), kind: "RELEASE", money: 0, margin: -amount,
        particulars: `Margin released: SOLD ${fmtQty(p.qty)} ${p.script} on ${dmy(p.closeDate)}`,
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
  const firstDate = [changes[0]?.date, settlements[0] && postDate(settlements[0])].filter(Boolean).sort()[0];
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
    money, margin, funded: Math.max(0, margin - money), warnings,
  };
}

/**
 * Trades as they stand after the last settlement billed on or before `asOf`
 * (for the Reports page). NSE equity trades before that settlement are
 * settled: they are replaced by one BF buy per lot still held, at the price it
 * was carried at (the settlement's bhav close, else its earlier carry), with
 * no brokerage. Later trades and other segments are unchanged. A settlement
 * billed on `asOf` itself is not applied, so a month-end report shows that
 * month's P&L.
 */
export function carryToSettlement(
  trades: Trade[],
  calcs: Map<number, TradeCalc>,
  allSettlements: Settlement[],
  asOf: string
): { trades: Trade[]; calcs: Map<number, TradeCalc>; since: Settlement | null } {
  const settlements = allSettlements.filter((s) => s.settleDate <= asOf).sort((a, b) => a.settleDate.localeCompare(b.settleDate));
  const since = settlements[settlements.length - 1] ?? null;
  if (!since) return { trades, calcs, since };

  const settledEq = (t: Trade) => t.segment === "NSEEQ" && t.date < since.settleDate;
  const out = trades.filter((t) => !settledEq(t));
  const outCalcs = new Map(calcs);
  const byClient = new Map<string, Trade[]>();
  for (const t of trades) if (settledEq(t)) byClient.set(t.clientCode, [...(byClient.get(t.clientCode) ?? []), t]);

  let id = 0;
  for (const [clientCode, list] of byClient) {
    for (const p of buildEquityLots(list, calcs).portions) {
      if (p.closeDate !== null) continue;
      let carry = p.netBuyRate;
      for (const s of settlements) {
        const price = s.prices[p.script];
        if (p.buyDate <= s.priceDate && price > 0) carry = price;
      }
      const t: Trade = {
        id: --id, ot: "T", date: since.settleDate, valan: "", segment: "NSEEQ", script: p.script, option: "", strike: 0,
        tradeType: "BF", side: "B", lot: p.qty, qty: p.qty, rate: carry, clientCode, fullPayment: p.fullPayment,
        user: "", ip: "", addTime: `${since.settleDate} 00:00:00`,
      };
      out.push(t);
      outCalcs.set(t.id, {
        slab: null, lotSize: 1, intraQty: 0, delQty: p.qty, intraWaived: false, brokerage: 0, brokPerUnit: 0, netRate: carry,
      });
    }
  }
  return { trades: out, calcs: outCalcs, since };
}
