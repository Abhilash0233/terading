import { px, round2 } from "./format.js";
import { structureRead } from "./indicators.js";
import { lastClosedHtfIndex } from "./time.js";
import {
  INTERVAL_LABEL,
  type BarIndicators,
  type Bias,
  type BiasRead,
  type Candle,
  type Condition,
  type IntervalId,
  type Sentiment,
  type Setup,
  type Side,
  type SymbolId,
} from "./types.js";

const PULLBACK_ATR = 0.25;
const STOP_ATR = 0.5;
const TARGET_R = 1.5;
const BEYOND_TICK = 0.05;
const LOOKBACK = 4;

export function trendBias(close: number, vwap: number | null, ema9: number | null, ema21: number | null): BiasRead {
  if (vwap == null || ema9 == null || ema21 == null) {
    return { bias: "neutral", detail: "VWAP or the EMA stack is not ready." };
  }
  const aboveVwap = close > vwap;
  const belowVwap = close < vwap;
  const emaUp = ema9 > ema21;
  const emaDown = ema9 < ema21;
  if (aboveVwap && emaUp) {
    return { bias: "bullish", detail: `close ${px(close)} is above session VWAP ${px(vwap)} and EMA9 ${px(ema9)} is above EMA21 ${px(ema21)}.` };
  }
  if (belowVwap && emaDown) {
    return { bias: "bearish", detail: `close ${px(close)} is below session VWAP ${px(vwap)} and EMA9 ${px(ema9)} is below EMA21 ${px(ema21)}.` };
  }
  const vwapText = aboveVwap ? "above session VWAP" : belowVwap ? "below session VWAP" : "on session VWAP";
  const emaText = emaUp ? "EMA9 is above EMA21" : emaDown ? "EMA9 is below EMA21" : "EMA9 equals EMA21";
  return { bias: "neutral", detail: `close is ${vwapText}, but ${emaText}.` };
}

export function rsiRegime(rsi: number | null): BiasRead {
  if (rsi == null) return { bias: "neutral", detail: "RSI 14 is not ready." };
  if (rsi >= 60) return { bias: "bullish", detail: `RSI ${rsi.toFixed(1)} is in the bullish regime (at or above 60).` };
  if (rsi <= 40) return { bias: "bearish", detail: `RSI ${rsi.toFixed(1)} is in the bearish regime (at or below 40).` };
  return { bias: "neutral", detail: `RSI ${rsi.toFixed(1)} is neutral (between 40 and 60).` };
}

export function vwapVote(close: number, vwap: number | null): BiasRead {
  if (vwap == null) return { bias: "neutral", detail: "Session VWAP is not ready." };
  const delta = close - vwap;
  if (delta > 0) return { bias: "bullish", detail: `Price ${px(close)} is ${px(delta)} above session VWAP ${px(vwap)}.` };
  if (delta < 0) return { bias: "bearish", detail: `Price ${px(close)} is ${px(Math.abs(delta))} below session VWAP ${px(vwap)}.` };
  return { bias: "neutral", detail: `Price ${px(close)} is on session VWAP.` };
}

export function emaVote(ema9: number | null, ema21: number | null): BiasRead {
  if (ema9 == null || ema21 == null) return { bias: "neutral", detail: "EMA stack is not ready." };
  if (ema9 > ema21) return { bias: "bullish", detail: `EMA9 ${px(ema9)} is above EMA21 ${px(ema21)}.` };
  if (ema9 < ema21) return { bias: "bearish", detail: `EMA9 ${px(ema9)} is below EMA21 ${px(ema21)}.` };
  return { bias: "neutral", detail: "EMA9 equals EMA21." };
}

export interface HtfInput {
  interval: IntervalId;
  candles: Candle[];
  ind: BarIndicators[];
}

