import { round2 } from "../format.js";
import { INTERVAL_SECONDS, type Candle, type IntervalId, type Setup, type Side, type SymbolId } from "../types.js";
import { shouldSquareOffExpiry } from "./expiry.js";
import { buildContractLevels, markOption } from "./pricing.js";
import type {
  OptionPending,
  OptionPosition,
  OptionsBook,
  OptionSymbolState,
  OptionTrade,
  PremiumSource,
} from "./types.js";

function waitWindow(interval: IntervalId): number {
  return INTERVAL_SECONDS[interval] * 3;
}

function rightFromDirection(direction: Side): "CE" | "PE" {
  return direction === "long" ? "CE" : "PE";
}

function indexEntryFill(direction: Side, entry: number, bar: Candle): number | null {
  if (direction === "long") {
    if (bar.high < entry) return null;
    return bar.open > entry ? round2(bar.open) : entry;
  }
  if (bar.low > entry) return null;
  return bar.open < entry ? round2(bar.open) : entry;
}

function indexExitHit(position: OptionPosition, bar: Candle): { reason: "stop" | "target" } | null {
  // Underlying stop/target still gates the paper option (same candle stop-before-target).
  if (position.direction === "long") {
    if (bar.low <= position.indexStop) return { reason: "stop" };
    if (bar.high >= position.indexTarget) return { reason: "target" };
    return null;
  }
  if (bar.high >= position.indexStop) return { reason: "stop" };
  if (bar.low <= position.indexTarget) return { reason: "target" };
  return null;
}

function premiumAtSpot(args: {
  position: OptionPosition;
  spot: number;
  atr: number | null;
  chainLtp: number | null;
  now: Date;
}): number {
  return markOption({
    symbol: args.position.symbol,
    spot: args.spot,
    strike: args.position.strike,
    right: args.position.right,
    expiry: args.position.expiry,
    atr: args.atr,
    chainLtp: args.chainLtp,
    now: args.now,
  }).premium;
}

export function pendingFromIndexSetup(args: {
  setup: Setup;
  lotSize: number;
  atr: number | null;
  listedStrikes?: number[];
  chainLtps?: Partial<Record<number, number>>;
  now?: Date;
}): OptionPending | null {
  const { setup } = args;
  if ((setup.status !== "long" && setup.status !== "short") || setup.direction == null) return null;
  if (setup.entry == null || setup.stop == null || setup.target == null || setup.signalTime == null) return null;
  const right = rightFromDirection(setup.direction);
  const levels = buildContractLevels({
    symbol: setup.symbol,
    spot: setup.entry,
    right,
    indexEntry: setup.entry,
    indexStop: setup.stop,
    indexTarget: setup.target,
    atr: args.atr,
    listedStrikes: args.listedStrikes,
    chainLtps: args.chainLtps,
    now: args.now,
  });
  return {
    symbol: setup.symbol,
    right,
    strike: levels.strike,
    expiry: levels.expiry.expiry,
    expiryKind: levels.expiry.kind,
    direction: setup.direction,
    indexEntry: setup.entry,
    indexStop: setup.stop,
    indexTarget: setup.target,
    premiumEntry: levels.premiumEntry,
    premiumStop: levels.premiumStop,
    premiumTarget: levels.premiumTarget,
    premiumSource: levels.premiumSource,
    signalTime: setup.signalTime,
    interval: setup.interval,
    lotSize: args.lotSize,
    deltaAtArm: levels.delta,
  };
}

export interface OptionReduceInput {
  phase: "forming" | "closed";
  setup: Setup | null;
  symbol: SymbolId;
  interval: IntervalId;
  lotSize: number;
  auto: boolean;
  allowEntry: boolean;
  allowExit: boolean;
  flatten: boolean;
  flattenReason?: OptionTrade["reason"];
  atr: number | null;
  chainLtp: number | null;
  listedStrikes?: number[];
  chainLtps?: Partial<Record<number, number>>;
  now: Date;
  premiumSourceHint?: PremiumSource;
}

