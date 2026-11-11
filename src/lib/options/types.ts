import type { IntervalId, SymbolId } from "../types.js";

export type OptionRight = "CE" | "PE";
export type PremiumSource = "chain" | "estimate";
export type ExpiryKind = "weekly" | "monthly";

export interface OptionContract {
  symbol: SymbolId;
  right: OptionRight;
  strike: number;
  expiry: string;
  expiryKind: ExpiryKind;
  daysLeft: number;
  lotSize: number;
}

export interface OptionQuote {
  premium: number;
  source: PremiumSource;
  delta: number;
  theta: number;
  iv: number;
  asOf: number;
  detail: string;
}

export interface OptionPending {
  symbol: SymbolId;
  right: OptionRight;
  strike: number;
  expiry: string;
  expiryKind: ExpiryKind;
  direction: "long" | "short";
  indexEntry: number;
  indexStop: number;
  indexTarget: number;
  premiumEntry: number;
  premiumStop: number;
  premiumTarget: number;
  premiumSource: PremiumSource;
  signalTime: number;
  interval: IntervalId;
  lotSize: number;
  deltaAtArm: number;
}

export interface OptionPosition {
  id: string;
  symbol: SymbolId;
  right: OptionRight;
  strike: number;
  expiry: string;
  expiryKind: ExpiryKind;
  direction: "long" | "short";
  indexEntry: number;
  indexStop: number;
  indexTarget: number;
  premiumEntry: number;
  premiumStop: number;
  premiumTarget: number;
  premiumSource: PremiumSource;
  signalTime: number;
  openedAt: number;
  interval: IntervalId;
  lotSize: number;
  deltaAtEntry: number;
}

export interface OptionTrade {
  id: string;
  symbol: SymbolId;
  right: OptionRight;
  strike: number;
  expiry: string;
  direction: "long" | "short";
  premiumEntry: number;
  premiumExit: number;
  premiumStop: number;
  premiumTarget: number;
  premiumSource: PremiumSource;
  signalTime: number;
  openedAt: number;
  closedAt: number;
  lotSize: number;
  points: number;
  pnl: number;
  reason: "stop" | "target" | "flatten" | "expiry";
  interval: IntervalId;
}

export interface OptionSymbolState {
  pending: OptionPending | null;
  position: OptionPosition | null;
  seenEntry: Record<string, true>;
  seenExit: Record<string, true>;
  processedClose: Partial<Record<IntervalId, number>>;
}

export interface OptionsBook {
  startingCash: number;
  cash: number;
  trades: OptionTrade[];
  symbols: Record<SymbolId, OptionSymbolState>;
}

export interface ChainContractQuote {
  strike: number;
  right: OptionRight;
  expiry: string;
  ltp: number;
}

export interface OptionChainResponse {
  ok: boolean;
  symbol: SymbolId;
  source?: "nse" | "groww";
  sourceDetail?: string;
  expiry?: string;
  expiryKind?: ExpiryKind;
  contracts?: ChainContractQuote[];
  error?: string;
  fetchedAt: number;
}
