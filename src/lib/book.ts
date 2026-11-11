import { freshSymbol } from "./execution.js";
import { DEFAULT_LOTS, STARTING_CASH, type Book, type IntervalId, type Mode, type SymbolId, type Trade } from "./types.js";

export function freshBook(): Book {
  return {
    startingCash: STARTING_CASH,
    cash: STARTING_CASH,
    auto: true,
    lots: { ...DEFAULT_LOTS },
    trades: [],
    symbols: { NIFTY: freshSymbol(), BANKNIFTY: freshSymbol() },
    ui: { mode: "live", symbol: "NIFTY", interval: "5m", replayTime: {}, replayFlattens: {} },
  };
}

function asSymbol(value: unknown): SymbolId {
  return value === "BANKNIFTY" ? "BANKNIFTY" : "NIFTY";
}

function asInterval(value: unknown): IntervalId {
  return value === "15m" || value === "1h" ? value : "5m";
}

function asMode(value: unknown): Mode {
  return value === "replay" ? "replay" : "live";
}

function lot(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100000, Math.max(1, Math.round(n)));
}

export function normalizeBook(raw: unknown): Book {
  const base = freshBook();
  if (!raw || typeof raw !== "object") return base;
  const body = raw as Partial<Book>;
  const oldStart = typeof body.startingCash === "number" && Number.isFinite(body.startingCash)
    ? body.startingCash
    : STARTING_CASH;
  const oldCash = typeof body.cash === "number" && Number.isFinite(body.cash) ? body.cash : oldStart;
  base.startingCash = STARTING_CASH;
  base.cash = oldStart === STARTING_CASH ? oldCash : STARTING_CASH + (oldCash - oldStart);
  base.auto = body.auto !== false;
  const lots = (body.lots ?? {}) as Partial<Record<SymbolId, number>>;
  base.lots = {
    NIFTY: lot(lots.NIFTY, DEFAULT_LOTS.NIFTY),
    BANKNIFTY: lot(lots.BANKNIFTY, DEFAULT_LOTS.BANKNIFTY),
  };
  base.trades = Array.isArray(body.trades) ? (body.trades as Trade[]) : [];
  for (const symbol of ["NIFTY", "BANKNIFTY"] as SymbolId[]) {
    const incoming = body.symbols?.[symbol];
    if (!incoming) continue;
    base.symbols[symbol] = {
      pending: incoming.pending ?? null,
      position: incoming.position ?? null,
      seenEntry: incoming.seenEntry ?? {},
      seenExit: incoming.seenExit ?? {},
      processedClose: incoming.processedClose ?? {},
    };
  }
  if (body.ui) {
    base.ui = {
      mode: asMode(body.ui.mode),
      symbol: asSymbol(body.ui.symbol),
      interval: asInterval(body.ui.interval),
      replayTime: body.ui.replayTime ?? {},
      replayFlattens: body.ui.replayFlattens ?? {},
    };
  }
  return base;
}

export function replayKey(symbol: SymbolId, interval: IntervalId): string {
  return `${symbol}|${interval}`;
}
