import { round2 } from "./format.js";
import { computeIndicators } from "./indicators.js";
import { evaluateSetupAt, type HtfInput } from "./strategy.js";
import { higherInterval, splitCandles } from "./time.js";
import { INTERVAL_SECONDS, STARTING_CASH, type Book, type Candle, type ExecSlice, type IntervalId, type Mode, type PendingOrder, type Position, type Setup, type Side, type SymbolId, type SymbolLiveState, type Trade } from "./types.js";

function intervalSecondsWait(interval: IntervalId): number {
  return INTERVAL_SECONDS[interval] * 3;
}

export function emptySlice(): ExecSlice {
  return { pending: null, position: null, seenEntry: {}, seenExit: {} };
}

export function pendingFromSetup(setup: Setup, lotSize: number): PendingOrder | null {
  if ((setup.status !== "long" && setup.status !== "short") || setup.direction == null) return null;
  if (setup.entry == null || setup.stop == null || setup.target == null || setup.signalTime == null) return null;
  if (setup.riskPoints == null || setup.rMultiple == null) return null;
  return {
    symbol: setup.symbol,
    direction: setup.direction,
    entry: setup.entry,
    stop: setup.stop,
    target: setup.target,
    signalTime: setup.signalTime,
    riskPoints: setup.riskPoints,
    rMultiple: setup.rMultiple,
    lotSize,
    interval: setup.interval,
  };
}

function entryFill(direction: Side, entry: number, bar: Candle): number | null {
  if (direction === "long") {
    if (bar.high < entry) return null;
    return bar.open > entry ? round2(bar.open) : entry;
  }
  if (bar.low > entry) return null;
  return bar.open < entry ? round2(bar.open) : entry;
}

function exitHit(position: Position, bar: Candle): { price: number; reason: "stop" | "target" } | null {
  if (position.direction === "long") {
    if (bar.low <= position.stop) {
      return { price: bar.open < position.stop ? round2(bar.open) : position.stop, reason: "stop" };
    }
    if (bar.high >= position.target) {
      return { price: bar.open > position.target ? round2(bar.open) : position.target, reason: "target" };
    }
    return null;
  }
  if (bar.high >= position.stop) {
    return { price: bar.open > position.stop ? round2(bar.open) : position.stop, reason: "stop" };
  }
  if (bar.low <= position.target) {
    return { price: bar.open < position.target ? round2(bar.open) : position.target, reason: "target" };
  }
  return null;
}

export interface ReduceInput {
  phase: "forming" | "closed";
  setup: Setup | null;
  symbol: SymbolId;
  interval: IntervalId;
  lotSize: number;
  mode: Mode;
  auto: boolean;
  allowEntry: boolean;
  allowExit: boolean;
  flatten: boolean;
}

export function reduceBar(slice: ExecSlice, bar: Candle, input: ReduceInput): { slice: ExecSlice; trade: Trade | null } {
  const next: ExecSlice = {
    pending: slice.pending ? { ...slice.pending } : null,
    position: slice.position ? { ...slice.position } : null,
    seenEntry: { ...slice.seenEntry },
    seenExit: { ...slice.seenExit },
  };
  let trade: Trade | null = null;

  const closePosition = (pos: Position, price: number, reason: Trade["reason"]) => {
    const exit = round2(price);
    const points = round2(pos.direction === "long" ? exit - pos.entry : pos.entry - exit);
    const pnl = round2(points * pos.lotSize);
    trade = {
      id: `${pos.id}:${bar.time}:${reason}`,
      symbol: pos.symbol,
      direction: pos.direction,
      entry: pos.entry,
      exit,
      stop: pos.stop,
      target: pos.target,
      signalTime: pos.signalTime,
      openedAt: pos.openedAt,
      closedAt: bar.time,
      lotSize: pos.lotSize,
      points,
      pnl,
      reason,
      interval: pos.interval,
      mode: pos.mode,
    };
    next.seenExit[`${pos.id}:${bar.time}`] = true;
    next.position = null;
  };

  if (input.allowExit && next.position && !next.seenExit[`${next.position.id}:${bar.time}`]) {
    const hit = exitHit(next.position, bar);
    if (hit) closePosition(next.position, hit.price, hit.reason);
  }

  if (input.allowEntry && input.auto && !next.position && next.pending && next.pending.interval === input.interval) {
    const pending = next.pending;
    const wait = bar.time - pending.signalTime;
    const key = String(pending.signalTime);
    if (wait > 0 && wait <= intervalSecondsWait(input.interval) && !next.seenEntry[key]) {
      const fill = entryFill(pending.direction, pending.entry, bar);
      if (fill != null) {
        const position: Position = {
          id: `${input.mode}:${input.symbol}:${pending.signalTime}`,
          symbol: input.symbol,
          direction: pending.direction,
          entry: fill,
          stop: pending.stop,
          target: pending.target,
          signalTime: pending.signalTime,
          openedAt: bar.time,
          lotSize: pending.lotSize,
          interval: pending.interval,
          mode: input.mode,
        };
        next.seenEntry[key] = true;
        next.pending = null;
        next.position = position;
        if (!next.seenExit[`${position.id}:${bar.time}`]) {
          const hit = exitHit(position, bar);
          if (hit) closePosition(position, hit.price, hit.reason);
        }
      }
    }
  }

  if (input.flatten && next.position) {
    closePosition(next.position, bar.close, "flatten");
  }

  if (input.phase === "closed" && input.allowEntry && !next.position) {
    const setup = input.setup;
    const actionable = setup != null && (setup.status === "long" || setup.status === "short") && setup.signalTime != null && !next.seenEntry[String(setup.signalTime)];
    if (input.auto && actionable && setup) {
      next.pending = pendingFromSetup(setup, input.lotSize);
    } else if (!input.auto || (setup && setup.signalTime === bar.time)) {
      next.pending = null;
    }
  }

  return { slice: next, trade };
}

