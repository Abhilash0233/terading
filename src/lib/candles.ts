import { snapBarTime } from "./time.js";
import type { Candle, IntervalId } from "./types";

export interface RawBar {
  time: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export function normalizeCandles(rows: RawBar[], interval: IntervalId): Candle[] {
  const mapped: Candle[] = [];
  for (const row of rows) {
    if (row.time == null || !Number.isFinite(row.time)) continue;
    const open = row.open;
    const high = row.high;
    const low = row.low;
    const close = row.close;
    if (open == null || high == null || low == null || close == null) continue;
    if (![open, high, low, close].every((n) => Number.isFinite(n))) continue;
    if (high < low || open <= 0 || close <= 0) continue;
    const unix = row.time > 1e12 ? Math.floor(row.time / 1000) : Math.floor(row.time);
    const volume = row.volume != null && Number.isFinite(row.volume) && row.volume > 0 ? row.volume : 0;
    mapped.push({
      time: snapBarTime(unix, interval),
      open,
      high,
      low,
      close,
      volume,
    });
  }
  mapped.sort((a, b) => a.time - b.time);
  const deduped: Candle[] = [];
  for (const bar of mapped) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.time === bar.time) deduped[deduped.length - 1] = bar;
    else deduped.push(bar);
  }
  return deduped;
}

/** Bars the server returns for `?tail=1`. Covers well over one 30 s poll, so a missed poll or two still merges cleanly. */
export const TAIL_BARS = 12;

/**
 * Merge the newest bars into a full history. Bars from the tail's first bar onward are replaced
 * (so a still-forming or revised bar is overwritten), earlier bars are kept as they are.
 * Returns null when the tail does not reach back to the history (a gap), so the caller must fetch
 * the full history instead.
 */
export function mergeCandles(history: Candle[], tail: Candle[]): Candle[] | null {
  if (tail.length === 0) return history;
  if (history.length === 0) return null;
  const first = tail[0].time;
  if (first > history[history.length - 1].time) return null;
  const kept = history.filter((bar) => bar.time < first);
  if (kept.length === 0) return null;
  return [...kept, ...tail];
}
