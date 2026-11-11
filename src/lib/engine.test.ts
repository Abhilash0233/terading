import assert from "node:assert/strict";
import test from "node:test";
import { freshBook } from "./book";
import { normalizeCandles } from "./candles";
import { emptySlice, firstRoundTripIndex, pendingFromSetup, reduceBar, runReplay, stepLive } from "./execution";
import { atrSeries, computeIndicators, emaSeries, rsiSeries } from "./indicators";
import { evaluateSetupAt, trendBias } from "./strategy";
import { inSession, sessionState, snapBarTime, unixFromIst } from "./time";
import type { Candle, PendingOrder, Position, Setup } from "./types";
import { parseYahooQuote } from "../../server/market.js";
import { changeExecutionInterval, describeWatch, timeframeCancelNotice } from "./watch";

const START = unixFromIst(2026, 10, 21, 9, 15);

function candle(time: number, open: number, high: number, low: number, close: number, volume = 1): Candle {
  return { time, open, high, low, close, volume };
}

function path(start: number, step: number, closes: number[], volume = 1): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return candle(start + i * step, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close, volume);
  });
}

function uptrend(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 22000 + i * 12);
}

function downtrend(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 56000 - i * 18);
}

function oscillation(count: number, anchor: number): number[] {
  const closes: number[] = [];
  let price = anchor;
  for (let i = 0; i < count; i++) {
    price += i % 2 === 0 ? 4 : -4;
    closes.push(price);
  }
  return closes;
}

function armReclaim(closes: number[], side: "long" | "short"): number[] {
  const draft = path(START, 300, closes);
  const ind = computeIndicators(draft);
  const ema = ind[closes.length - 2]?.ema9 ?? closes[closes.length - 2];
  const next = closes.slice();
  if (side === "long") next[next.length - 1] = ema + 3;
  else next[next.length - 1] = ema - 3;
  return next;
}

function withReclaimBar(closes: number[], side: "long" | "short"): Candle[] {
  const tuned = armReclaim(closes, side);
  const bars = path(START, 300, tuned);
  const ind = computeIndicators(bars);
  const ema = ind[bars.length - 2]?.ema9 ?? tuned[tuned.length - 2];
  const last = bars[bars.length - 1];
  if (side === "long") {
    last.open = ema - 1;
    last.low = ema - 4;
    last.close = ema + 3;
    last.high = ema + 6;
  } else {
    last.open = ema + 1;
    last.high = ema + 4;
    last.close = ema - 3;
    last.low = ema - 6;
  }
  return bars;
}

test("IST session boundaries and weekday close", () => {
  assert.equal(sessionState(new Date(unixFromIst(2026, 10, 21, 9, 14) * 1000)).open, false);
  assert.equal(sessionState(new Date(unixFromIst(2026, 10, 21, 9, 15) * 1000)).open, true);
  assert.equal(sessionState(new Date(unixFromIst(2026, 10, 21, 15, 29) * 1000)).open, true);
  assert.equal(sessionState(new Date(unixFromIst(2026, 10, 21, 15, 30) * 1000)).open, false);
  assert.equal(sessionState(new Date(unixFromIst(2026, 10, 25, 10, 0) * 1000)).open, false);
  assert.equal(inSession(START), true);
});

test("snaps a live stamp back to the session grid", () => {
  const raw = unixFromIst(2026, 10, 21, 9, 43, 40);
  assert.equal(snapBarTime(raw, "5m"), unixFromIst(2026, 10, 21, 9, 40));
  assert.equal(snapBarTime(unixFromIst(2026, 10, 21, 9, 15), "5m"), START);
  assert.equal(snapBarTime(unixFromIst(2026, 10, 21, 9, 43, 40), "1h"), START);
  assert.equal(snapBarTime(unixFromIst(2026, 10, 21, 15, 15), "1h"), unixFromIst(2026, 10, 21, 15, 15));
});

test("drops incomplete candles instead of inventing prices", () => {
  const rows = normalizeCandles(
    [
      { time: START, open: 1, high: 2, low: 1, close: 1.5, volume: 0 },
      { time: START + 300, open: null, high: 2, low: 1, close: 1.5, volume: 10 },
      { time: START + 600, open: 2, high: 1, low: 2, close: 2, volume: 1 },
    ],
    "5m",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].close, 1.5);
  assert.equal(rows[0].volume, 0);
});

