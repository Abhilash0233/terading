import { INTERVAL_SECONDS, type IntervalId } from "./types.js";

export const IST_OFFSET_SEC = 19800;

export function unixFromIst(y: number, m: number, d: number, hh: number, mm: number, ss = 0): number {
  return Math.round(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000 - IST_OFFSET_SEC);
}

export interface IstParts {
  weekday: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateKey: string;
}

export function istParts(date: Date): IstParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  const hour = Number(bag.hour);
  return {
    weekday: bag.weekday ?? "",
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    dateKey: `${bag.year}-${bag.month}-${bag.day}`,
  };
}

export function istDateKey(unixSec: number): string {
  return istParts(new Date(unixSec * 1000)).dateKey;
}

/** Shift an IST YYYY-MM-DD key by a whole number of calendar days. */
export function shiftIstDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d) + days * 86400000;
  const next = new Date(utc);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/** Monday of the IST week that contains dateKey (Mon–Sun weeks). */
export function istWeekStartKey(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  // Use noon UTC so the weekday matches the calendar date.
  const weekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 Sun … 1 Mon
  const back = weekday === 0 ? 6 : weekday - 1;
  return shiftIstDateKey(dateKey, -back);
}

export function istMonthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export type BlotterRange = "today" | "yesterday" | "week" | "month";

export function tradeInBlotterRange(closedAt: number, range: BlotterRange, nowSec: number): boolean {
  const today = istDateKey(nowSec);
  const closed = istDateKey(closedAt);
  if (range === "today") return closed === today;
  if (range === "yesterday") return closed === shiftIstDateKey(today, -1);
  if (range === "week") return closed >= istWeekStartKey(today) && closed <= today;
  return istMonthKey(closed) === istMonthKey(today);
}

export function inSession(unixSec: number): boolean {
  const parts = istParts(new Date(unixSec * 1000));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const mins = parts.hour * 60 + parts.minute;
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

export function sessionState(date: Date): { open: boolean; label: string } {
  const open = inSession(Math.floor(date.getTime() / 1000));
  return { open, label: open ? "Session open" : "Session closed" };
}

export function higherInterval(interval: IntervalId): IntervalId | null {
  if (interval === "5m") return "15m";
  if (interval === "15m") return "1h";
  return null;
}

export function snapBarTime(unixSec: number, interval: IntervalId): number {
  const step = INTERVAL_SECONDS[interval];
  const sessionStart = 9 * 3600 + 15 * 60;
  const ist = unixSec + IST_OFFSET_SEC;
  const day = Math.floor(ist / 86400);
  const sod = ist - day * 86400;
  const rel = sod - sessionStart;
  const steps = Math.floor(rel / step);
  const snappedSod = sessionStart + steps * step;
  return day * 86400 + snappedSod - IST_OFFSET_SEC;
}

export function splitCandles(times: number[], interval: IntervalId, nowSec: number): { lastClosed: number; forming: number } {
  const step = INTERVAL_SECONDS[interval];
  let lastClosed = -1;
  for (let i = 0; i < times.length; i++) {
    if (times[i] + step <= nowSec) lastClosed = i;
  }
  const forming = lastClosed < times.length - 1 ? times.length - 1 : -1;
  return { lastClosed, forming };
}

export function lastClosedHtfIndex(
  execTime: number,
  execInterval: IntervalId,
  htfTimes: number[],
  htfInterval: IntervalId,
  asOf: number,
): number {
  const limit = Math.min(execTime + INTERVAL_SECONDS[execInterval], asOf);
  const step = INTERVAL_SECONDS[htfInterval];
  let lo = 0;
  let hi = htfTimes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htfTimes[mid] + step <= limit) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