function filterRead(
  interval: IntervalId,
  candles: Candle[],
  ind: BarIndicators[],
  index: number,
  htf: HtfInput | null,
  asOf: number,
): BiasRead {
  const bar = candles[index];
  const own = trendBias(bar.close, ind[index]?.vwap ?? null, ind[index]?.ema9 ?? null, ind[index]?.ema21 ?? null);
  if (interval === "1h") {
    return { bias: own.bias, detail: `1-hour is the top timeframe, so its own trend is the filter. ${own.detail}` };
  }
  const higher = interval === "5m" ? "15m" : "1h";
  if (!htf || htf.candles.length === 0) {
    return { bias: "neutral", detail: `${INTERVAL_LABEL[higher]} candles are unavailable, so the filter stands aside.` };
  }
  const htfIndex = lastClosedHtfIndex(bar.time, interval, htf.candles.map((c) => c.time), htf.interval, asOf);
  if (htfIndex < 0) {
    return { bias: "neutral", detail: `No closed ${INTERVAL_LABEL[htf.interval]} bar is available yet.` };
  }
  const htfBar = htf.candles[htfIndex];
  const htfInd = htf.ind[htfIndex];
  const read = trendBias(htfBar.close, htfInd?.vwap ?? null, htfInd?.ema9 ?? null, htfInd?.ema21 ?? null);
  return { bias: read.bias, detail: `${INTERVAL_LABEL[htf.interval]} bias is ${read.bias}. ${read.detail}` };
}

function combineSentiment(votes: Bias[]): Bias {
  const bull = votes.filter((v) => v === "bullish").length;
  const bear = votes.filter((v) => v === "bearish").length;
  if (bull >= 2 && bull > bear) return "bullish";
  if (bear >= 2 && bear > bull) return "bearish";
  return "neutral";
}

export function sentimentAt(
  interval: IntervalId,
  candles: Candle[],
  ind: BarIndicators[],
  index: number,
  htf: HtfInput | null,
  asOf: number,
): Sentiment {
  const structure = structureRead(candles, index);
  if (index < 0 || !candles[index] || !ind[index]) {
    return {
      bias: "neutral",
      structure,
      reasons: [{ id: "data", label: "Data", bias: "neutral", detail: "No candle to read." }],
    };
  }
  const bar = candles[index];
  const point = ind[index];
  const vwap = vwapVote(bar.close, point.vwap);
  const ema = emaVote(point.ema9, point.ema21);
  const rsi = rsiRegime(point.rsi);
  const htfBias = filterRead(interval, candles, ind, index, htf, asOf);
  const reasons = [
    { id: "vwap", label: "Price vs VWAP", bias: vwap.bias, detail: vwap.detail },
    { id: "ema", label: "EMA stack", bias: ema.bias, detail: ema.detail },
    { id: "rsi", label: "RSI regime", bias: rsi.bias, detail: rsi.detail },
    { id: "htf", label: "Higher-timeframe bias", bias: htfBias.bias, detail: htfBias.detail },
  ];
  return {
    bias: combineSentiment(reasons.map((r) => r.bias)),
    reasons,
    structure,
  };
}

interface Geometry {
  entry: number;
  stop: number;
  target: number;
  riskPoints: number;
  rMultiple: number;
  ok: boolean;
  detail: string;
}

function geometry(side: Side, bar: Candle, atr: number | null): Geometry {
  if (atr == null || !Number.isFinite(atr) || atr <= 0) {
    return { entry: 0, stop: 0, target: 0, riskPoints: 0, rMultiple: 0, ok: false, detail: "ATR 14 is not ready, so the stop cannot be placed outside noise." };
  }
  const entry = round2(side === "long" ? bar.high : bar.low);
  const extreme = round2(side === "long" ? bar.low : bar.high);
  const minDist = STOP_ATR * atr;
  const stop = side === "long"
    ? round2(Math.min(extreme - BEYOND_TICK, entry - minDist))
    : round2(Math.max(extreme + BEYOND_TICK, entry + minDist));
  const risk = round2(Math.abs(entry - stop));
  if (risk <= 0 || (side === "long" && stop >= entry) || (side === "short" && stop <= entry)) {
    return { entry, stop, target: entry, riskPoints: risk, rMultiple: 0, ok: false, detail: "Stop would not sit beyond the signal candle." };
  }
  const beyond = side === "long" ? stop < extreme : stop > extreme;
  const farEnough = risk + 1e-9 >= minDist - 0.02;
  let target = round2(side === "long" ? entry + TARGET_R * risk : entry - TARGET_R * risk);
  let guard = 0;
  while (guard < 6) {
    const reward = round2(Math.abs(target - entry));
    if (reward + 1e-9 >= TARGET_R * risk) break;
    target = round2(side === "long" ? target + 0.01 : target - 0.01);
    guard += 1;
  }
  const reward = round2(Math.abs(target - entry));
  const multiple = reward / risk;
  if (!beyond || !farEnough || multiple < TARGET_R - 1e-9) {
    return {
      entry,
      stop,
      target,
      riskPoints: risk,
      rMultiple: multiple,
      ok: false,
      detail: `R:R would be ${multiple.toFixed(2)}, under 1.50. Setup skipped.`,
    };
  }
  return {
    entry,
    stop,
    target,
    riskPoints: risk,
    rMultiple: multiple,
    ok: true,
    detail: `Stop ${px(stop)} is beyond the signal ${side === "long" ? "low" : "high"} ${px(extreme)} and ${px(risk)} points away (at least 0.50×ATR ${px(atr)}). Target ${px(target)} is ${multiple.toFixed(2)}R.`,
  };
}

