import { round2 } from "../format.js";
import { istParts, unixFromIst } from "../time.js";
import type { SymbolId } from "../types.js";
import { nearestExpiry, pickStrike } from "./expiry.js";
import type { OptionQuote, OptionRight, PremiumSource } from "./types.js";

const RATE = 0.065;

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function yearFractionToExpiry(expiry: string, now: Date): number {
  const parts = istParts(now);
  const [y, m, d] = expiry.split("-").map(Number);
  const end = unixFromIst(y, m, d, 15, 30);
  const nowSec = Math.floor(now.getTime() / 1000);
  const seconds = Math.max(30 * 60, end - nowSec);
  return seconds / (365.25 * 24 * 3600);
}

export function defaultIv(symbol: SymbolId, atr: number | null, spot: number): number {
  if (atr != null && spot > 0) {
    const daily = atr / spot;
    const annual = daily * Math.sqrt(252);
    return Math.min(0.55, Math.max(0.08, annual));
  }
  return symbol === "BANKNIFTY" ? 0.16 : 0.12;
}

export function blackScholes(args: {
  spot: number;
  strike: number;
  right: OptionRight;
  years: number;
  iv: number;
  rate?: number;
}): { premium: number; delta: number; theta: number } {
  const S = Math.max(1, args.spot);
  const K = Math.max(1, args.strike);
  const T = Math.max(1 / (365.25 * 24), args.years);
  const sigma = Math.max(0.01, args.iv);
  const r = args.rate ?? RATE;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discount = Math.exp(-r * T);
  if (args.right === "CE") {
    const premium = S * normCdf(d1) - K * discount * normCdf(d2);
    const delta = normCdf(d1);
    const theta = (-(S * normPdf(d1) * sigma) / (2 * sqrtT) - r * K * discount * normCdf(d2)) / 365.25;
    return { premium: round2(Math.max(0.05, premium)), delta: round2(delta), theta: round2(theta) };
  }
  const premium = K * discount * normCdf(-d2) - S * normCdf(-d1);
  const delta = round2(normCdf(d1) - 1);
  const theta = (-(S * normPdf(d1) * sigma) / (2 * sqrtT) + r * K * discount * normCdf(-d2)) / 365.25;
  return { premium: round2(Math.max(0.05, premium)), delta, theta: round2(theta) };
}

export function estimatePremium(args: {
  symbol: SymbolId;
  spot: number;
  strike: number;
  right: OptionRight;
  expiry: string;
  atr?: number | null;
  now?: Date;
  source?: PremiumSource;
  chainLtp?: number | null;
}): OptionQuote {
  const now = args.now ?? new Date();
  const iv = defaultIv(args.symbol, args.atr ?? null, args.spot);
  const years = yearFractionToExpiry(args.expiry, now);
  const model = blackScholes({ spot: args.spot, strike: args.strike, right: args.right, years, iv });
  if (args.chainLtp != null && args.chainLtp > 0) {
    return {
      premium: round2(args.chainLtp),
      source: "chain",
      delta: model.delta,
      theta: model.theta,
      iv,
      asOf: Math.floor(now.getTime() / 1000),
      detail: "Exchange LTP from the option chain.",
    };
  }
  return {
    premium: model.premium,
    source: "estimate",
    delta: model.delta,
    theta: model.theta,
    iv,
    asOf: Math.floor(now.getTime() / 1000),
    detail: `Modeled Black–Scholes premium (IV ${(iv * 100).toFixed(0)}%). Not exchange LTP.`,
  };
}

export function buildContractLevels(args: {
  symbol: SymbolId;
  spot: number;
  right: OptionRight;
  indexEntry: number;
  indexStop: number;
  indexTarget: number;
  atr?: number | null;
  listedStrikes?: number[];
  chainLtps?: Partial<Record<number, number>>;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const expiryInfo = nearestExpiry(args.symbol, now);
  const strike = pickStrike({
    symbol: args.symbol,
    spot: args.indexEntry,
    right: args.right,
    listed: args.listedStrikes,
  });
  const entryQ = estimatePremium({
    symbol: args.symbol,
    spot: args.indexEntry,
    strike,
    right: args.right,
    expiry: expiryInfo.expiry,
    atr: args.atr,
    now,
    chainLtp: args.chainLtps?.[strike] ?? null,
  });
  const stopQ = estimatePremium({
    symbol: args.symbol,
    spot: args.indexStop,
    strike,
    right: args.right,
    expiry: expiryInfo.expiry,
    atr: args.atr,
    now,
  });
  const targetQ = estimatePremium({
    symbol: args.symbol,
    spot: args.indexTarget,
    strike,
    right: args.right,
    expiry: expiryInfo.expiry,
    atr: args.atr,
    now,
  });
  // Long option only: stop must be below entry premium, target above.
  let premiumStop = Math.min(stopQ.premium, round2(entryQ.premium * 0.55));
  let premiumTarget = Math.max(targetQ.premium, round2(entryQ.premium + Math.max(1, (entryQ.premium - premiumStop) * 1.5)));
  if (premiumStop >= entryQ.premium) premiumStop = round2(Math.max(0.05, entryQ.premium * 0.55));
  if (premiumTarget <= entryQ.premium) premiumTarget = round2(entryQ.premium + Math.max(1, (entryQ.premium - premiumStop) * 1.5));
  return {
    expiry: expiryInfo,
    strike,
    premiumEntry: entryQ.premium,
    premiumStop,
    premiumTarget,
    premiumSource: entryQ.source,
    delta: entryQ.delta,
    theta: entryQ.theta,
    quoteDetail: entryQ.detail,
  };
}

export function markOption(args: {
  symbol: SymbolId;
  spot: number;
  strike: number;
  right: OptionRight;
  expiry: string;
  atr?: number | null;
  chainLtp?: number | null;
  now?: Date;
}): OptionQuote {
  return estimatePremium({
    symbol: args.symbol,
    spot: args.spot,
    strike: args.strike,
    right: args.right,
    expiry: args.expiry,
    atr: args.atr,
    now: args.now,
    chainLtp: args.chainLtp,
  });
}

/** Index points still needed for the long option to reach a premium target, via delta. */
export function indexPointsToPremium(args: {
  markPremium: number;
  targetPremium: number;
  delta: number;
}): number | null {
  const absDelta = Math.abs(args.delta);
  if (absDelta < 0.05) return null;
  return round2((args.targetPremium - args.markPremium) / absDelta);
}
