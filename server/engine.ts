import { stepLive, type Feed } from "../src/lib/execution.js";
import { formatBarTime, inr, px, signedPx } from "../src/lib/format.js";
import { higherInterval, inSession } from "../src/lib/time.js";
import { INTERVAL_SECONDS, SYMBOLS, type Book, type IntervalId, type SymbolId } from "../src/lib/types.js";
import { fetchTickCandles } from "./market.js";
import { readBook, writeBook } from "./store.js";

/** A trade the background bot opened or closed, ready to send as a phone notification. */
export interface TradeEvent {
  id: string;
  app: "Terading";
  kind: "open" | "close";
  title: string;
  body: string;
  url: string;
}

export interface TickResult {
  app: "Terading";
  status: "closed" | "idle" | "unchanged" | "updated" | "error";
  detail?: string;
  events: TradeEvent[];
}

const QUIET_WINDOW_SEC = 120;

const NAME: Record<SymbolId, string> = { NIFTY: "Nifty", BANKNIFTY: "Bank Nifty" };

/** Which candle series this book needs: the active timeframe, any open or pending trade's timeframe, and each one's higher timeframe. */
function wantedSeries(book: Book): { symbol: SymbolId; interval: IntervalId }[] {
  const keys = new Set<string>();
  for (const item of SYMBOLS) {
    const state = book.symbols[item.id];
    for (const interval of [book.ui.interval, state.position?.interval, state.pending?.interval]) {
      if (!interval) continue;
      keys.add(`${item.id}|${interval}`);
      const higher = higherInterval(interval);
      if (higher) keys.add(`${item.id}|${higher}`);
    }
  }
  return [...keys].map((key) => {
    const [symbol, interval] = key.split("|");
    return { symbol: symbol as SymbolId, interval: interval as IntervalId };
  });
}

/** New positions and newly closed trades between two versions of the book. */
export function tradeEvents(before: Book, after: Book): TradeEvent[] {
  const events: TradeEvent[] = [];
  for (const item of SYMBOLS) {
    const position = after.symbols[item.id].position;
    if (position?.mode !== "live") continue;
    if (before.symbols[item.id].position?.id === position.id) continue;
    events.push({
      id: `open:${position.id}`,
      app: "Terading",
      kind: "open",
      title: `${NAME[item.id]} · ${position.interval} ${position.direction.toUpperCase()} opened`,
      body: `Entry ${px(position.entry)} at ${formatBarTime(position.openedAt)} · Stop ${px(position.stop)} · Target ${px(position.target)}`,
      url: "/terading/",
    });
  }
  const known = new Set(before.trades.map((trade) => trade.id));
  for (const trade of after.trades) {
    if (trade.mode !== "live" || known.has(trade.id)) continue;
    const why = trade.reason === "target" ? "at target" : trade.reason === "stop" ? "at stop loss" : "by flatten";
    events.push({
      id: `close:${trade.id}`,
      app: "Terading",
      kind: "close",
      title: `${NAME[trade.symbol]} · ${trade.interval} ${trade.direction.toUpperCase()} closed ${why}`,
      body: `Entry ${px(trade.entry)} (${formatBarTime(trade.openedAt)}) → Exit ${px(trade.exit)} (${formatBarTime(trade.closedAt)}) · ${signedPx(trade.points)} pts · ${inr(trade.pnl)}`,
      url: "/terading/",
    });
  }
  return events;
}

/**
 * One background-bot step: load the saved book, fetch fresh candles, run the same live step the page
 * runs (stepLive), save the result and report trades that opened or closed. Skips outside market hours,
 * and skips fetching when Auto is off and nothing is open or pending.
 */
export async function runTick(nowSec = Date.now() / 1000): Promise<TickResult> {
  if (!inSession(nowSec)) return { app: "Terading", status: "closed", events: [] };
  const book = await readBook();
  const busy = SYMBOLS.some((item) => book.symbols[item.id].position || book.symbols[item.id].pending);
  if (!book.auto && !busy) return { app: "Terading", status: "idle", events: [] };
  // With nothing open or pending, a new entry can only appear when a candle on the active timeframe
  // closes, so only check in the first two minutes after each close. This keeps CPU use low.
  // Closes are measured against 15-minute boundaries at most: NSE's 1-hour candles start at 09:15,
  // so they close at :15 past the hour rather than on it.
  if (!busy && nowSec % Math.min(INTERVAL_SECONDS[book.ui.interval], 900) >= QUIET_WINDOW_SEC) {
    return { app: "Terading", status: "idle", detail: "waiting for the next candle close", events: [] };
  }

  const feeds: Feed[] = [];
  const failed: string[] = [];
  for (const series of wantedSeries(book)) {
    try {
      feeds.push({ ...series, candles: await fetchTickCandles(series.symbol, series.interval) });
    } catch (error) {
      failed.push(`${series.symbol} ${series.interval}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (feeds.length === 0) return { app: "Terading", status: "error", detail: failed.join("; "), events: [] };

  const next = stepLive(book, feeds, book.ui.interval, nowSec);
  if (JSON.stringify(next) === JSON.stringify(book)) {
    return { app: "Terading", status: "unchanged", detail: failed.join("; ") || undefined, events: [] };
  }
  await writeBook(next);
  return { app: "Terading", status: "updated", detail: failed.join("; ") || undefined, events: tradeEvents(book, next) };
}