function pullback(side: Side, candles: Candle[], ind: BarIndicators[], index: number): { ok: boolean; detail: string } {
  const atr = ind[index]?.atr;
  if (atr == null) return { ok: false, detail: "ATR is not ready, so a pullback cannot be measured." };
  const from = Math.max(0, index - LOOKBACK);
  for (let i = index; i >= from; i--) {
    const ema = ind[i]?.ema9;
    const vwap = ind[i]?.vwap;
    const bar = candles[i];
    if (side === "long") {
      if (ema != null && bar.low <= ema + PULLBACK_ATR * atr) {
        return { ok: true, detail: `Low ${px(bar.low)} came within 0.25×ATR of EMA9 ${px(ema)}.` };
      }
      if (vwap != null && bar.low <= vwap + PULLBACK_ATR * atr) {
        return { ok: true, detail: `Low ${px(bar.low)} came within 0.25×ATR of VWAP ${px(vwap)}.` };
      }
    } else {
      if (ema != null && bar.high >= ema - PULLBACK_ATR * atr) {
        return { ok: true, detail: `High ${px(bar.high)} came within 0.25×ATR of EMA9 ${px(ema)}.` };
      }
      if (vwap != null && bar.high >= vwap - PULLBACK_ATR * atr) {
        return { ok: true, detail: `High ${px(bar.high)} came within 0.25×ATR of VWAP ${px(vwap)}.` };
      }
    }
  }
  return { ok: false, detail: `No bar in the last ${LOOKBACK + 1} came within 0.25×ATR of EMA9 or session VWAP.` };
}

function reclaim(side: Side, candles: Candle[], ind: BarIndicators[], index: number): { ok: boolean; detail: string } {
  const ema = ind[index]?.ema9;
  const prevEma = index > 0 ? ind[index - 1]?.ema9 : null;
  if (ema == null || prevEma == null || index < 1) return { ok: false, detail: "EMA9 is not ready." };
  const bar = candles[index];
  const prev = candles[index - 1];
  if (side === "long") {
    const ok = bar.close > ema && (prev.close <= prevEma || bar.low <= ema);
    return ok
      ? { ok: true, detail: `Close ${px(bar.close)} reclaimed EMA9 ${px(ema)}.` }
      : { ok: false, detail: `Close ${px(bar.close)} has not reclaimed EMA9 ${px(ema)}.` };
  }
  const ok = bar.close < ema && (prev.close >= prevEma || bar.high >= ema);
  return ok
    ? { ok: true, detail: `Close ${px(bar.close)} reclaimed below EMA9 ${px(ema)}.` }
    : { ok: false, detail: `Close ${px(bar.close)} has not reclaimed below EMA9 ${px(ema)}.` };
}

function rsiBand(side: Side, rsi: number | null): { ok: boolean; detail: string } {
  if (rsi == null) return { ok: false, detail: "RSI 14 is not ready." };
  const low = side === "long" ? 40 : 35;
  const high = side === "long" ? 65 : 60;
  const ok = rsi >= low && rsi <= high;
  return {
    ok,
    detail: ok ? `RSI ${rsi.toFixed(1)} is inside ${low}–${high}.` : `RSI ${rsi.toFixed(1)} is outside ${low}–${high}.`,
  };
}

function emptySetup(symbol: SymbolId, interval: IntervalId, summary: string, structure: string): Setup {
  return {
    symbol,
    interval,
    status: "flat",
    direction: null,
    entry: null,
    stop: null,
    target: null,
    riskPoints: null,
    rMultiple: null,
    signalTime: null,
    conditions: [{ id: "data", label: "Candles", state: "fail", detail: summary }],
    summary,
    structure,
  };
}