export function reduceOptionBar(
  slice: OptionSymbolState,
  bar: Candle,
  input: OptionReduceInput,
): { slice: OptionSymbolState; trade: OptionTrade | null } {
  const next: OptionSymbolState = {
    pending: slice.pending ? { ...slice.pending } : null,
    position: slice.position ? { ...slice.position } : null,
    seenEntry: { ...slice.seenEntry },
    seenExit: { ...slice.seenExit },
    processedClose: { ...slice.processedClose },
  };
  let trade: OptionTrade | null = null;

  const closePosition = (pos: OptionPosition, exitPremium: number, reason: OptionTrade["reason"]) => {
    const exit = round2(exitPremium);
    const points = round2(exit - pos.premiumEntry);
    const pnl = round2(points * pos.lotSize);
    trade = {
      id: `${pos.id}:${bar.time}:${reason}`,
      symbol: pos.symbol,
      right: pos.right,
      strike: pos.strike,
      expiry: pos.expiry,
      direction: pos.direction,
      premiumEntry: pos.premiumEntry,
      premiumExit: exit,
      premiumStop: pos.premiumStop,
      premiumTarget: pos.premiumTarget,
      premiumSource: pos.premiumSource,
      signalTime: pos.signalTime,
      openedAt: pos.openedAt,
      closedAt: bar.time,
      lotSize: pos.lotSize,
      points,
      pnl,
      reason,
      interval: pos.interval,
    };
    next.seenExit[`${pos.id}:${bar.time}`] = true;
    next.position = null;
  };

  if (input.allowExit && next.position && !next.seenExit[`${next.position.id}:${bar.time}`]) {
    const hit = indexExitHit(next.position, bar);
    if (hit) {
      const spot = hit.reason === "stop" ? next.position.indexStop : next.position.indexTarget;
      const exitPrem = hit.reason === "stop" ? next.position.premiumStop : next.position.premiumTarget;
      const marked = premiumAtSpot({
        position: next.position,
        spot,
        atr: input.atr,
        chainLtp: null,
        now: input.now,
      });
      // Prefer the armed premium level; fall back to mark at the index level.
      closePosition(next.position, hit.reason === "stop" || hit.reason === "target" ? exitPrem : marked, hit.reason);
    } else {
      const mark = premiumAtSpot({
        position: next.position,
        spot: bar.close,
        atr: input.atr,
        chainLtp: input.chainLtp,
        now: input.now,
      });
      if (mark <= next.position.premiumStop) closePosition(next.position, next.position.premiumStop, "stop");
      else if (mark >= next.position.premiumTarget) closePosition(next.position, next.position.premiumTarget, "target");
    }
  }

  if (input.allowEntry && input.auto && !next.position && next.pending && next.pending.interval === input.interval) {
    const pending = next.pending;
    const wait = bar.time - pending.signalTime;
    const key = String(pending.signalTime);
    if (wait > 0 && wait <= waitWindow(input.interval) && !next.seenEntry[key]) {
      const fill = indexEntryFill(pending.direction, pending.indexEntry, bar);
      if (fill != null) {
        const fillQuote = markOption({
          symbol: pending.symbol,
          spot: fill,
          strike: pending.strike,
          right: pending.right,
          expiry: pending.expiry,
          atr: input.atr,
          chainLtp: input.chainLtp,
          now: input.now,
        });
        const position: OptionPosition = {
          id: `opt:${pending.symbol}:${pending.signalTime}`,
          symbol: pending.symbol,
          right: pending.right,
          strike: pending.strike,
          expiry: pending.expiry,
          expiryKind: pending.expiryKind,
          direction: pending.direction,
          indexEntry: pending.indexEntry,
          indexStop: pending.indexStop,
          indexTarget: pending.indexTarget,
          premiumEntry: fillQuote.premium,
          premiumStop: pending.premiumStop,
          premiumTarget: pending.premiumTarget,
          premiumSource: fillQuote.source,
          signalTime: pending.signalTime,
          openedAt: bar.time,
          interval: pending.interval,
          lotSize: pending.lotSize,
          deltaAtEntry: fillQuote.delta,
        };
        next.seenEntry[key] = true;
        next.pending = null;
        next.position = position;
        if (!next.seenExit[`${position.id}:${bar.time}`]) {
          const hit = indexExitHit(position, bar);
          if (hit) {
            const exitPrem = hit.reason === "stop" ? position.premiumStop : position.premiumTarget;
            closePosition(position, exitPrem, hit.reason);
          }
        }
      }
    }
  }

  if (input.flatten && next.position) {
    const mark = premiumAtSpot({
      position: next.position,
      spot: bar.close,
      atr: input.atr,
      chainLtp: input.chainLtp,
      now: input.now,
    });
    closePosition(next.position, mark, input.flattenReason ?? "flatten");
  }

  if (input.phase === "closed" && input.allowEntry && !next.position) {
    const setup = input.setup;
    const actionable = setup != null && (setup.status === "long" || setup.status === "short") && setup.signalTime != null && !next.seenEntry[String(setup.signalTime)];
    if (input.auto && actionable && setup) {
      next.pending = pendingFromIndexSetup({
        setup,
        lotSize: input.lotSize,
        atr: input.atr,
        listedStrikes: input.listedStrikes,
        chainLtps: input.chainLtps,
        now: input.now,
      });
    } else if (!input.auto || (setup && setup.signalTime === bar.time)) {
      next.pending = null;
    }
  }

  return { slice: next, trade };
}

