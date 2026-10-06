// Regenerates, from Angel One's SmartAPI instrument master:
//
//   lib/terminal/angel-tokens.json   contract → Angel token, for live quotes
//                                    (server-only; never sent to browsers)
//   lib/terminal/exchange-master.ts  NSE equities, MCX and NCDEX futures
//                                    (script lists for Script Name)
//
//   npm run update:fo     (runs this after the NSE F&O master update)
//
// Lot size here means the price multiplier: quantity per lot in the unit the
// price is quoted in, so value = rate × qty. Angel's own "lotsize" for
// commodities is in delivery units (GOLD = 1 kg while priced per 10 g), so
// MCX multipliers come from Upstox's public master (qty_multiplier) and NCDEX
// multipliers from the verified table below.
//
// Token keys match quoteKey() in lib/terminal/engine.ts:
//   NSEFUT|NIFTY 27OCT2026            NSEOPT|NIFTY 27OCT2026|25500|CE
//   MCXFUT|CRUDEOIL 19OCT2026         NCDEX|DHANIYA 18DEC2026     NSEEQ|RELIANCE

import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const TOKENS_OUT = fileURLToPath(new URL("../lib/terminal/angel-tokens.json", import.meta.url));
const MASTER_OUT = fileURLToPath(new URL("../lib/terminal/exchange-master.ts", import.meta.url));
const ANGEL_MASTER = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
const UPSTOX_MCX = "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz";

/**
 * NCDEX price multiplier per lot (lot size in the price-quotation unit),
 * from NCDEX contract specifications. Commodities not listed here are left
 * out of Script Name until verified.
 */
const NCDEX_MULTIPLIER = {
  CASTOR: 50, // 5 MT, Rs/quintal (NCDEX Castor Seed product note)
  GUARSEED10: 50, // 5 MT, Rs/quintal
  COCUDAKL: 100, // 10 MT, Rs/quintal
};

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
/** "27OCT2026" → "2026-10-27" */
const isoOf = (e) => `${e.slice(5)}-${MONTHS[e.slice(2, 5)]}-${e.slice(0, 2)}`;
// Angel strikes are x100: "2550000.000000" → 25500, "19250.000000" → 192.5
const strikeOf = (s) => String(Number(s) / 100);

console.log(`Downloading ${ANGEL_MASTER} …`);
const angelRes = await fetch(ANGEL_MASTER);
if (!angelRes.ok) throw new Error(`Angel instrument master: HTTP ${angelRes.status}`);
const rows = await angelRes.json();

console.log(`Downloading ${UPSTOX_MCX} …`);
const upRes = await fetch(UPSTOX_MCX);
if (!upRes.ok) throw new Error(`Upstox MCX master: HTTP ${upRes.status}`);
const mcxMultiplier = {};
for (const r of JSON.parse(gunzipSync(Buffer.from(await upRes.arrayBuffer())).toString("utf8"))) {
  if (r.instrument_type === "FUT" && r.qty_multiplier > 0) mcxMultiplier[r.underlying_symbol] ??= r.qty_multiplier;
}

const tokens = {};
const counts = { NSEFUT: 0, NSEOPT: 0, MCXFUT: 0, NCDEX: 0, NSEEQ: 0 };
const equities = new Set();
const mcx = {}; // symbol → Set(expiry ISO)
const ncdex = {};
const skipped = { MCX: new Set(), NCDEX: new Set() };

for (const r of rows) {
  const t = r.instrumenttype;
  let key;
  if (r.exch_seg === "NFO" && (t === "FUTIDX" || t === "FUTSTK")) {
    key = `NSEFUT|${r.name} ${r.expiry}`;
  } else if (r.exch_seg === "NFO" && (t === "OPTIDX" || t === "OPTSTK")) {
    const type = r.symbol.slice(-2);
    if (type !== "CE" && type !== "PE") continue;
    key = `NSEOPT|${r.name} ${r.expiry}|${strikeOf(r.strike)}|${type}`;
  } else if (r.exch_seg === "MCX" && t === "FUTCOM") {
    key = `MCXFUT|${r.name} ${r.expiry}`;
    if (mcxMultiplier[r.name]) (mcx[r.name] ??= new Set()).add(isoOf(r.expiry));
    else skipped.MCX.add(r.name);
  } else if (r.exch_seg === "NCDEX" && t === "FUTCOM") {
    key = `NCDEX|${r.name} ${r.expiry}`;
    if (NCDEX_MULTIPLIER[r.name]) (ncdex[r.name] ??= new Set()).add(isoOf(r.expiry));
    else skipped.NCDEX.add(r.name);
  } else if (r.exch_seg === "NSE" && /-(EQ|BE|SM|ST)$/.test(r.symbol)) {
    // EQ plus trade-for-trade (BE) and SME (SM/ST) series; EQ wins if a name has several.
    key = `NSEEQ|${r.name}`;
    if (tokens[key] && !r.symbol.endsWith("-EQ")) continue;
    equities.add(r.name);
  } else {
    continue;
  }
  tokens[key] = `${r.exch_seg}:${r.token}`;
  counts[key.split("|")[0]]++;
}

writeFileSync(TOKENS_OUT, JSON.stringify(tokens));
console.log(`Wrote ${TOKENS_OUT}: ${Object.keys(tokens).length} contracts`, counts);

// ---------------------------------------------------------------------------
// exchange-master.ts
// ---------------------------------------------------------------------------

const q = (s) => JSON.stringify(s);
const commodityBlock = (bySymbol, multipliers) =>
  Object.keys(bySymbol)
    .sort()
    .map((s) => `  ${q(s)}: { lot: ${multipliers[s]}, expiries: [${[...bySymbol[s]].sort().map(q).join(", ")}] },`)
    .join("\n");
const eqLines = [];
const eqList = [...equities].sort();
for (let i = 0; i < eqList.length; i += 10) eqLines.push("  " + eqList.slice(i, i + 10).map(q).join(", ") + ",");

writeFileSync(
  MASTER_OUT,
  `// AUTO-GENERATED by scripts/update-angel-tokens.mjs — do not edit by hand.
// Source: Angel One SmartAPI instrument master (contracts), Upstox MCX master
// (MCX price multipliers), NCDEX contract specifications (NCDEX multipliers).
// Run \`npm run update:fo\` to refresh.

export interface CommodityMaster {
  /** Price multiplier per lot: quantity per lot in the price-quotation unit. */
  lot: number;
  expiries: string[];
}

/** NSE cash-market equities (EQ series), traded in units (lot 1). */
export const NSE_EQUITIES: readonly string[] = [
${eqLines.join("\n")}
];

export const MCX_FUTURES: Record<string, CommodityMaster> = {
${commodityBlock(mcx, mcxMultiplier)}
};

export const NCDEX_FUTURES: Record<string, CommodityMaster> = {
${commodityBlock(ncdex, NCDEX_MULTIPLIER)}
};
`
);
console.log(
  `Wrote ${MASTER_OUT}: ${eqList.length} equities, ${Object.keys(mcx).length} MCX, ${Object.keys(ncdex).length} NCDEX commodities`
);
if (skipped.MCX.size) console.log(`MCX without a known multiplier (left out): ${[...skipped.MCX].join(", ")}`);
if (skipped.NCDEX.size) console.log(`NCDEX without a verified multiplier (left out): ${[...skipped.NCDEX].sort().join(", ")}`);