export interface Feed {
  symbol: SymbolId;
  interval: IntervalId;
  candles: Candle[];
}

function applyTrade(book: Book, trade: Trade | null) {
  if (!trade) return;
  if (book.trades.some((row) => row.id === trade.id)) return;
  book.trades.push(trade);
  book.cash = round2(book.cash + trade.pnl);
}

function htfFor(feeds: Feed[], symbol: SymbolId, interval: IntervalId): HtfInput | null {
  const higher = higherInterval(interval);
  if (!higher) return null;
  const feed = feeds.find((item) => item.symbol === symbol && item.interval === higher);
  if (!feed || feed.candles.length === 0) return null;
  return { interval: higher, candles: feed.candles, ind: computeIndicators(feed.candles) };
}

export function stepLive(book: Book, feeds: Feed[], active: IntervalId, nowSec: number): Book {
  const next: Book = structuredClone(book);
  if (!next.auto) {
    for (const symbol of ["NIFTY", "BANKNIFTY"] as SymbolId[]) next.symbols[symbol].pending = null;
  }

  for (const symbol of ["NIFTY", "BANKNIFTY"] as SymbolId[]) {
    const state = next.symbols[symbol];
    if (state.pending && state.pending.interval !== active && !state.position) state.pending = null;
    const intervals = new Set<IntervalId>([active]);
    if (state.position) intervals.add(state.position.interval);
    if (state.pending) intervals.add(state.pending.interval);
    const ordered = [...intervals].sort((a, b) => {
      if (state.position?.interval === a) return -1;
      if (state.position?.interval === b) return 1;
      return 0;
    });

    for (const interval of ordered) {
      const feed = feeds.find((item) => item.symbol === symbol && item.interval === interval);
      if (!feed || feed.candles.length < 2) continue;
      const candles = feed.candles;
      const ind = computeIndicators(candles);
      const htf = htfFor(feeds, symbol, interval);
      const { lastClosed, forming } = splitCandles(candles.map((c) => c.time), interval, nowSec);
      const allowEntry = interval === active;
      const seeded = state.processedClose[interval] == null;
      if (seeded) {
        state.processedClose[interval] = lastClosed >= 0 ? candles[lastClosed].time : 0;
        if (allowEntry && next.auto && !state.position && lastClosed >= 0) {
          const setup = evaluateSetupAt(
            symbol,
            interval,
            candles,
            ind,
            lastClosed,
            htf,
            false,
            candles[lastClosed].time + INTERVAL_SECONDS[interval],
          );
          const key = setup.signalTime == null ? "" : String(setup.signalTime);
          if ((setup.status === "long" || setup.status === "short") && key && !state.seenEntry[key]) {
            state.pending = pendingFromSetup(setup, next.lots[symbol]);
          }
        }
      }

      const applyIndex = (index: number, phase: "forming" | "closed") => {
        const bar = candles[index];
        const allowExit = !state.position || state.position.interval === interval;
        const setup = phase === "closed" && allowEntry
          ? evaluateSetupAt(symbol, interval, candles, ind, index, htf, Boolean(state.position), bar.time + INTERVAL_SECONDS[interval])
          : null;
        const reduced = reduceBar(state, bar, {
          phase,
          setup,
          symbol,
          interval,
          lotSize: next.lots[symbol],
          mode: "live",
          auto: next.auto,
          allowEntry,
          allowExit,
          flatten: false,
        });
        state.pending = reduced.slice.pending;
        state.position = reduced.slice.position;
        state.seenEntry = reduced.slice.seenEntry;
        state.seenExit = reduced.slice.seenExit;
        applyTrade(next, reduced.trade);
        if (phase === "closed") state.processedClose[interval] = bar.time;
      };

      for (let i = 0; i <= lastClosed; i++) {
        if (candles[i].time <= (state.processedClose[interval] ?? 0)) continue;
        applyIndex(i, "closed");
      }
      if (forming >= 0 && candles[forming].time > (state.processedClose[interval] ?? 0)) {
        applyIndex(forming, "forming");
      }

      if (allowEntry && next.auto && !state.position && lastClosed >= 0) {
        const setup = evaluateSetupAt(symbol, interval, candles, ind, lastClosed, htf, false, candles[lastClosed].time + INTERVAL_SECONDS[interval]);
        const key = setup.signalTime == null ? "" : String(setup.signalTime);
        if ((setup.status === "long" || setup.status === "short") && key && !state.seenEntry[key]) {
          state.pending = pendingFromSetup(setup, next.lots[symbol]);
        } else if (!state.pending || state.pending.signalTime !== setup.signalTime) {
          state.pending = null;
        }
      }
    }
  }
  return next;
}

