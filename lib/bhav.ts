import { addDays } from "@/lib/terminal/engine";
import { dailyCloses } from "@/lib/angel";

// NSE cash-market bhav copy (sec_bhavdata_full), server-only.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** Close prices from NSE's bhav copy for `date` (YYYY-MM-DD), or null if NSE has no file (holiday). */
async function nseBhav(date: string): Promise<Map<string, number> | null> {
  const [y, m, d] = date.split("-");
  const url = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    const head = lines[0]?.split(",").map((h) => h.trim());
    const iSym = head?.indexOf("SYMBOL") ?? -1;
    const iSeries = head?.indexOf("SERIES") ?? -1;
    const iClose = head?.indexOf("CLOSE_PRICE") ?? -1;
    if (iSym < 0 || iClose < 0) return null;
    const closes = new Map<string, number>();
    for (const line of lines.slice(1)) {
      const c = line.split(",").map((x) => x.trim());
      const price = Number(c[iClose]);
      if (!c[iSym] || !(price > 0)) continue;
      // Prefer the EQ series; other series (BE, BZ, …) only if no EQ row.
      if (c[iSeries] === "EQ" || !closes.has(c[iSym])) closes.set(c[iSym], price);
    }
    return closes.size ? closes : null;
  } catch {
    return null;
  }
}

export interface SettlementPrices {
  priceDate: string | null;
  prices: Record<string, { price: number; source: string }>;
  missing: string[];
  message?: string;
}

/**
 * Bhav close for `scripts` on the last trading day on or before `monthEnd`
 * (walks back over weekends / holidays). Scripts missing from NSE's file are
 * filled from Angel's daily candle close.
 */
export async function settlementPrices(monthEnd: string, scripts: string[]): Promise<SettlementPrices> {
  let priceDate: string | null = null;
  let bhav: Map<string, number> | null = null;
  for (let back = 0; back < 10 && !bhav; back++) {
    const d = addDays(monthEnd, -back);
    bhav = await nseBhav(d);
    if (bhav) priceDate = d;
  }
  const prices: SettlementPrices["prices"] = {};
  if (bhav) for (const s of scripts) if (bhav.has(s)) prices[s] = { price: bhav.get(s)!, source: "NSE bhav" };

  let message: string | undefined;
  const fromAngel = scripts.filter((s) => !prices[s]);
  if (fromAngel.length) {
    const date = priceDate ?? monthEnd;
    try {
      const closes = await dailyCloses(fromAngel, date);
      for (const [s, p] of Object.entries(closes)) prices[s] = { price: p, source: "Angel daily close" };
      if (!priceDate && Object.keys(closes).length) priceDate = date;
    } catch (e) {
      message = `Angel fallback failed: ${(e as Error).message}`;
    }
  }
  if (!bhav) message = [`NSE bhav copy not available for the last 10 days to ${monthEnd}`, message].filter(Boolean).join(" · ");
  return { priceDate, prices, missing: scripts.filter((s) => !prices[s]), message };
}