export function evaluateSetupAt(
  symbol: SymbolId,
  interval: IntervalId,
  candles: Candle[],
  ind: BarIndicators[],
  index: number,
  htf: HtfInput | null,
  positionOpen: boolean,
  asOf: number,
): Setup {
  const structure = structureRead(candles, Math.max(0, index));
  if (index < 1 || !candles[index] || !ind[index]) {
    return emptySetup(symbol, interval, "Not enough closed candles for a setup.", structure);
  }
  const filter = filterRead(interval, candles, ind, index, htf, asOf);
  const htfLabel = interval === "1h" ? "1-hour trend" : `${INTERVAL_LABEL[interval === "5m" ? "15m" : "1h"]} bias`;
  if (filter.bias === "neutral") {
    const conditions: Condition[] = [
      { id: "htf", label: `${htfLabel} is directional`, state: "fail", detail: `Stand aside. ${filter.detail}` },
      { id: "pullback", label: "Pullback toward EMA9 or VWAP", state: "skip", detail: "Not evaluated while the higher timeframe is neutral." },
      { id: "reclaim", label: "Reclaim of EMA9", state: "skip", detail: "Not evaluated while the higher timeframe is neutral." },
      { id: "rsi", label: "RSI band", state: "skip", detail: "Not evaluated while the higher timeframe is neutral." },
      { id: "rr", label: "Stop beyond noise and R:R at least 1.5", state: "skip", detail: "Not evaluated while the higher timeframe is neutral." },
      { id: "flat", label: "No open position on this index", state: positionOpen ? "fail" : "pass", detail: positionOpen ? "A paper position is already open." : "Flat." },
    ];
    return {
      symbol,
      interval,
      status: "stand-aside",
      direction: null,
      entry: null,
      stop: null,
      target: null,
      riskPoints: null,
      rMultiple: null,
      signalTime: candles[index].time,
      conditions,
      summary: `Stand aside. ${filter.detail}`,
      structure,
    };
  }

  const side: Side = filter.bias === "bullish" ? "long" : "short";
  const pulled = pullback(side, candles, ind, index);
  const reclaimed = reclaim(side, candles, ind, index);
  const rsi = rsiBand(side, ind[index].rsi);
  const geo = geometry(side, candles[index], ind[index].atr);
  const conditions: Condition[] = [
    {
      id: "htf",
      label: side === "long" ? `${htfLabel} bullish` : `${htfLabel} bearish`,
      state: "pass",
      detail: filter.detail,
    },
    { id: "pullback", label: "Pullback toward EMA9 or VWAP", state: pulled.ok ? "pass" : "fail", detail: pulled.detail },
    { id: "reclaim", label: side === "long" ? "Reclaimed EMA9" : "Reclaimed below EMA9", state: reclaimed.ok ? "pass" : "fail", detail: reclaimed.detail },
    { id: "rsi", label: side === "long" ? "RSI between 40 and 65" : "RSI between 35 and 60", state: rsi.ok ? "pass" : "fail", detail: rsi.detail },
    { id: "rr", label: "Stop beyond the extreme, at least 0.5×ATR, target 1.5R", state: geo.ok ? "pass" : "fail", detail: geo.detail },
    {
      id: "flat",
      label: "No open position on this index",
      state: positionOpen ? "fail" : "pass",
      detail: positionOpen ? "A paper position is already open on this index." : "Flat.",
    },
  ];
  const failed = conditions.find((c) => c.state === "fail");
  const status = failed ? "flat" : side;
  const summary = failed
    ? `No trade. ${failed.detail}`
    : side === "long"
      ? "Long setup. Buy stop at the signal-candle high. Auto fills if a later candle trades through it."
      : "Short setup. Sell stop at the signal-candle low. Auto fills if a later candle trades through it.";
  return {
    symbol,
    interval,
    status,
    direction: side,
    entry: geo.entry,
    stop: geo.stop,
    target: geo.target,
    riskPoints: geo.riskPoints,
    rMultiple: geo.rMultiple,
    signalTime: candles[index].time,
    conditions,
    summary,
    structure,
  };
}
