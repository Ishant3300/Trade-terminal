import { inflateRawSync } from "node:zlib";
import { addDays, contractName, parseContract } from "@/lib/terminal/engine";
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

// ---------------------------------------------------------------------------
// NCDEX bhav copy (UDiFF, zipped CSV) — settlement prices for weekly settlement
// ---------------------------------------------------------------------------

/** Files of a .zip archive (stored or deflated entries), by name. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, inflateRawSync(raw));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

/**
 * NCDEX futures settlement prices on `date` (YYYY-MM-DD), by contract name as in
 * this app ("CASTOR 16OCT2026"), or null if NCDEX has no bhav copy (holiday).
 */
async function ncdexBhav(date: string): Promise<Map<string, number> | null> {
  const [y, m, d] = date.split("-");
  const url =
    "https://www.ncdex.com/markets/bhavcopy?file_type_both=final&type_both=bhavcopy&bhavcopy_for=both" +
    `&filedate_both=${d}-${m}-${y}&format_both=csv_file`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, cache: "no-store" });
    if (!res.ok || !/zip/i.test(res.headers.get("content-type") ?? "")) return null;
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    const csv = [...files].find(([name]) => /^BhavCopy_NCD_.*\.csv$/i.test(name))?.[1].toString("utf8");
    if (!csv) return null;
    const lines = csv.split(/\r?\n/);
    const head = lines[0].split(",").map((h) => h.trim());
    const col = (n: string) => head.indexOf(n);
    const [iDt, iSym, iExp, iOpt, iSettle, iClose] = ["TradDt", "TckrSymb", "XpryDt", "OptnTp", "SttlmPric", "ClsPric"].map(col);
    if (iSym < 0 || iExp < 0 || iSettle < 0) return null;
    const prices = new Map<string, number>();
    for (const line of lines.slice(1)) {
      const c = line.split(",").map((x) => x.trim());
      if (!c[iSym] || !/^\d{4}-\d{2}-\d{2}$/.test(c[iExp]) || (iOpt >= 0 && c[iOpt])) continue; // futures only
      if (iDt >= 0 && c[iDt] !== date) continue;
      const price = Number(c[iSettle]) > 0 ? Number(c[iSettle]) : Number(c[iClose]);
      if (price > 0) prices.set(contractName(c[iSym], c[iExp]), price);
    }
    return prices.size ? prices : null;
  } catch {
    return null;
  }
}

/**
 * NCDEX settlement prices for a weekly settlement: the bhav copy of the last
 * trading day on or before `friday`. Contracts that expired during the week
 * take the settlement price of their expiry day.
 */
export async function ncdexSettlementPrices(friday: string, contracts: string[]): Promise<SettlementPrices> {
  let priceDate: string | null = null;
  let bhav: Map<string, number> | null = null;
  for (let back = 0; back < 7 && !bhav; back++) {
    const d = addDays(friday, -back);
    bhav = await ncdexBhav(d);
    if (bhav) priceDate = d;
  }
  const prices: SettlementPrices["prices"] = {};
  if (bhav) for (const c of contracts) if (bhav.has(c)) prices[c] = { price: bhav.get(c)!, source: `NCDEX bhav ${priceDate!.split("-").reverse().join("-")}` };

  // Expired during the week: final settlement price from the expiry day's bhav.
  const byExpiry = new Map<string, string[]>();
  for (const c of contracts) {
    const exp = parseContract(c)?.expiry;
    if (!prices[c] && exp && exp <= friday) byExpiry.set(exp, [...(byExpiry.get(exp) ?? []), c]);
  }
  for (const [exp, list] of byExpiry) {
    const day = await ncdexBhav(exp);
    for (const c of list) if (day?.has(c)) prices[c] = { price: day.get(c)!, source: `NCDEX bhav ${exp.split("-").reverse().join("-")} (expiry)` };
  }
  return {
    priceDate,
    prices,
    missing: contracts.filter((c) => !prices[c]),
    message: bhav ? undefined : `NCDEX bhav copy not available for the week ending ${friday.split("-").reverse().join("-")}`,
  };
}