export interface ReplaySnap {
  time: number;
  setup: Setup;
  pending: PendingOrder | null;
  position: Position | null;
  tradeCount: number;
  cash: number;
}

export interface ReplayBuild {
  snaps: ReplaySnap[];
  trades: Trade[];
}

export function buildReplay(args: {
  symbol: SymbolId;
  interval: IntervalId;
  candles: Candle[];
  htf: HtfInput | null;
  lotSize: number;
  auto: boolean;
  flattenTimes: number[];
}): ReplayBuild {
  const ind = computeIndicators(args.candles);
  let slice = emptySlice();
  const trades: Trade[] = [];
  const snaps: ReplaySnap[] = [];
  let cash = STARTING_CASH;
  for (let i = 0; i < args.candles.length; i++) {
    const bar = args.candles[i];
    const setup = evaluateSetupAt(
      args.symbol,
      args.interval,
      args.candles,
      ind,
      i,
      args.htf,
      Boolean(slice.position),
      bar.time + INTERVAL_SECONDS[args.interval],
    );
    const reduced = reduceBar(slice, bar, {
      phase: "closed",
      setup,
      symbol: args.symbol,
      interval: args.interval,
      lotSize: args.lotSize,
      mode: "replay",
      auto: args.auto,
      allowEntry: true,
      allowExit: true,
      flatten: args.flattenTimes.includes(bar.time),
    });
    slice = reduced.slice;
    const trade = reduced.trade;
    if (trade && !trades.some((row) => row.id === trade.id)) {
      trades.push(trade);
      cash = round2(cash + trade.pnl);
    }
    snaps.push({
      time: bar.time,
      setup,
      pending: slice.pending,
      position: slice.position,
      tradeCount: trades.length,
      cash,
    });
  }
  return { snaps, trades };
}

export interface ReplayFrame extends ReplaySnap {
  trades: Trade[];
}

export function runReplay(args: {
  symbol: SymbolId;
  interval: IntervalId;
  candles: Candle[];
  htf: HtfInput | null;
  lotSize: number;
  auto: boolean;
  endIndex: number;
  flattenTimes: number[];
}): ReplayFrame {
  const built = buildReplay(args);
  const index = Math.min(Math.max(args.endIndex, 0), built.snaps.length - 1);
  const snap = built.snaps[index];
  if (!snap) {
    return {
      time: 0,
      setup: evaluateSetupAt(args.symbol, args.interval, [], [], -1, null, false, 0),
      pending: null,
      position: null,
      tradeCount: 0,
      trades: [],
      cash: STARTING_CASH,
    };
  }
  return { ...snap, trades: built.trades.slice(0, snap.tradeCount) };
}

export function firstRoundTripIndex(args: Omit<Parameters<typeof runReplay>[0], "endIndex">): number | null {
  const done = runReplay({ ...args, endIndex: args.candles.length - 1 });
  if (done.trades.length === 0) return null;
  const exitTime = done.trades[0].closedAt;
  const index = args.candles.findIndex((candle) => candle.time === exitTime);
  return index >= 0 ? index : null;
}

export function flattenLive(book: Book, symbol: SymbolId, price: number, when: number): Book {
  const next: Book = structuredClone(book);
  const position = next.symbols[symbol].position;
  if (!position || position.mode !== "live") return next;
  const exit = round2(price);
  const points = round2(position.direction === "long" ? exit - position.entry : position.entry - exit);
  const pnl = round2(points * position.lotSize);
  const trade: Trade = {
    id: `${position.id}:${when}:flatten`,
    symbol,
    direction: position.direction,
    entry: position.entry,
    exit,
    stop: position.stop,
    target: position.target,
    signalTime: position.signalTime,
    openedAt: position.openedAt,
    closedAt: when,
    lotSize: position.lotSize,
    points,
    pnl,
    reason: "flatten",
    interval: position.interval,
    mode: "live",
  };
  if (!next.trades.some((row) => row.id === trade.id)) {
    next.trades.push(trade);
    next.cash = round2(next.cash + pnl);
  }
  next.symbols[symbol].position = null;
  next.symbols[symbol].pending = null;
  return next;
}

export function unrealized(position: Position, last: number): { points: number; pnl: number } {
  const points = round2(position.direction === "long" ? last - position.entry : position.entry - last);
  return { points, pnl: round2(points * position.lotSize) };
}

export function freshSymbol(): SymbolLiveState {
  return { pending: null, position: null, seenEntry: {}, seenExit: {}, processedClose: {} };
}
