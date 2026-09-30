import type { Instrument, Segment, TerminalData } from "./types";

export const TERMINAL_USER = "Jiten";
export const TERMINAL_IP = "192.168.1.25";

const inst = (name: string, symbol: string, segment: Segment, lotSize: number): Instrument => ({
  name, symbol, segment, lotSize,
});

export const INSTRUMENTS: Instrument[] = [
  inst("NIFTY 27OCT2026", "NIFTY", "NSEFUT", 25),
  inst("BANKNIFTY 27OCT2026", "BANKNIFTY", "NSEFUT", 15),
  inst("RELIANCE 27OCT2026", "RELIANCE", "NSEFUT", 500),
  inst("BHEL 27OCT2026", "BHEL", "NSEFUT", 2625),
  inst("SBIN 27OCT2026", "SBIN", "NSEFUT", 750),
  inst("NIFTY 27OCT2026", "NIFTY", "NSEOPT", 25),
  inst("BANKNIFTY 27OCT2026", "BANKNIFTY", "NSEOPT", 15),
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
