import assert from "node:assert/strict";
import test from "node:test";
import { unixFromIst } from "../time.js";
import type { Candle, Setup } from "../types.js";
import { emptyOptionSymbol } from "./book.js";
import { nearestExpiry, pickStrike, priorTradingDay } from "./expiry.js";
import { pendingFromIndexSetup, reduceOptionBar } from "./execution.js";
import { blackScholes } from "./pricing.js";
import { describeOptionWatch } from "./watch.js";

test("Nifty uses weekly Tuesday expiry; Bank Nifty monthly last Tuesday", () => {
  const wed = new Date("2026-10-21T05:00:00+05:30");
  const nifty = nearestExpiry("NIFTY", wed);
  assert.equal(nifty.expiry, "2026-10-27");
  assert.equal(nifty.kind, "monthly"); // 27 Oct 2026 is last Tuesday of October
  assert.match(nifty.label, /Nifty/);

  const bank = nearestExpiry("BANKNIFTY", wed);
  assert.equal(bank.expiry, "2026-10-27");
  assert.equal(bank.kind, "monthly");
  assert.match(bank.label, /monthly/);

  const earlyNov = new Date("2026-11-02T10:00:00+05:30");
  const weekly = nearestExpiry("NIFTY", earlyNov);
  assert.equal(weekly.expiry, "2026-11-03");
  assert.equal(weekly.kind, "weekly");

  // Holiday 24 Nov 2026 → prior trading day 23 Nov
  assert.equal(priorTradingDay("2026-11-24"), "2026-11-23");
});

test("ATM strike and OTM fallback when listed", () => {
  assert.equal(pickStrike({ symbol: "NIFTY", spot: 22610, right: "CE" }), 22600);
  assert.equal(pickStrike({ symbol: "BANKNIFTY", spot: 55440, right: "PE" }), 55400);
  assert.equal(
    pickStrike({ symbol: "NIFTY", spot: 22610, right: "CE", listed: [22650, 22700] }),
    22650,
  );
});

test("Black-Scholes call premium rises with spot", () => {
  const low = blackScholes({ spot: 100, strike: 100, right: "CE", years: 7 / 365, iv: 0.15 });
  const high = blackScholes({ spot: 102, strike: 100, right: "CE", years: 7 / 365, iv: 0.15 });
  assert.ok(high.premium > low.premium);
  assert.ok(low.delta > 0.4 && low.delta < 0.7);
});

test("option buy arms CE on long and PE on short; never sells", () => {
  const longSetup: Setup = {
    symbol: "NIFTY",
    interval: "5m",
    status: "long",
    direction: "long",
    entry: 22600,
    stop: 22550,
    target: 22675,
    riskPoints: 50,
    rMultiple: 1.5,
    signalTime: unixFromIst(2026, 10, 21, 10, 0),
    conditions: [],
    summary: "long",
    structure: "",
  };
  const pending = pendingFromIndexSetup({ setup: longSetup, lotSize: 65, atr: 40, now: new Date("2026-10-21T10:05:00+05:30") });
  assert.ok(pending);
  assert.equal(pending!.right, "CE");
  assert.ok(pending!.premiumEntry > 0);
  assert.ok(pending!.premiumStop < pending!.premiumEntry);
  assert.ok(pending!.premiumTarget > pending!.premiumEntry);
  assert.equal(pending!.premiumSource, "estimate");

  const shortSetup: Setup = { ...longSetup, status: "short", direction: "short", entry: 22600, stop: 22650, target: 22525 };
  const put = pendingFromIndexSetup({ setup: shortSetup, lotSize: 65, atr: 40, now: new Date("2026-10-21T10:05:00+05:30") });
  assert.equal(put!.right, "PE");
});

