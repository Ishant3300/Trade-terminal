import { contractName } from "./engine";
import { MCX_FUTURES, NCDEX_FUTURES, NSE_EQUITIES, type CommodityMaster } from "./exchange-master";
import { FO_DEFAULT_EXPIRIES, FO_EXPIRY_OVERRIDES, FO_LOTS } from "./fo-master";
import type { Instrument, Segment } from "./types";

/** Every NSE F&O contract in the generated master (futures + option expiries). */
function nseFoInstruments(): Instrument[] {
  const out: Instrument[] = [];
  for (const [symbol, lotSize] of Object.entries(FO_LOTS)) {
    const custom = FO_EXPIRY_OVERRIDES[symbol];
    for (const expiry of custom?.fut ?? FO_DEFAULT_EXPIRIES.fut) {
      out.push({ name: contractName(symbol, expiry), symbol, segment: "NSEFUT", lotSize, expiry });
    }
    for (const expiry of custom?.opt ?? FO_DEFAULT_EXPIRIES.opt) {
      out.push({ name: contractName(symbol, expiry), symbol, segment: "NSEOPT", lotSize, expiry });
    }
  }
  return out;
}

function commodityInstruments(segment: Segment, master: Record<string, CommodityMaster>): Instrument[] {
  return Object.entries(master).flatMap(([symbol, { lot, expiries }]) =>
    expiries.map((expiry) => ({ name: contractName(symbol, expiry), symbol, segment, lotSize: lot, expiry }))
  );
}

export const INSTRUMENTS: Instrument[] = [
  ...nseFoInstruments(),
  ...commodityInstruments("MCXFUT", MCX_FUTURES),
  ...commodityInstruments("NCDEX", NCDEX_FUTURES),
  ...NSE_EQUITIES.map((symbol): Instrument => ({ name: symbol, symbol, segment: "NSEEQ", lotSize: 1 })),
];
