// Regenerates lib/terminal/angel-tokens.json from Angel One's SmartAPI
// instrument master, mapping each tradable contract to its Angel symbol token
// (needed to request live quotes). Server-only data; never sent to browsers.
//
//   npm run update:fo     (runs this after the NSE master update)
//
// Keys match quoteKey() in lib/terminal/engine.ts:
//   NSEFUT|NIFTY 27OCT2026            NSEOPT|NIFTY 27OCT2026|25500|CE
//   MCXFUT|CRUDEOIL 19OCT2026         NCDEX|DHANIYA 20OCT2026     NSEEQ|RELIANCE
// Values are "<angel exchange>:<token>".

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../lib/terminal/angel-tokens.json", import.meta.url));
const URL_MASTER = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

console.log(`Downloading ${URL_MASTER} …`);
const res = await fetch(URL_MASTER);
if (!res.ok) throw new Error(`Angel instrument master: HTTP ${res.status}`);
const rows = await res.json();

// Angel strikes are in paise-like units (x100): "2550000.000000" → 25500, "19250.000000" → 192.5
const strikeOf = (s) => String(Number(s) / 100);

const map = {};
let counts = { NSEFUT: 0, NSEOPT: 0, MCXFUT: 0, NCDEX: 0, NSEEQ: 0 };
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
  } else if (r.exch_seg === "NCDEX" && t === "FUTCOM") {
    key = `NCDEX|${r.name} ${r.expiry}`;
  } else if (r.exch_seg === "NSE" && r.symbol.endsWith("-EQ")) {
    key = `NSEEQ|${r.name}`;
  } else {
    continue;
  }
  map[key] = `${r.exch_seg}:${r.token}`;
  counts[key.split("|")[0]]++;
}

writeFileSync(OUT, JSON.stringify(map));
console.log(`Wrote ${OUT}: ${Object.keys(map).length} contracts`, counts);
