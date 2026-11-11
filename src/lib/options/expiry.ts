import { istParts, unixFromIst } from "../time.js";
import type { SymbolId } from "../types.js";
import type { ExpiryKind } from "./types.js";

/** NSE cash-market holidays that shift F&O expiry to the prior trading day (2026). */
const NSE_HOLIDAYS_2026 = new Set([
  "2026-01-26",
  "2026-03-03",
  "2026-03-26",
  "2026-03-31",
  "2026-04-03",
  "2026-04-14",
  "2026-05-01",
  "2026-05-28",
  "2026-09-14",
  "2026-10-02",
  "2026-10-20",
  "2026-11-08",
  "2026-11-24", // Prakash Gurpurb — Nov monthly moves to Mon 23 Nov
  "2026-12-25",
]);

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseYmd(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

function addDays(key: string, delta: number): string {
  const { y, m, d } = parseYmd(key);
  const utc = Date.UTC(y, m - 1, d) + delta * 86400000;
  const date = new Date(utc);
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function weekdayOf(key: string): number {
  const { y, m, d } = parseYmd(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun … 2 Tue
}

function isWeekend(key: string): boolean {
  const day = weekdayOf(key);
  return day === 0 || day === 6;
}

function isHoliday(key: string): boolean {
  return NSE_HOLIDAYS_2026.has(key) || isWeekend(key);
}

/** Move expiry to the previous trading day when the listed day is a holiday. */
export function priorTradingDay(key: string): string {
  let cursor = key;
  while (isHoliday(cursor)) cursor = addDays(cursor, -1);
  return cursor;
}

function lastTuesdayOfMonth(year: number, month: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let key = ymd(year, month, lastDay);
  while (weekdayOf(key) !== 2) key = addDays(key, -1);
  return priorTradingDay(key);
}

function nextTuesdayOnOrAfter(key: string): string {
  let cursor = key;
  while (weekdayOf(cursor) !== 2) cursor = addDays(cursor, 1);
  return priorTradingDay(cursor);
}

export interface NearestExpiry {
  expiry: string;
  kind: ExpiryKind;
  daysLeft: number;
  label: string;
}

/**
 * NSE 2026 schedule (Zerodha / NSE product notes):
 * - Nifty 50: weekly every Tuesday; monthly = last Tuesday of the month.
 * - Bank Nifty: monthly only on the last Tuesday (no weeklies after SEBI rationalisation).
 * Holiday → previous trading day.
 */
export function nearestExpiry(symbol: SymbolId, now: Date = new Date()): NearestExpiry {
  const parts = istParts(now);
  const today = parts.dateKey;
  const sessionEnd = unixFromIst(parts.year, parts.month, parts.day, 15, 30);

  if (symbol === "NIFTY") {
    let candidate = nextTuesdayOnOrAfter(today);
    // On expiry day after the square-off window, roll to the next Tuesday.
    if (candidate === today && Math.floor(now.getTime() / 1000) >= sessionEnd) {
      candidate = nextTuesdayOnOrAfter(addDays(today, 1));
    }
    const monthly = lastTuesdayOfMonth(parts.year, parts.month);
    const kind: ExpiryKind = candidate === monthly ? "monthly" : "weekly";
    const daysLeft = Math.max(0, Math.round((Date.parse(`${candidate}T00:00:00+05:30`) - Date.parse(`${today}T00:00:00+05:30`)) / 86400000));
    return {
      expiry: candidate,
      kind,
      daysLeft,
      label: kind === "weekly" ? "Nifty weekly (Tuesday)" : "Nifty monthly (last Tuesday)",
    };
  }

  // Bank Nifty — monthly only
  let year = parts.year;
  let month = parts.month;
  let candidate = lastTuesdayOfMonth(year, month);
  if (candidate < today || (candidate === today && Math.floor(now.getTime() / 1000) >= sessionEnd)) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    candidate = lastTuesdayOfMonth(year, month);
  }
  const daysLeft = Math.max(0, Math.round((Date.parse(`${candidate}T00:00:00+05:30`) - Date.parse(`${today}T00:00:00+05:30`)) / 86400000));
  return {
    expiry: candidate,
    kind: "monthly",
    daysLeft,
    label: "Bank Nifty monthly (last Tuesday)",
  };
}

export function isExpiryDay(expiry: string, now: Date = new Date()): boolean {
  return istParts(now).dateKey === expiry;
}

/** Square-off window starts at 15:20 IST on expiry day (before 15:30 settlement). */
export function shouldSquareOffExpiry(expiry: string, now: Date = new Date()): boolean {
  if (!isExpiryDay(expiry, now)) return false;
  const parts = istParts(now);
  const mins = parts.hour * 60 + parts.minute;
  return mins >= 15 * 60 + 20;
}

export function strikeStep(symbol: SymbolId): number {
  return symbol === "BANKNIFTY" ? 100 : 50;
}

export function atmStrike(spot: number, symbol: SymbolId): number {
  const step = strikeStep(symbol);
  return Math.round(spot / step) * step;
}

/** Prefer ATM; use one strike OTM when a listed set is provided and contains it. */
export function pickStrike(args: {
  symbol: SymbolId;
  spot: number;
  right: "CE" | "PE";
  listed?: number[];
}): number {
  const atm = atmStrike(args.spot, args.symbol);
  const step = strikeStep(args.symbol);
  const otm = args.right === "CE" ? atm + step : atm - step;
  if (!args.listed?.length) return atm;
  const set = new Set(args.listed);
  if (set.has(atm)) return atm;
  if (set.has(otm)) return otm;
  let best = args.listed[0];
  let bestDist = Math.abs(best - atm);
  for (const strike of args.listed) {
    const dist = Math.abs(strike - atm);
    if (dist < bestDist) {
      best = strike;
      bestDist = dist;
    }
  }
  return best;
}

export function formatExpiryLabel(expiry: string): string {
  const { y, m, d } = parseYmd(expiry);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}
