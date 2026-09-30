import { contractName, parseContract } from "./engine";
import { FO_DEFAULT_EXPIRIES, FO_EXPIRY_OVERRIDES, FO_LOTS } from "./fo-master";
import type { Instrument, Segment, TerminalData } from "./types";

export const TERMINAL_USER = "Jiten";
export const TERMINAL_IP = "192.168.1.25";

const inst = (name: string, symbol: string, segment: Segment, lotSize: number): Instrument => ({
  name, symbol, segment, lotSize, expiry: parseContract(name)?.expiry,
});

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

export const INSTRUMENTS: Instrument[] = [
  ...nseFoInstruments(),
  inst("CRUDEOIL 19OCT2026", "CRUDEOIL", "MCXFUT", 100),
  inst("GOLDM 05NOV2026", "GOLDM", "MCXFUT", 10),
  inst("SILVERM 30NOV2026", "SILVERM", "MCXFUT", 5),
  inst("NATURALGAS 27OCT2026", "NATURALGAS", "MCXFUT", 1250),
  inst("DHANIYA 20OCT2026", "DHANIYA", "NCDEX", 5),
  inst("JEERAUNJHA 20OCT2026", "JEERAUNJHA", "NCDEX", 3),
  inst("GUARSEED10 20OCT2026", "GUARSEED10", "NCDEX", 5),
  inst("RELIANCE", "RELIANCE", "NSEEQ", 1),
  inst("BHEL", "BHEL", "NSEEQ", 1),
  inst("TATASTEEL", "TATASTEEL", "NSEEQ", 1),
  inst("INFY", "INFY", "NSEEQ", 1),
];

/** Starting state: no accounts, slabs or trades. */
export function createEmptyData(): TerminalData {
  return { accounts: [], slabs: [], trades: [], nextTradeId: 1, nextSlabId: 1 };
}