test("EMA, RSI, and ATR match hand calculations", () => {
  const ema = emaSeries([1, 2, 3, 4, 5], 3);
  assert.equal(ema[2], 2);
  assert.equal(ema[3], 3);
  assert.equal(ema[4], 4);
  const rsi = rsiSeries([10, 11, 12, 11, 11], 3);
  assert.ok(rsi[3] != null && Math.abs(rsi[3]! - (100 - 100 / 3)) < 1e-9);
  const candles = [
    candle(1, 9, 10, 8, 9),
    candle(2, 9, 11, 9, 10),
    candle(3, 10, 12, 10, 11),
    candle(4, 11, 14, 9, 12),
  ];
  const atr = atrSeries(candles, 3);
  assert.equal(atr[2], 2);
  assert.ok(atr[3] != null && Math.abs(atr[3]! - 3) < 1e-9);
});

test("session VWAP resets at the next 09:15 and ignores a zero-volume prior day", () => {
  const day1 = unixFromIst(2026, 10, 21, 9, 15);
  const day2 = unixFromIst(2026, 10, 22, 9, 15);
  const candles = [
    candle(day1, 100, 100, 100, 100, 0),
    candle(day1 + 300, 110, 110, 110, 110, 0),
    candle(day2, 200, 200, 200, 200, 0),
  ];
  const ind = computeIndicators(candles);
  assert.equal(ind[0].vwap, 100);
  assert.equal(ind[1].vwap, 105);
  assert.equal(ind[1].vwapMode, "equal-weight");
  assert.equal(ind[2].vwap, 200);
  const weighted = computeIndicators([
    candle(day1, 100, 100, 100, 100, 1),
    candle(day1 + 300, 130, 130, 130, 130, 3),
  ]);
  assert.equal(weighted[1].vwapMode, "volume");
  assert.ok(Math.abs((weighted[1].vwap ?? 0) - (100 + 130 * 3) / 4) < 1e-9);
});

test("neutral higher-timeframe bias stands aside", () => {
  assert.equal(trendBias(10, 11, 9, 8).bias, "neutral");
  const exec = withReclaimBar(oscillation(70, 23000), "long");
  const faded = downtrend(24);
  faded[22] = faded[21] + 250;
  const htf = path(START, 900, faded);
  const setup = evaluateSetupAt("NIFTY", "5m", exec, computeIndicators(exec), exec.length - 1, {
    interval: "15m",
    candles: htf,
    ind: computeIndicators(htf),
  }, false, exec[exec.length - 1].time + 300);
  assert.equal(setup.status, "stand-aside");
  assert.match(setup.summary, /Stand aside/);
});

test("long and short setups fire only inside their rules", () => {
  const longCandles = withReclaimBar(oscillation(70, 23000), "long");
  const longHtf = path(START, 900, uptrend(24));
  const longSetup = evaluateSetupAt("NIFTY", "5m", longCandles, computeIndicators(longCandles), longCandles.length - 1, {
    interval: "15m",
    candles: longHtf,
    ind: computeIndicators(longHtf),
  }, false, longCandles[longCandles.length - 1].time + 300);
  assert.equal(longSetup.status, "long", JSON.stringify(longSetup, null, 2));
  const ind = computeIndicators(longCandles);
  const atr = ind[longCandles.length - 1].atr ?? 0;
  assert.ok(longSetup.entry != null && longSetup.stop != null && longSetup.target != null);
  assert.ok(longSetup.entry - longSetup.stop >= 0.5 * atr - 0.05);
  assert.ok(longSetup.stop < longCandles[longCandles.length - 1].low);
  assert.ok((longSetup.rMultiple ?? 0) >= 1.5);

  const blocked = evaluateSetupAt("NIFTY", "5m", longCandles, ind, longCandles.length - 1, {
    interval: "15m",
    candles: longHtf,
    ind: computeIndicators(longHtf),
  }, true, longCandles[longCandles.length - 1].time + 300);
  assert.equal(blocked.status, "flat");
  assert.equal(blocked.conditions.find((c) => c.id === "flat")?.state, "fail");

  const shortCandles = withReclaimBar(oscillation(70, 55000), "short");
  const shortHtf = path(START, 900, downtrend(24));
  const shortSetup = evaluateSetupAt("BANKNIFTY", "5m", shortCandles, computeIndicators(shortCandles), shortCandles.length - 1, {
    interval: "15m",
    candles: shortHtf,
    ind: computeIndicators(shortHtf),
  }, false, shortCandles[shortCandles.length - 1].time + 300);
  assert.equal(shortSetup.status, "short", JSON.stringify(shortSetup, null, 2));
  assert.ok((shortSetup.stop ?? 0) > shortCandles[shortCandles.length - 1].high);
});

