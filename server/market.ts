import { normalizeCandles, type RawBar } from "../src/lib/candles.js";
import {
  SYMBOLS,
  type Candle,
  type CandleResponse,
  type IntervalId,
  type QuoteTick,
  type QuotesResponse,
  type SymbolId,
} from "../src/lib/types.js";

const UA = "Mozilla/5.0 (compatible; Terading/1.0; paper-trading)";

const YAHOO: Record<IntervalId, { interval: string; range: string }> = {
  "5m": { interval: "5m", range: "60d" },
  "15m": { interval: "15m", range: "60d" },
  "1h": { interval: "60m", range: "6mo" },
};

const GROWW_MINUTES: Record<IntervalId, number> = { "5m": 5, "15m": 15, "1h": 60 };

let yahooBlockedUntil = 0;
let yahooChain: Promise<unknown> = Promise.resolve();

function enqueueYahoo<T>(task: () => Promise<T>): Promise<T> {
  const run = yahooChain.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return task();
  });
  yahooChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function meta(symbol: SymbolId) {
  const found = SYMBOLS.find((item) => item.id === symbol);
  if (!found) throw new Error(`Unknown symbol ${symbol}`);
  return found;
}

export function parseYahoo(body: unknown, interval: IntervalId): Candle[] {
  const chart = (body as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }[] } }).chart;
  const result = chart?.result?.[0];
  const times = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote) return [];
  const rows: RawBar[] = times.map((time, i) => ({
    time,
    open: quote.open?.[i] ?? null,
    high: quote.high?.[i] ?? null,
    low: quote.low?.[i] ?? null,
    close: quote.close?.[i] ?? null,
    volume: quote.volume?.[i] ?? null,
  }));
  return normalizeCandles(rows, interval);
}

export function parseGroww(body: unknown, interval: IntervalId): Candle[] {
  const candles = (body as { candles?: unknown[] }).candles;
  if (!Array.isArray(candles)) return [];
  const rows: RawBar[] = [];
  for (const row of candles) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close, volume] = row as number[];
    rows.push({
      time: Number(time),
      open: typeof open === "number" ? open : null,
      high: typeof high === "number" ? high : null,
      low: typeof low === "number" ? low : null,
      close: typeof close === "number" ? close : null,
      volume: typeof volume === "number" ? volume : null,
    });
  }
  return normalizeCandles(rows, interval);
}

async function fetchYahoo(symbol: SymbolId, interval: IntervalId): Promise<Candle[]> {
  const symbolMeta = meta(symbol);
  const query = YAHOO[interval];
  let last = "empty chart";
  for (const range of [query.range, "10d"]) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolMeta.yahoo)}?interval=${query.interval}&range=${range}&includePrePost=false`;
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 429) throw new Error("HTTP 429");
    if (!response.ok) {
      last = `HTTP ${response.status}`;
      continue;
    }
    const candles = parseYahoo(await response.json(), interval);
    if (candles.length >= 30) return candles;
    last = "empty chart";
  }
  throw new Error(last);
}

async function fetchGroww(symbol: SymbolId, interval: IntervalId): Promise<Candle[]> {
  const symbolMeta = meta(symbol);
  const end = Date.now();
  const start = end - 120 * 24 * 60 * 60 * 1000;
  const url = `https://groww.in/v1/api/charting_service/v2/chart/delayed/exchange/NSE/segment/CASH/${symbolMeta.groww}?intervalInMinutes=${GROWW_MINUTES[interval]}&startTimeInMillis=${start}&endTimeInMillis=${end}`;
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const candles = parseGroww(await response.json(), interval);
  if (candles.length < 30) throw new Error("empty chart");
  return candles;
}

function pack(symbol: SymbolId, interval: IntervalId, source: "yahoo" | "groww", sourceDetail: string, candles: Candle[]): CandleResponse {
  const volumeEmpty = candles.every((candle) => candle.volume === 0);
  return {
    ok: true,
    symbol,
    interval,
    source,
    sourceDetail,
    warning: volumeEmpty ? "Index volume is empty in this feed. Session VWAP is equal-weighted." : undefined,
    candles,
    fetchedAt: Date.now(),
  };
}

