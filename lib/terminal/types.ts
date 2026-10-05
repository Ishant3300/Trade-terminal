export type Segment = "NSEFUT" | "NSEOPT" | "MCXFUT" | "NCDEX" | "NSEEQ";
export const SEGMENTS: Segment[] = ["NSEFUT", "NSEOPT", "MCXFUT", "NCDEX", "NSEEQ"];
/** Segments where quantity must be a whole multiple of the lot size. */
export const DERIVATIVE_SEGMENTS: ReadonlySet<Segment> = new Set(["NSEFUT", "NSEOPT", "MCXFUT", "NCDEX"]);

export type Side = "B" | "S";
export type TradeType = "NRM" | "CF" | "BF";
export type OptionType = "" | "CE" | "PE";

export interface Instrument {
  /** Display / trade name, e.g. "NIFTY 27OCT2026". */
  name: string;
  /** Underlying symbol used for script-wise brokerage slabs, e.g. "NIFTY". */
  symbol: string;
  segment: Segment;
  lotSize: number;
  /** Contract expiry (YYYY-MM-DD) for derivatives. */
  expiry?: string;
}

export interface Trade {
  id: number;
  /** O = online (exchange/feed), T = terminal (manual entry). */
  ot: "O" | "T";
  date: string; // YYYY-MM-DD
  valan: string;
  segment: Segment;
  script: string;
  option: OptionType;
  strike: number;
  tradeType: TradeType;
  side: Side;
  lot: number;
  qty: number;
  rate: number;
  clientCode: string;
  /** Client paid the full amount: no interest on this buy. */
  fullPayment?: boolean;
  user: string;
  ip: string;
  addTime: string; // YYYY-MM-DD HH:MM:SS
}

export type AccountType = "Customer" | "Self" | "Broker";

export interface Account {
  code: string;
  name: string;
  type: AccountType;
  openingBalance: number;
  openingType: "Dr" | "Cr";
  mobile: string;
  email: string;
  address: string;
  remark: string;
  interestPct: number;
}

export type SlabMode = "PCT" | "FIX";

export interface Slab {
  id: number;
  clientCode: string;
  segment: Segment;
  scriptWise: boolean;
  /** Underlying symbol when scriptWise, else "". */
  script: string;
  mode: SlabMode;
  delPct: number;
  intraPct: number;
  fixDel: number;
  fixIntra: number;
  higherSideOnly: boolean;
  minRate: number;
  minPct: number;
  minPctOnDel: number;
}

export interface TerminalData {
  accounts: Account[];
  slabs: Slab[];
  trades: Trade[];
}
