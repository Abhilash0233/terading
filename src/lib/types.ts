export type SymbolId = "NIFTY" | "BANKNIFTY";
export type IntervalId = "5m" | "15m" | "1h";
export type Side = "long" | "short";
export type Bias = "bullish" | "neutral" | "bearish";
export type Mode = "live" | "replay";

export const SYMBOLS: { id: SymbolId; name: string; yahoo: string; groww: string }[] = [
  { id: "NIFTY", name: "Nifty 50", yahoo: "^NSEI", groww: "NIFTY" },
  { id: "BANKNIFTY", name: "Bank Nifty", yahoo: "^NSEBANK", groww: "BANKNIFTY" },
];

export const INTERVALS: IntervalId[] = ["5m", "15m", "1h"];

export const INTERVAL_SECONDS: Record<IntervalId, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

export const INTERVAL_LABEL: Record<IntervalId, string> = {
  "5m": "5-minute",
  "15m": "15-minute",
  "1h": "1-hour",
};

export const STARTING_CASH = 100_000;

/** NSE circular FAOP/70616 (3 Oct 2025), effective 28 Oct 2025 EOD. Oct 2026 contracts still use these lots. */
export const DEFAULT_LOTS: Record<SymbolId, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
};

export const LOT_NOTE =
  "NSE F&O market lot · circular FAOP/70616 · Nifty 65, Bank Nifty 30. Editable.";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarIndicators {
  time: number;
  ema9: number | null;
  ema21: number | null;
  vwap: number | null;
  rsi: number | null;
  atr: number | null;
  vwapMode: "volume" | "equal-weight";
}

export interface BiasRead {
  bias: Bias;
  detail: string;
}

export interface Condition {
  id: string;
  label: string;
  state: "pass" | "fail" | "skip";
  detail: string;
}

export interface Setup {
  symbol: SymbolId;
  interval: IntervalId;
  status: "long" | "short" | "flat" | "stand-aside";
  direction: Side | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskPoints: number | null;
  rMultiple: number | null;
  signalTime: number | null;
  conditions: Condition[];
  summary: string;
  structure: string;
}

export interface Sentiment {
  bias: Bias;
  reasons: { id: string; label: string; bias: Bias; detail: string }[];
  structure: string;
}

export interface PendingOrder {
  symbol: SymbolId;
  direction: Side;
  entry: number;
  stop: number;
  target: number;
  signalTime: number;
  riskPoints: number;
  rMultiple: number;
  lotSize: number;
  interval: IntervalId;
}

export interface Position {
  id: string;
  symbol: SymbolId;
  direction: Side;
  entry: number;
  stop: number;
  target: number;
  signalTime: number;
  openedAt: number;
  lotSize: number;
  interval: IntervalId;
  mode: Mode;
}

export interface Trade {
  id: string;
  symbol: SymbolId;
  direction: Side;
  entry: number;
  exit: number;
  stop: number;
  target: number;
  signalTime: number;
  openedAt: number;
  closedAt: number;
  lotSize: number;
  points: number;
  pnl: number;
  reason: "stop" | "target" | "flatten";
  interval: IntervalId;
  mode: Mode;
}

export interface ExecSlice {
  pending: PendingOrder | null;
  position: Position | null;
  seenEntry: Record<string, true>;
  seenExit: Record<string, true>;
}

export interface SymbolLiveState extends ExecSlice {
  processedClose: Partial<Record<IntervalId, number>>;
}

export interface BookUi {
  mode: Mode;
  symbol: SymbolId;
  interval: IntervalId;
  replayTime: Partial<Record<string, number>>;
  replayFlattens: Partial<Record<string, number[]>>;
}

export interface Book {
  startingCash: number;
  cash: number;
  auto: boolean;
  lots: Record<SymbolId, number>;
  trades: Trade[];
  symbols: Record<SymbolId, SymbolLiveState>;
  ui: BookUi;
}

export interface CandleResponse {
  ok: boolean;
  symbol: SymbolId;
  interval: IntervalId;
  source?: "yahoo" | "groww";
  sourceDetail?: string;
  warning?: string;
  candles?: Candle[];
  error?: string;
  fetchedAt?: number;
}

export interface QuoteTick {
  symbol: SymbolId;
  price: number;
  source: "yahoo" | "groww";
  sourceDetail: string;
  at: number;
}

export interface QuotesResponse {
  ok: boolean;
  quotes?: Partial<Record<SymbolId, QuoteTick>>;
  error?: string;
  fetchedAt: number;
}