export async function fetchCandles(symbol: SymbolId, interval: IntervalId): Promise<CandleResponse> {
  const errors: string[] = [];
  const symbolMeta = meta(symbol);
  if (Date.now() >= yahooBlockedUntil) {
    try {
      const candles = await enqueueYahoo(() => fetchYahoo(symbol, interval));
      return pack(symbol, interval, "yahoo", `Yahoo Finance chart ${symbolMeta.yahoo}`, candles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Yahoo: ${message}`);
      if (message.includes("429")) yahooBlockedUntil = Date.now() + 45_000;
    }
  } else {
    errors.push("Yahoo: paused after a rate limit");
  }

  try {
    const candles = await fetchGroww(symbol, interval);
    return pack(symbol, interval, "groww", `Groww delayed chart ${symbolMeta.groww} · ${errors[0] ?? "Yahoo unavailable"}`, candles);
  } catch (error) {
    errors.push(`Groww: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ok: false,
    symbol,
    interval,
    error: `Could not load ${symbolMeta.name} ${interval}. ${errors.join(" ")}`,
    fetchedAt: Date.now(),
  };
}

export function parseYahooQuote(body: unknown): number | null {
  const result = (body as {
    chart?: {
      result?: {
        meta?: { regularMarketPrice?: number | null };
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }[];
    };
  }).chart?.result?.[0];
  const live = result?.meta?.regularMarketPrice;
  if (typeof live === "number" && Number.isFinite(live) && live > 0) return live;
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  for (let i = closes.length - 1; i >= 0; i--) {
    const close = closes[i];
    if (typeof close === "number" && Number.isFinite(close) && close > 0) return close;
  }
  return null;
}

async function fetchYahooLast(symbol: SymbolId): Promise<number> {
  const symbolMeta = meta(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolMeta.yahoo)}?interval=1m&range=1d&includePrePost=false`;
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 429) throw new Error("HTTP 429");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const price = parseYahooQuote(await response.json());
  if (price == null) throw new Error("empty quote");
  return price;
}

async function fetchGrowwLast(symbol: SymbolId): Promise<number> {
  const symbolMeta = meta(symbol);
  const end = Date.now();
  const start = end - 2 * 24 * 60 * 60 * 1000;
  const url = `https://groww.in/v1/api/charting_service/v2/chart/delayed/exchange/NSE/segment/CASH/${symbolMeta.groww}?intervalInMinutes=5&startTimeInMillis=${start}&endTimeInMillis=${end}`;
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const candles = parseGroww(await response.json(), "5m");
  const last = candles.at(-1)?.close;
  if (last == null || !(last > 0)) throw new Error("empty quote");
  return last;
}

async function fetchOneQuote(symbol: SymbolId): Promise<QuoteTick> {
  const symbolMeta = meta(symbol);
  const errors: string[] = [];
  if (Date.now() >= yahooBlockedUntil) {
    try {
      const price = await enqueueYahoo(() => fetchYahooLast(symbol));
      return {
        symbol,
        price,
        source: "yahoo",
        sourceDetail: `Yahoo last ${symbolMeta.yahoo}`,
        at: Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Yahoo: ${message}`);
      if (message.includes("429")) yahooBlockedUntil = Date.now() + 45_000;
    }
  } else {
    errors.push("Yahoo: paused after a rate limit");
  }

  try {
    const price = await fetchGrowwLast(symbol);
    return {
      symbol,
      price,
      source: "groww",
      sourceDetail: `Groww delayed last ${symbolMeta.groww} · ${errors[0] ?? "Yahoo unavailable"}`,
      at: Date.now(),
    };
  } catch (error) {
    errors.push(`Groww: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(errors.join(" "));
  }
}

export async function fetchQuotes(): Promise<QuotesResponse> {
  const quotes: Partial<Record<SymbolId, QuoteTick>> = {};
  const errors: string[] = [];
  for (const item of SYMBOLS) {
    try {
      quotes[item.id] = await fetchOneQuote(item.id);
    } catch (error) {
      errors.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (Object.keys(quotes).length === 0) {
    return { ok: false, error: `Could not load last prices. ${errors.join(" ")}`, fetchedAt: Date.now() };
  }
  return { ok: true, quotes, fetchedAt: Date.now(), error: errors.length ? errors.join(" ") : undefined };
}
