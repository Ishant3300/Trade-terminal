import type { Instrument, Segment, TerminalData } from "./types";

export const TERMINAL_USER = "Jiten";
export const TERMINAL_IP = "192.168.1.25";

const inst = (name: string, symbol: string, segment: Segment, lotSize: number, ltp: number): Instrument => ({
  name, symbol, segment, lotSize, ltp,
  low: +(ltp * 0.988).toFixed(2),
  high: +(ltp * 1.011).toFixed(2),
});

export const INSTRUMENTS: Instrument[] = [
  inst("NIFTY 27OCT2026", "NIFTY", "NSEFUT", 25, 25480),
  inst("BANKNIFTY 27OCT2026", "BANKNIFTY", "NSEFUT", 15, 56120),
  inst("RELIANCE 27OCT2026", "RELIANCE", "NSEFUT", 500, 1452.3),
  inst("BHEL 27OCT2026", "BHEL", "NSEFUT", 2625, 268.45),
  inst("SBIN 27OCT2026", "SBIN", "NSEFUT", 750, 862.1),
  inst("NIFTY 27OCT2026", "NIFTY", "NSEOPT", 25, 25480),
  inst("BANKNIFTY 27OCT2026", "BANKNIFTY", "NSEOPT", 15, 56120),
  inst("CRUDEOIL 19OCT2026", "CRUDEOIL", "MCXFUT", 100, 5680),
  inst("GOLDM 05NOV2026", "GOLDM", "MCXFUT", 10, 118450),
  inst("SILVERM 30NOV2026", "SILVERM", "MCXFUT", 5, 142300),
  inst("NATURALGAS 27OCT2026", "NATURALGAS", "MCXFUT", 1250, 268.4),
  inst("DHANIYA 20OCT2026", "DHANIYA", "NCDEX", 5, 7420),
  inst("JEERAUNJHA 20OCT2026", "JEERAUNJHA", "NCDEX", 3, 23850),
  inst("GUARSEED10 20OCT2026", "GUARSEED10", "NCDEX", 5, 5320),
  inst("RELIANCE", "RELIANCE", "NSEEQ", 1, 1451.8),
  inst("BHEL", "BHEL", "NSEEQ", 1, 268.2),
  inst("TATASTEEL", "TATASTEEL", "NSEEQ", 1, 168.35),
  inst("INFY", "INFY", "NSEEQ", 1, 1512),
];

/** Starting state: no accounts, slabs or trades. */
export function createEmptyData(): TerminalData {
  return { accounts: [], slabs: [], trades: [], nextTradeId: 1, nextSlabId: 1 };
}