export interface OptionFeed {
  symbol: SymbolId;
  interval: IntervalId;
  candles: Candle[];
}

export interface OptionStepContext {
  setups: Partial<Record<SymbolId, Setup | null>>;
  atr: Partial<Record<SymbolId, number | null>>;
  chainLtp: Partial<Record<SymbolId, number | null>>;
  listedStrikes: Partial<Record<SymbolId, number[]>>;
  chainLtps: Partial<Record<SymbolId, Partial<Record<number, number>>>>;
  lots: Record<SymbolId, number>;
  auto: boolean;
  active: IntervalId;
  nowSec: number;
  now: Date;
}

function applyTrade(book: OptionsBook, trade: OptionTrade | null) {
  if (!trade) return;
  if (book.trades.some((row) => row.id === trade.id)) return;
  book.trades.push(trade);
  book.cash = round2(book.cash + trade.pnl);
}

export function stepOptions(book: OptionsBook, feeds: OptionFeed[], ctx: OptionStepContext): OptionsBook {
  const next: OptionsBook = structuredClone(book);
  if (!ctx.auto) {
    for (const symbol of ["NIFTY", "BANKNIFTY"] as SymbolId[]) next.symbols[symbol].pending = null;
  }

  for (const symbol of ["NIFTY", "BANKNIFTY"] as SymbolId[]) {
    const state = next.symbols[symbol];
    if (state.pending && state.pending.interval !== ctx.active && !state.position) state.pending = null;

    if (state.position && shouldSquareOffExpiry(state.position.expiry, ctx.now)) {
      const feed = feeds.find((item) => item.symbol === symbol && item.interval === state.position!.interval)
        ?? feeds.find((item) => item.symbol === symbol && item.interval === ctx.active)
        ?? feeds.find((item) => item.symbol === symbol);
      const bar = feed?.candles.at(-1);
      if (bar) {
        const reduced = reduceOptionBar(state, bar, {
          phase: "forming",
          setup: null,
          symbol,
          interval: state.position.interval,
          lotSize: ctx.lots[symbol],
          auto: ctx.auto,
          allowEntry: false,
          allowExit: true,
          flatten: true,
          flattenReason: "expiry",
          atr: ctx.atr[symbol] ?? null,
          chainLtp: ctx.chainLtp[symbol] ?? null,
          now: ctx.now,
        });
        Object.assign(state, {
          pending: reduced.slice.pending,
          position: reduced.slice.position,
          seenEntry: reduced.slice.seenEntry,
          seenExit: reduced.slice.seenExit,
        });
        applyTrade(next, reduced.trade);
      }
    }

    const intervals = new Set<IntervalId>([ctx.active]);
    if (state.position) intervals.add(state.position.interval);
    if (state.pending) intervals.add(state.pending.interval);

    for (const interval of intervals) {
      const feed = feeds.find((item) => item.symbol === symbol && item.interval === interval);
      if (!feed || feed.candles.length < 2) continue;
      const candles = feed.candles;
      const allowEntry = interval === ctx.active;

      if (state.processedClose[interval] == null) {
        state.processedClose[interval] = candles[candles.length - 2]?.time ?? candles[0].time;
      }

      const startFrom = state.processedClose[interval] ?? 0;
      for (let i = 0; i < candles.length; i++) {
        const bar = candles[i];
        if (bar.time <= startFrom) continue;
        const isLast = i === candles.length - 1;
        const phase: "forming" | "closed" = isLast ? "forming" : "closed";
        const reduced = reduceOptionBar(state, bar, {
          phase,
          setup: null,
          symbol,
          interval,
          lotSize: ctx.lots[symbol],
          auto: ctx.auto,
          allowEntry,
          allowExit: !state.position || state.position.interval === interval,
          flatten: false,
          atr: ctx.atr[symbol] ?? null,
          chainLtp: ctx.chainLtp[symbol] ?? null,
          listedStrikes: ctx.listedStrikes[symbol],
          chainLtps: ctx.chainLtps[symbol],
          now: ctx.now,
        });
        Object.assign(state, {
          pending: reduced.slice.pending,
          position: reduced.slice.position,
          seenEntry: reduced.slice.seenEntry,
          seenExit: reduced.slice.seenExit,
        });
        applyTrade(next, reduced.trade);
        if (phase === "closed") state.processedClose[interval] = bar.time;
      }
    }

    if (ctx.auto && !state.position) {
      const setup = ctx.setups[symbol] ?? null;
      const key = setup?.signalTime == null ? "" : String(setup.signalTime);
      if (setup && (setup.status === "long" || setup.status === "short") && key && !state.seenEntry[key]) {
        state.pending = pendingFromIndexSetup({
          setup,
          lotSize: ctx.lots[symbol],
          atr: ctx.atr[symbol] ?? null,
          listedStrikes: ctx.listedStrikes[symbol],
          chainLtps: ctx.chainLtps[symbol],
          now: ctx.now,
        });
      } else if (!setup || setup.status === "stand-aside" || setup.status === "flat" || !key || state.seenEntry[key]) {
        if (!state.pending || !setup || state.pending.signalTime !== setup.signalTime) {
          state.pending = null;
        }
        if (setup && (setup.status === "stand-aside" || setup.status === "flat")) state.pending = null;
      }
    }
  }
  return next;
}

