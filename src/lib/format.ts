import { istParts } from "./time.js";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function px(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function signedPx(n: number): string {
  const body = px(Math.abs(n));
  if (n > 0) return `+${body}`;
  if (n < 0) return `−${body}`;
  return body;
}

export function inr(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n > 0) return `+₹${abs}`;
  if (n < 0) return `−₹${abs}`;
  return `₹${abs}`;
}

export function inrPlain(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `−₹${abs}` : `₹${abs}`;
}

export function rMultiple(n: number): string {
  return `${n.toFixed(2)}R`;
}

export function formatClock(date: Date): string {
  const p = istParts(date);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", month: "short" })
    .format(date)
    .toUpperCase();
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  const ss = String(p.second).padStart(2, "0");
  return `${p.weekday.toUpperCase()} ${String(p.day).padStart(2, "0")} ${month}  ${hh}:${mm}:${ss} IST`;
}

export function formatBarTime(unixSec: number): string {
  const date = new Date(unixSec * 1000);
  const p = istParts(date);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", month: "short" }).format(date);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${p.day} ${month} ${hh}:${mm} IST`;
}

export function formatAxisTime(unixSec: number): string {
  const p = istParts(new Date(unixSec * 1000));
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function formatAxisDay(unixSec: number): string {
  const date = new Date(unixSec * 1000);
  const p = istParts(date);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", month: "short" }).format(date);
  return `${p.day} ${month}`;
}