test("a candle that hits stop and target fills the stop, including on the entry bar", () => {
  const pending: PendingOrder = {
    symbol: "NIFTY",
    direction: "long",
    entry: 100,
    stop: 99,
    target: 101.5,
    signalTime: START,
    riskPoints: 1,
    rMultiple: 1.5,
    lotSize: 65,
    interval: "5m",
  };
  const both = reduceBar({ ...emptySlice(), pending }, candle(START + 300, 100, 102, 98.5, 100), {
    phase: "closed",
    setup: null,
    symbol: "NIFTY",
    interval: "5m",
    lotSize: 65,
    mode: "replay",
    auto: true,
    allowEntry: true,
    allowExit: true,
    flatten: false,
  });
  assert.equal(both.trade?.reason, "stop");
  assert.equal(both.trade?.exit, 99);
  assert.equal(both.trade?.pnl, -65);
  assert.equal(both.slice.position, null);

  const again = reduceBar(both.slice, candle(START + 300, 100, 102, 98.5, 100), {
    phase: "closed",
    setup: null,
    symbol: "NIFTY",
    interval: "5m",
    lotSize: 65,
    mode: "replay",
    auto: true,
    allowEntry: true,
    allowExit: true,
    flatten: false,
  });
  assert.equal(again.trade, null);

  const signal = reduceBar({ ...emptySlice(), pending }, candle(START, 99, 100, 98, 99.5), {
    phase: "closed",
    setup: null,
    symbol: "NIFTY",
    interval: "5m",
    lotSize: 65,
    mode: "replay",
    auto: true,
    allowEntry: true,
    allowExit: true,
    flatten: false,
  });
  assert.equal(signal.slice.position, null);
  assert.equal(signal.trade, null);

  const overnight = reduceBar({ ...emptySlice(), pending }, candle(unixFromIst(2026, 10, 22, 9, 15), 101, 103, 100.5, 102), {
    phase: "closed",
    setup: null,
    symbol: "NIFTY",
    interval: "5m",
    lotSize: 65,
    mode: "live",
    auto: true,
    allowEntry: true,
    allowExit: true,
    flatten: false,
  });
  assert.equal(overnight.slice.position, null);
});

test("target fills when the candle does not reach the stop", () => {
  const pending: PendingOrder = {
    symbol: "BANKNIFTY",
    direction: "short",
    entry: 100,
    stop: 101,
    target: 98.5,
    signalTime: START,
    riskPoints: 1,
    rMultiple: 1.5,
    lotSize: 30,
    interval: "15m",
  };
  const result = reduceBar({ ...emptySlice(), pending }, candle(START + 900, 100, 100.4, 98, 98.2), {
    phase: "closed",
    setup: null,
    symbol: "BANKNIFTY",
    interval: "15m",
    lotSize: 30,
    mode: "replay",
    auto: true,
    allowEntry: true,
    allowExit: true,
    flatten: false,
  });
  assert.equal(result.trade?.reason, "target");
  assert.equal(result.trade?.points, 1.5);
  assert.equal(result.trade?.pnl, 45);
});

test("replay walks loaded candles into one round trip and live mode does not backfill", () => {
  const candles = withReclaimBar(oscillation(70, 23000), "long");
  const htf = { interval: "15m" as const, candles: path(START, 900, uptrend(24)), ind: computeIndicators(path(START, 900, uptrend(24))) };
  const setup = evaluateSetupAt("NIFTY", "5m", candles, computeIndicators(candles), candles.length - 1, htf, false, candles[candles.length - 1].time + 300);
  assert.equal(setup.status, "long");
  const pending = pendingFromSetup(setup, 65);
  assert.ok(pending);
  const entry = pending.entry;
  const target = pending.target;
  const nextTime = candles[candles.length - 1].time + 300;
  const afterTime = nextTime + 300;
  const filled = candle(nextTime, entry - 2, target + 1, entry - 1, target);
  const walked = [...candles, filled];
  const trip = firstRoundTripIndex({
    symbol: "NIFTY",
    interval: "5m",
    candles: walked,
    htf,
    lotSize: 65,
    auto: true,
    flattenTimes: [],
  });
  assert.ok(trip != null && trip > 20);
  const frame = runReplay({
    symbol: "NIFTY",
    interval: "5m",
    candles: walked,
    htf,
    lotSize: 65,
    auto: true,
    endIndex: walked.length - 1,
    flattenTimes: [],
  });
  assert.ok(frame.trades.length >= 1);
  const round = frame.trades[0];
  assert.ok(round.entry > 0 && round.exit > 0);
  assert.ok(round.reason === "stop" || round.reason === "target");
  assert.notEqual(round.entry, round.exit);

  const forming = candle(nextTime, entry - 1, entry + 0.5, entry - 2, entry + 0.2);
  const liveCandles = [...candles, forming];
  const now = nextTime + 30;
  const book = freshBook();
  const once = stepLive(book, [{ symbol: "NIFTY", interval: "5m", candles: liveCandles }, { symbol: "NIFTY", interval: "15m", candles: htf.candles }], "5m", now);
  assert.equal(once.trades.length, 0);
  assert.equal(once.symbols.NIFTY.position?.signalTime, candles[candles.length - 1].time);
  assert.equal(once.symbols.NIFTY.position?.direction, "long");
  const twice = stepLive(once, [{ symbol: "NIFTY", interval: "5m", candles: liveCandles }, { symbol: "NIFTY", interval: "15m", candles: htf.candles }], "5m", now);
  assert.equal(twice.trades.length, 0);
  assert.equal(twice.symbols.NIFTY.position?.id, once.symbols.NIFTY.position?.id);

  const done = stepLive(twice, [{
    symbol: "NIFTY",
    interval: "5m",
    candles: [...candles, candle(nextTime, entry - 1, entry + 0.5, entry - 2, entry + 0.2), candle(afterTime, entry, target + 1, entry, target)],
  }, { symbol: "NIFTY", interval: "15m", candles: htf.candles }], "5m", afterTime + 300);
  assert.equal(done.trades.length, 1);
  assert.equal(done.trades[0].reason, "target");
  assert.equal(done.symbols.NIFTY.position, null);
  assert.ok(done.cash !== book.cash);
});