export function flattenOption(book: OptionsBook, symbol: SymbolId, premium: number, when: number, reason: OptionTrade["reason"] = "flatten"): OptionsBook {
  const next: OptionsBook = structuredClone(book);
  const position = next.symbols[symbol].position;
  if (!position) return next;
  const exit = round2(premium);
  const points = round2(exit - position.premiumEntry);
  const pnl = round2(points * position.lotSize);
  const trade: OptionTrade = {
    id: `${position.id}:${when}:${reason}`,
    symbol,
    right: position.right,
    strike: position.strike,
    expiry: position.expiry,
    direction: position.direction,
    premiumEntry: position.premiumEntry,
    premiumExit: exit,
    premiumStop: position.premiumStop,
    premiumTarget: position.premiumTarget,
    premiumSource: position.premiumSource,
    signalTime: position.signalTime,
    openedAt: position.openedAt,
    closedAt: when,
    lotSize: position.lotSize,
    points,
    pnl,
    reason,
    interval: position.interval,
  };
  if (!next.trades.some((row) => row.id === trade.id)) {
    next.trades.push(trade);
    next.cash = round2(next.cash + pnl);
  }
  next.symbols[symbol].position = null;
  next.symbols[symbol].pending = null;
  return next;
}

export function optionUnrealized(position: OptionPosition, markPremium: number): { points: number; pnl: number } {
  const points = round2(markPremium - position.premiumEntry);
  return { points, pnl: round2(points * position.lotSize) };
}
