import { STARTING_CASH, type SymbolId } from "../types.js";
import type { OptionsBook, OptionSymbolState, OptionTrade } from "./types.js";

export function emptyOptionSymbol(): OptionSymbolState {
  return { pending: null, position: null, seenEntry: {}, seenExit: {}, processedClose: {} };
}

export function freshOptionsBook(): OptionsBook {
  return {
    startingCash: STARTING_CASH,
    cash: STARTING_CASH,
    trades: [],
    symbols: { NIFTY: emptyOptionSymbol(), BANKNIFTY: emptyOptionSymbol() },
  };
}

export function normalizeOptionsBook(raw: unknown): OptionsBook {
  const base = freshOptionsBook();
  if (!raw || typeof raw !== "object") return base;
  const body = raw as Partial<OptionsBook>;
  const oldStart = typeof body.startingCash === "number" && Number.isFinite(body.startingCash)
    ? body.startingCash
    : STARTING_CASH;
  const oldCash = typeof body.cash === "number" && Number.isFinite(body.cash) ? body.cash : oldStart;
  base.startingCash = STARTING_CASH;
  base.cash = oldStart === STARTING_CASH ? oldCash : STARTING_CASH + (oldCash - oldStart);
  base.trades = Array.isArray(body.trades) ? (body.trades as OptionTrade[]) : [];
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
  return base;
}