test("waiting copy says why an armed order has not filled", () => {
  const setup = { status: "short", summary: "Short setup.", conditions: [] } as unknown as Setup;
  const pending: PendingOrder = {
    symbol: "BANKNIFTY",
    direction: "short",
    entry: 100,
    stop: 101,
    target: 98.5,
    signalTime: START,
    riskPoints: 1,
    rMultiple: 1.5,
    lotSize: 30,
    interval: "5m",
  };
  const waiting = describeWatch({ auto: true, position: null, pending, setup, mark: 100.4 });
  assert.equal(waiting.label, "WAITING");
  assert.match(waiting.reason, /trade down through 100\.00/);
  assert.match(waiting.reason, /0\.40 away/);

  const aside = describeWatch({
    auto: true,
    position: null,
    pending: null,
    setup: { ...setup, status: "stand-aside", summary: "Stand aside. 15-minute bias is neutral." },
    mark: 100,
  });
  assert.equal(aside.label, "STAND ASIDE");
  assert.match(aside.reason, /neutral/);

  const position = { direction: "long", entry: 100, stop: 99, target: 101.5 } as Position;
  const open = describeWatch({ auto: true, position, pending: null, setup, mark: 100.2 });
  assert.equal(open.label, "OPEN");
  assert.match(open.reason, /waits until this one closes/);

  const note = timeframeCancelNotice(pending, null, "15m");
  assert.match(note ?? "", /5m short order was cancelled because execution moved to 15m/);
  assert.equal(timeframeCancelNotice(pending, null, "5m"), null);
  assert.equal(timeframeCancelNotice(pending, position, "15m"), null);
  const dropped = describeWatch({
    auto: true,
    position: null,
    pending: null,
    setup: { ...setup, status: "flat", summary: "No setup." },
    mark: 100,
    dropped: note,
  });
  assert.equal(dropped.label, "ORDER DROPPED");
  assert.match(dropped.reason, /execution moved to 15m/);

  const rearmed = describeWatch({
    auto: true,
    position: null,
    pending: { ...pending, interval: "15m", entry: 99.5 },
    setup: { ...setup, status: "short", summary: "Short setup." },
    mark: 100,
    dropped: note,
  });
  assert.equal(rearmed.label, "ORDER DROPPED");
  assert.match(rearmed.reason, /new 15m order is already armed at 99\.50/);

  const armed = freshBook();
  armed.symbols.BANKNIFTY.pending = pending;
  const switched = changeExecutionInterval(armed, "15m");
  assert.equal(switched.book.ui.interval, "15m");
  assert.equal(switched.book.symbols.BANKNIFTY.pending, null);
  assert.match(switched.drops.BANKNIFTY ?? "", /execution moved to 15m/);
  const same = changeExecutionInterval(armed, "5m");
  assert.equal(same.book, armed);
  assert.equal(Object.keys(same.drops).length, 0);
});

test("yahoo quote parser prefers regularMarketPrice", () => {
  assert.equal(
    parseYahooQuote({
      chart: {
        result: [{
          meta: { regularMarketPrice: 22950.25 },
          indicators: { quote: [{ close: [22940, 22945, null] }] },
        }],
      },
    }),
    22950.25,
  );
  assert.equal(
    parseYahooQuote({
      chart: {
        result: [{
          meta: {},
          indicators: { quote: [{ close: [22940, null, 22948.5] }] },
        }],
      },
    }),
    22948.5,
  );
  assert.equal(parseYahooQuote({ chart: { result: [] } }), null);
});
