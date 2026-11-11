import { istDateKey, inSession } from "./time.js";
import type { BarIndicators, Candle } from "./types";

export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period < 1) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let ema = seed / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function rsiSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period || period < 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const rsiAt = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = rsiAt(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const g = change > 0 ? change : 0;
    const l = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiAt(avgGain, avgLoss);
  }
  return out;
}

export function trueRanges(candles: Candle[]): number[] {
  return candles.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prev = candles[i - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
  });
}

export function atrSeries(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period || period < 1) return out;
  const tr = trueRanges(candles);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let atr = sum / period;
  out[period - 1] = atr;
  for (let i = period; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

export function computeIndicators(candles: Candle[]): BarIndicators[] {
  const closes = candles.map((c) => c.close);
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const rsi = rsiSeries(closes, 14);
  const atr = atrSeries(candles, 14);
  const vwap = sessionVwap(candles);
  return candles.map((bar, i) => ({
    time: bar.time,
    ema9: ema9[i],
    ema21: ema21[i],
    vwap: vwap.values[i],
    rsi: rsi[i],
    atr: atr[i],
    vwapMode: vwap.modes[i],
  }));
}

function sessionVwap(candles: Candle[]): { values: (number | null)[]; modes: ("volume" | "equal-weight")[] } {
  const values: (number | null)[] = new Array(candles.length).fill(null);
  const modes: ("volume" | "equal-weight")[] = new Array(candles.length).fill("equal-weight");
  const groups = new Map<string, number[]>();
  candles.forEach((bar, i) => {
    if (!inSession(bar.time)) return;
    const key = istDateKey(bar.time);
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });
  for (const indexes of groups.values()) {
    const totalVolume = indexes.reduce((sum, i) => sum + candles[i].volume, 0);
    const mode = totalVolume > 0 ? "volume" : "equal-weight";
    let pv = 0;
    let w = 0;
    for (const i of indexes) {
      const bar = candles[i];
      const typical = (bar.high + bar.low + bar.close) / 3;
      const weight = mode === "volume" ? bar.volume : 1;
      pv += typical * weight;
      w += weight;
      values[i] = w > 0 ? pv / w : null;
      modes[i] = mode;
    }
  }
  return { values, modes };
}

export function structureRead(candles: Candle[], index: number): string {
  if (index < 5) return "Not enough bars for a structure read.";
  const start = Math.max(1, index - 22);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = start; i <= index - 1; i++) {
    if (i - 1 < 0 || i + 1 > index) continue;
    const prev = candles[i - 1];
    const bar = candles[i];
    const next = candles[i + 1];
    if (bar.high > prev.high && bar.high > next.high) highs.push(bar.high);
    if (bar.low < prev.low && bar.low < next.low) lows.push(bar.low);
  }
  if (highs.length < 2 || lows.length < 2) return "Structure not formed — fewer than two swings.";
  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];
  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];
  const hh = h2 > h1;
  const lh = h2 < h1;
  const hl = l2 > l1;
  const ll = l2 < l1;
  const swings = `swings ${h1.toFixed(2)} → ${h2.toFixed(2)}, ${l1.toFixed(2)} → ${l2.toFixed(2)}`;
  if (hh && hl) return `Bullish structure (higher high, higher low), ${swings}.`;
  if (lh && ll) return `Bearish structure (lower high, lower low), ${swings}.`;
  if (lh && hl) return `Range (lower high, higher low), ${swings}.`;
  if (hh && ll) return `Expanding structure (higher high, lower low), ${swings}.`;
  return `Mixed structure, ${swings}.`;
}