test("option fill waits for a later bar through index entry; P&L is premium × lot", () => {
  const signal = unixFromIst(2026, 10, 21, 10, 0);
  const pending = pendingFromIndexSetup({
    setup: {
      symbol: "NIFTY",
      interval: "5m",
      status: "long",
      direction: "long",
      entry: 100,
      stop: 99,
      target: 101.5,
      riskPoints: 1,
      rMultiple: 1.5,
      signalTime: signal,
      conditions: [],
      summary: "long",
      structure: "",
    },
    lotSize: 65,
    atr: 1,
    now: new Date("2026-10-21T10:05:00+05:30"),
  })!;

  const signalBar: Candle = { time: signal, open: 99.5, high: 100, low: 99, close: 99.8, volume: 0 };
  const blocked = reduceOptionBar({ ...emptyOptionSymbol(), pending }, signalBar, {
    phase: "closed",
    setup: null,
    symbol: "NIFTY",
    interval: "5m",
    lotSize: 65,
    auto: true,
    allowEntry: true,
    allowExit: true,
    flatten: false,
    atr: 1,
    chainLtp: null,
    now: new Date("2026-10-21T10:05:00+05:30"),
  });
  assert.equal(blocked.slice.position, null);

  const fillBar: Candle = { time: signal + 300, open: 100, high: 100.4, low: 99.9, close: 100.2, volume: 0 };
  const filled = reduceOptionBar({ ...emptyOptionSymbol(), pending }, fillBar, {
    phase: "forming",
    setup: null,
    symbol: "NIFTY",
    interval: "5m",
    lotSize: 65,
    auto: true,
    allowEntry: true,
    allowExit: true,
    flatten: false,
    atr: 1,
    chainLtp: null,
    now: new Date("2026-10-21T10:10:00+05:30"),
  });
  assert.ok(filled.slice.position);
  assert.equal(filled.slice.position!.right, "CE");
  assert.ok(filled.slice.position!.premiumEntry > 0);

  const stopBar: Candle = { time: signal + 600, open: 99.5, high: 99.6, low: 98.8, close: 99, volume: 0 };
  const stopped = reduceOptionBar(filled.slice, stopBar, {
    phase: "forming",
    setup: null,
    symbol: "NIFTY",
    interval: "5m",
    lotSize: 65,
    auto: true,
    allowEntry: false,
    allowExit: true,
    flatten: false,
    atr: 1,
    chainLtp: null,
    now: new Date("2026-10-21T10:15:00+05:30"),
  });
  assert.equal(stopped.trade?.reason, "stop");
  assert.equal(stopped.trade?.pnl, Math.round((stopped.trade!.points * 65) * 100) / 100);
  assert.ok((stopped.trade?.points ?? 0) < 0);
});

test("options watch copy uses STAND ASIDE / WAITING / OPEN with premium language", () => {
  const setup: Setup = {
    symbol: "NIFTY",
    interval: "5m",
    status: "stand-aside",
    direction: null,
    entry: null,
    stop: null,
    target: null,
    riskPoints: null,
    rMultiple: null,
    signalTime: null,
    conditions: [],
    summary: "Higher-timeframe bias is neutral.",
    structure: "",
  };
  const aside = describeOptionWatch({ auto: true, position: null, pending: null, setup, markPremium: null, spot: 22600 });
  assert.equal(aside.label, "STAND ASIDE");

  const pending = pendingFromIndexSetup({
    setup: { ...setup, status: "short", direction: "short", entry: 100, stop: 101, target: 98.5, riskPoints: 1, rMultiple: 1.5, signalTime: 1, summary: "short" },
    lotSize: 30,
    atr: 1,
    now: new Date("2026-10-21T10:05:00+05:30"),
  })!;
  const waiting = describeOptionWatch({
    auto: true,
    position: null,
    pending,
    setup: { ...setup, status: "short", direction: "short", summary: "short" },
    markPremium: pending.premiumEntry + 0.4,
    spot: 100.4,
  });
  assert.equal(waiting.label, "WAITING");
  assert.match(waiting.reason, /Buy PE/);
  assert.match(waiting.reason, /trade down through/);
});
