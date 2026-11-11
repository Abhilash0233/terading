import { px } from "./format.js";
import { SYMBOLS, type Book, type IntervalId, type PendingOrder, type Position, type Setup, type SymbolId } from "./types.js";

export interface WatchRead {
  tone: "open" | "working" | "wait" | "dropped";
  label: string;
  reason: string;
}

export function timeframeCancelNotice(
  pending: PendingOrder | null,
  position: Position | null,
  nextInterval: IntervalId,
): string | null {
  if (!pending || position) return null;
  if (pending.interval === nextInterval) return null;
  const side = pending.direction === "long" ? "long" : "short";
  return `${pending.interval} ${side} order was cancelled because execution moved to ${nextInterval}.`;
}

/** Switch execution TF and drop flat pending orders whose interval no longer matches. */
export function changeExecutionInterval(book: Book, nextInterval: IntervalId): {
  book: Book;
  drops: Partial<Record<SymbolId, string>>;
} {
  if (book.ui.interval === nextInterval) return { book, drops: {} };
  const drops: Partial<Record<SymbolId, string>> = {};
  const symbols = { ...book.symbols };
  for (const item of SYMBOLS) {
    const state = symbols[item.id];
    const note = timeframeCancelNotice(state.pending, state.position, nextInterval);
    if (!note) continue;
    drops[item.id] = note;
    symbols[item.id] = { ...state, pending: null };
  }
  return {
    book: { ...book, symbols, ui: { ...book.ui, interval: nextInterval } },
    drops,
  };
}

export function describeWatch(input: {
  auto: boolean;
  position: Position | null;
  pending: PendingOrder | null;
  setup: Setup;
  mark: number | null;
  dropped?: string | null;
}): WatchRead {
  const { auto, position, pending, setup, mark, dropped } = input;
  if (position) {
    const side = position.direction === "long" ? "Long" : "Short";
    const markText = mark == null ? "" : ` Mark ${px(mark)}.`;
    return {
      tone: "open",
      label: "OPEN",
      reason: `${side} is open from ${px(position.entry)}.${markText} Stop ${px(position.stop)}, target ${px(position.target)}. A new order waits until this one closes.`,
    };
  }
  if (!auto) {
    return {
      tone: "wait",
      label: "AUTO OFF",
      reason: "Auto is off, so no new paper order will be placed. An open position still exits if price trades through the stop or the target.",
    };
  }
  if (dropped) {
    return {
      tone: "dropped",
      label: "ORDER DROPPED",
      reason: pending
        ? `${dropped} A new ${pending.interval} order is already armed at ${px(pending.entry)}.`
        : dropped,
    };
  }
  if (pending) {
    const side = pending.direction === "long" ? "Long" : "Short";
    const touch = pending.direction === "long"
      ? `Waiting for a later candle to trade up through ${px(pending.entry)}.`
      : `Waiting for a later candle to trade down through ${px(pending.entry)}.`;
    let away = "";
    if (mark != null) {
      const gap = pending.direction === "long" ? pending.entry - mark : mark - pending.entry;
      away = gap > 0
        ? ` Last ${px(mark)} is still ${px(Math.abs(gap))} away.`
        : ` Last ${px(mark)} is at the entry. The fill prints on a candle after the signal.`;
    }
    return {
      tone: "working",
      label: "WAITING",
      reason: `${side} order is armed. ${touch}${away} Stop ${px(pending.stop)}, target ${px(pending.target)}.`,
    };
  }
  return {
    tone: "wait",
    label: setup.status === "stand-aside" ? "STAND ASIDE" : "NO ORDER",
    reason: setup.summary || "Waiting for a closed signal candle.",
  };
}
