// netlify/function-entry.ts
import serverless from "serverless-http";

// server/app.ts
import express from "express";

// src/lib/types.ts
var SYMBOLS = [
  { id: "NIFTY", name: "Nifty 50", yahoo: "^NSEI", groww: "NIFTY" },
  { id: "BANKNIFTY", name: "Bank Nifty", yahoo: "^NSEBANK", groww: "BANKNIFTY" }
];
var INTERVAL_SECONDS = {
  "5m": 300,
  "15m": 900,
  "1h": 3600
};
var STARTING_CASH = 1e5;
var DEFAULT_LOTS = {
  NIFTY: 65,
  BANKNIFTY: 30
};

// src/lib/time.ts
var IST_OFFSET_SEC = 19800;
function unixFromIst(y, m, d, hh, mm, ss = 0) {
  return Math.round(Date.UTC(y, m - 1, d, hh, mm, ss) / 1e3 - IST_OFFSET_SEC);
}
function istParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  const hour = Number(bag.hour);
  return {
    weekday: bag.weekday ?? "",
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    dateKey: `${bag.year}-${bag.month}-${bag.day}`
  };
}
function snapBarTime(unixSec, interval) {
  const step = INTERVAL_SECONDS[interval];
  const sessionStart = 9 * 3600 + 15 * 60;
  const ist = unixSec + IST_OFFSET_SEC;
  const day = Math.floor(ist / 86400);
  const sod = ist - day * 86400;
  const rel = sod - sessionStart;
  const steps = Math.floor(rel / step);
  const snappedSod = sessionStart + steps * step;
  return day * 86400 + snappedSod - IST_OFFSET_SEC;
}

// src/lib/candles.ts
function normalizeCandles(rows, interval) {
  const mapped = [];
  for (const row of rows) {
    if (row.time == null || !Number.isFinite(row.time)) continue;
    const open = row.open;
    const high = row.high;
    const low = row.low;
    const close = row.close;
    if (open == null || high == null || low == null || close == null) continue;
    if (![open, high, low, close].every((n) => Number.isFinite(n))) continue;
    if (high < low || open <= 0 || close <= 0) continue;
    const unix = row.time > 1e12 ? Math.floor(row.time / 1e3) : Math.floor(row.time);
    const volume = row.volume != null && Number.isFinite(row.volume) && row.volume > 0 ? row.volume : 0;
    mapped.push({
      time: snapBarTime(unix, interval),
      open,
      high,
      low,
      close,
      volume
    });
  }
  mapped.sort((a, b) => a.time - b.time);
  const deduped = [];
  for (const bar of mapped) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.time === bar.time) deduped[deduped.length - 1] = bar;
    else deduped.push(bar);
  }
  return deduped;
}

// server/market.ts
var UA = "Mozilla/5.0 (compatible; Terading/1.0; paper-trading)";
var YAHOO = {
  "5m": { interval: "5m", range: "60d" },
  "15m": { interval: "15m", range: "60d" },
  "1h": { interval: "60m", range: "6mo" }
};
var GROWW_MINUTES = { "5m": 5, "15m": 15, "1h": 60 };
var yahooBlockedUntil = 0;
var yahooChain = Promise.resolve();
function enqueueYahoo(task) {
  const run = yahooChain.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return task();
  });
  yahooChain = run.then(
    () => void 0,
    () => void 0
  );
  return run;
}
function meta(symbol) {
  const found = SYMBOLS.find((item) => item.id === symbol);
  if (!found) throw new Error(`Unknown symbol ${symbol}`);
  return found;
}
function parseYahoo(body, interval) {
  const chart = body.chart;
  const result = chart?.result?.[0];
  const times = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote) return [];
  const rows = times.map((time, i) => ({
    time,
    open: quote.open?.[i] ?? null,
    high: quote.high?.[i] ?? null,
    low: quote.low?.[i] ?? null,
    close: quote.close?.[i] ?? null,
    volume: quote.volume?.[i] ?? null
  }));
  return normalizeCandles(rows, interval);
}
function parseGroww(body, interval) {
  const candles = body.candles;
  if (!Array.isArray(candles)) return [];
  const rows = [];
  for (const row of candles) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close, volume] = row;
    rows.push({
      time: Number(time),
      open: typeof open === "number" ? open : null,
      high: typeof high === "number" ? high : null,
      low: typeof low === "number" ? low : null,
      close: typeof close === "number" ? close : null,
      volume: typeof volume === "number" ? volume : null
    });
  }
  return normalizeCandles(rows, interval);
}
async function fetchYahoo(symbol, interval) {
  const symbolMeta = meta(symbol);
  const query = YAHOO[interval];
  let last = "empty chart";
  for (const range of [query.range, "10d"]) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolMeta.yahoo)}?interval=${query.interval}&range=${range}&includePrePost=false`;
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12e3)
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
async function fetchGroww(symbol, interval) {
  const symbolMeta = meta(symbol);
  const end = Date.now();
  const start = end - 120 * 24 * 60 * 60 * 1e3;
  const url = `https://groww.in/v1/api/charting_service/v2/chart/delayed/exchange/NSE/segment/CASH/${symbolMeta.groww}?intervalInMinutes=${GROWW_MINUTES[interval]}&startTimeInMillis=${start}&endTimeInMillis=${end}`;
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(12e3)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const candles = parseGroww(await response.json(), interval);
  if (candles.length < 30) throw new Error("empty chart");
  return candles;
}
function pack(symbol, interval, source, sourceDetail, candles) {
  const volumeEmpty = candles.every((candle) => candle.volume === 0);
  return {
    ok: true,
    symbol,
    interval,
    source,
    sourceDetail,
    warning: volumeEmpty ? "Index volume is empty in this feed. Session VWAP is equal-weighted." : void 0,
    candles,
    fetchedAt: Date.now()
  };
}
async function fetchCandles(symbol, interval) {
  const errors = [];
  const symbolMeta = meta(symbol);
  if (Date.now() >= yahooBlockedUntil) {
    try {
      const candles = await enqueueYahoo(() => fetchYahoo(symbol, interval));
      return pack(symbol, interval, "yahoo", `Yahoo Finance chart ${symbolMeta.yahoo}`, candles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Yahoo: ${message}`);
      if (message.includes("429")) yahooBlockedUntil = Date.now() + 45e3;
    }
  } else {
    errors.push("Yahoo: paused after a rate limit");
  }
  try {
    const candles = await fetchGroww(symbol, interval);
    return pack(symbol, interval, "groww", `Groww delayed chart ${symbolMeta.groww} \xB7 ${errors[0] ?? "Yahoo unavailable"}`, candles);
  } catch (error) {
    errors.push(`Groww: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ok: false,
    symbol,
    interval,
    error: `Could not load ${symbolMeta.name} ${interval}. ${errors.join(" ")}`,
    fetchedAt: Date.now()
  };
}
function parseYahooQuote(body) {
  const result = body.chart?.result?.[0];
  const live = result?.meta?.regularMarketPrice;
  if (typeof live === "number" && Number.isFinite(live) && live > 0) return live;
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  for (let i = closes.length - 1; i >= 0; i--) {
    const close = closes[i];
    if (typeof close === "number" && Number.isFinite(close) && close > 0) return close;
  }
  return null;
}
async function fetchYahooLast(symbol) {
  const symbolMeta = meta(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolMeta.yahoo)}?interval=1m&range=1d&includePrePost=false`;
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8e3)
  });
  if (response.status === 429) throw new Error("HTTP 429");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const price = parseYahooQuote(await response.json());
  if (price == null) throw new Error("empty quote");
  return price;
}
async function fetchGrowwLast(symbol) {
  const symbolMeta = meta(symbol);
  const end = Date.now();
  const start = end - 2 * 24 * 60 * 60 * 1e3;
  const url = `https://groww.in/v1/api/charting_service/v2/chart/delayed/exchange/NSE/segment/CASH/${symbolMeta.groww}?intervalInMinutes=5&startTimeInMillis=${start}&endTimeInMillis=${end}`;
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8e3)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const candles = parseGroww(await response.json(), "5m");
  const last = candles.at(-1)?.close;
  if (last == null || !(last > 0)) throw new Error("empty quote");
  return last;
}
async function fetchOneQuote(symbol) {
  const symbolMeta = meta(symbol);
  const errors = [];
  if (Date.now() >= yahooBlockedUntil) {
    try {
      const price = await enqueueYahoo(() => fetchYahooLast(symbol));
      return {
        symbol,
        price,
        source: "yahoo",
        sourceDetail: `Yahoo last ${symbolMeta.yahoo}`,
        at: Date.now()
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Yahoo: ${message}`);
      if (message.includes("429")) yahooBlockedUntil = Date.now() + 45e3;
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
      sourceDetail: `Groww delayed last ${symbolMeta.groww} \xB7 ${errors[0] ?? "Yahoo unavailable"}`,
      at: Date.now()
    };
  } catch (error) {
    errors.push(`Groww: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(errors.join(" "));
  }
}
async function fetchQuotes() {
  const quotes = {};
  const errors = [];
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
  return { ok: true, quotes, fetchedAt: Date.now(), error: errors.length ? errors.join(" ") : void 0 };
}

// src/lib/options/expiry.ts
var NSE_HOLIDAYS_2026 = /* @__PURE__ */ new Set([
  "2026-01-26",
  "2026-03-03",
  "2026-03-26",
  "2026-03-31",
  "2026-04-03",
  "2026-04-14",
  "2026-05-01",
  "2026-05-28",
  "2026-09-14",
  "2026-10-02",
  "2026-10-20",
  "2026-11-08",
  "2026-11-24",
  // Prakash Gurpurb — Nov monthly moves to Mon 23 Nov
  "2026-12-25"
]);
function ymd(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function parseYmd(key) {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}
function addDays(key, delta) {
  const { y, m, d } = parseYmd(key);
  const utc = Date.UTC(y, m - 1, d) + delta * 864e5;
  const date = new Date(utc);
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}
function weekdayOf(key) {
  const { y, m, d } = parseYmd(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function isWeekend(key) {
  const day = weekdayOf(key);
  return day === 0 || day === 6;
}
function isHoliday(key) {
  return NSE_HOLIDAYS_2026.has(key) || isWeekend(key);
}
function priorTradingDay(key) {
  let cursor = key;
  while (isHoliday(cursor)) cursor = addDays(cursor, -1);
  return cursor;
}
function lastTuesdayOfMonth(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let key = ymd(year, month, lastDay);
  while (weekdayOf(key) !== 2) key = addDays(key, -1);
  return priorTradingDay(key);
}
function nextTuesdayOnOrAfter(key) {
  let cursor = key;
  while (weekdayOf(cursor) !== 2) cursor = addDays(cursor, 1);
  return priorTradingDay(cursor);
}
function nearestExpiry(symbol, now = /* @__PURE__ */ new Date()) {
  const parts = istParts(now);
  const today = parts.dateKey;
  const sessionEnd = unixFromIst(parts.year, parts.month, parts.day, 15, 30);
  if (symbol === "NIFTY") {
    let candidate2 = nextTuesdayOnOrAfter(today);
    if (candidate2 === today && Math.floor(now.getTime() / 1e3) >= sessionEnd) {
      candidate2 = nextTuesdayOnOrAfter(addDays(today, 1));
    }
    const monthly = lastTuesdayOfMonth(parts.year, parts.month);
    const kind = candidate2 === monthly ? "monthly" : "weekly";
    const daysLeft2 = Math.max(0, Math.round((Date.parse(`${candidate2}T00:00:00+05:30`) - Date.parse(`${today}T00:00:00+05:30`)) / 864e5));
    return {
      expiry: candidate2,
      kind,
      daysLeft: daysLeft2,
      label: kind === "weekly" ? "Nifty weekly (Tuesday)" : "Nifty monthly (last Tuesday)"
    };
  }
  let year = parts.year;
  let month = parts.month;
  let candidate = lastTuesdayOfMonth(year, month);
  if (candidate < today || candidate === today && Math.floor(now.getTime() / 1e3) >= sessionEnd) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    candidate = lastTuesdayOfMonth(year, month);
  }
  const daysLeft = Math.max(0, Math.round((Date.parse(`${candidate}T00:00:00+05:30`) - Date.parse(`${today}T00:00:00+05:30`)) / 864e5));
  return {
    expiry: candidate,
    kind: "monthly",
    daysLeft,
    label: "Bank Nifty monthly (last Tuesday)"
  };
}

// server/options.ts
var UA2 = "Mozilla/5.0 (compatible; Terading/1.0; paper-trading)";
async function tryNse(symbol) {
  const ticker = symbol === "NIFTY" ? "NIFTY" : "BANKNIFTY";
  const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${ticker}`;
  try {
    const warm = await fetch("https://www.nseindia.com/option-chain", {
      headers: { "User-Agent": UA2, Accept: "text/html" },
      signal: AbortSignal.timeout(6e3)
    });
    const cookie = warm.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ") ?? warm.headers.get("set-cookie")?.split(",").map((c) => c.split(";")[0].trim()).join("; ") ?? "";
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA2,
        Accept: "application/json",
        Referer: "https://www.nseindia.com/option-chain",
        ...cookie ? { Cookie: cookie } : {}
      },
      signal: AbortSignal.timeout(8e3)
    });
    if (!response.ok) return null;
    const body = await response.json();
    const expiryRaw = body.records?.expiryDates?.[0];
    if (!expiryRaw || !body.records?.data?.length) return null;
    const expiry = normalizeNseDate(expiryRaw);
    const contracts = [];
    for (const row of body.records.data) {
      if (normalizeNseDate(row.expiryDate) !== expiry) continue;
      if (row.CE?.lastPrice != null && row.CE.lastPrice > 0) {
        contracts.push({ strike: row.strikePrice, right: "CE", expiry, ltp: row.CE.lastPrice });
      }
      if (row.PE?.lastPrice != null && row.PE.lastPrice > 0) {
        contracts.push({ strike: row.strikePrice, right: "PE", expiry, ltp: row.PE.lastPrice });
      }
    }
    if (contracts.length === 0) return null;
    return { contracts, expiry, detail: "NSE option-chain-indices" };
  } catch {
    return null;
  }
}
async function tryGroww(symbol) {
  const ticker = symbol === "NIFTY" ? "NIFTY" : "BANKNIFTY";
  const urls = [
    `https://groww.in/v1/api/stocks_fo_data/v1/option_chain_with_ltp?underlying=${ticker}&exchange=NSE`,
    `https://groww.in/v1/api/option_chain_api/v1/option_chain/exchange/NSE/${ticker.toLowerCase()}`
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": UA2, Accept: "application/json" },
        signal: AbortSignal.timeout(8e3)
      });
      if (!response.ok) continue;
      const body = await response.json();
      const parsed = parseGrowwChain(body, nearestExpiry(symbol).expiry);
      if (parsed) return { ...parsed, detail: `Groww ${url}` };
    } catch {
    }
  }
  return null;
}
function parseGrowwChain(body, fallbackExpiry) {
  const rows = body.optionChain ?? body.data ?? body.chains ?? body;
  if (!Array.isArray(rows)) return null;
  const contracts = [];
  let expiry = fallbackExpiry;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row;
    const strike = Number(item.strikePrice ?? item.strike ?? item.strike_price);
    if (!Number.isFinite(strike)) continue;
    const exp = String(item.expiry ?? item.expiryDate ?? item.expiry_date ?? fallbackExpiry);
    expiry = normalizeLooseDate(exp) || fallbackExpiry;
    const ce = Number(item.CE?.ltp ?? item.ceLtp ?? item.call_ltp);
    const pe = Number(item.PE?.ltp ?? item.peLtp ?? item.put_ltp);
    if (Number.isFinite(ce) && ce > 0) contracts.push({ strike, right: "CE", expiry, ltp: ce });
    if (Number.isFinite(pe) && pe > 0) contracts.push({ strike, right: "PE", expiry, ltp: pe });
  }
  if (contracts.length === 0) return null;
  return { contracts, expiry };
}
function normalizeNseDate(raw) {
  const m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return normalizeLooseDate(raw);
  const months = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12"
  };
  const mm = months[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()];
  if (!mm) return raw;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}
function normalizeLooseDate(raw) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
async function fetchOptionChain(symbol) {
  const fetchedAt = Date.now();
  const planned = nearestExpiry(symbol);
  const nse = await tryNse(symbol);
  if (nse) {
    return {
      ok: true,
      symbol,
      source: "nse",
      sourceDetail: nse.detail,
      expiry: nse.expiry,
      expiryKind: nse.expiry === planned.expiry ? planned.kind : planned.kind,
      contracts: nse.contracts,
      fetchedAt
    };
  }
  const groww = await tryGroww(symbol);
  if (groww) {
    return {
      ok: true,
      symbol,
      source: "groww",
      sourceDetail: groww.detail,
      expiry: groww.expiry,
      expiryKind: planned.kind,
      contracts: groww.contracts,
      fetchedAt
    };
  }
  return {
    ok: false,
    symbol,
    expiry: planned.expiry,
    expiryKind: planned.kind,
    error: "No public option-chain quote loaded. Premiums below are modeled estimates, not exchange LTP.",
    fetchedAt
  };
}

// server/store.ts
import fs from "node:fs";
import path from "node:path";

// src/lib/execution.ts
function freshSymbol() {
  return { pending: null, position: null, seenEntry: {}, seenExit: {}, processedClose: {} };
}

// src/lib/book.ts
function freshBook() {
  return {
    startingCash: STARTING_CASH,
    cash: STARTING_CASH,
    auto: true,
    lots: { ...DEFAULT_LOTS },
    trades: [],
    symbols: { NIFTY: freshSymbol(), BANKNIFTY: freshSymbol() },
    ui: { mode: "live", symbol: "NIFTY", interval: "5m", replayTime: {}, replayFlattens: {} }
  };
}
function asSymbol(value) {
  return value === "BANKNIFTY" ? "BANKNIFTY" : "NIFTY";
}
function asInterval(value) {
  return value === "15m" || value === "1h" ? value : "5m";
}
function asMode(value) {
  return value === "replay" ? "replay" : "live";
}
function lot(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1e5, Math.max(1, Math.round(n)));
}
function normalizeBook(raw) {
  const base = freshBook();
  if (!raw || typeof raw !== "object") return base;
  const body = raw;
  const oldStart = typeof body.startingCash === "number" && Number.isFinite(body.startingCash) ? body.startingCash : STARTING_CASH;
  const oldCash = typeof body.cash === "number" && Number.isFinite(body.cash) ? body.cash : oldStart;
  base.startingCash = STARTING_CASH;
  base.cash = oldStart === STARTING_CASH ? oldCash : STARTING_CASH + (oldCash - oldStart);
  base.auto = body.auto !== false;
  const lots = body.lots ?? {};
  base.lots = {
    NIFTY: lot(lots.NIFTY, DEFAULT_LOTS.NIFTY),
    BANKNIFTY: lot(lots.BANKNIFTY, DEFAULT_LOTS.BANKNIFTY)
  };
  base.trades = Array.isArray(body.trades) ? body.trades : [];
  for (const symbol of ["NIFTY", "BANKNIFTY"]) {
    const incoming = body.symbols?.[symbol];
    if (!incoming) continue;
    base.symbols[symbol] = {
      pending: incoming.pending ?? null,
      position: incoming.position ?? null,
      seenEntry: incoming.seenEntry ?? {},
      seenExit: incoming.seenExit ?? {},
      processedClose: incoming.processedClose ?? {}
    };
  }
  if (body.ui) {
    base.ui = {
      mode: asMode(body.ui.mode),
      symbol: asSymbol(body.ui.symbol),
      interval: asInterval(body.ui.interval),
      replayTime: body.ui.replayTime ?? {},
      replayFlattens: body.ui.replayFlattens ?? {}
    };
  }
  return base;
}

// src/lib/options/book.ts
function emptyOptionSymbol() {
  return { pending: null, position: null, seenEntry: {}, seenExit: {}, processedClose: {} };
}
function freshOptionsBook() {
  return {
    startingCash: STARTING_CASH,
    cash: STARTING_CASH,
    trades: [],
    symbols: { NIFTY: emptyOptionSymbol(), BANKNIFTY: emptyOptionSymbol() }
  };
}
function normalizeOptionsBook(raw) {
  const base = freshOptionsBook();
  if (!raw || typeof raw !== "object") return base;
  const body = raw;
  const oldStart = typeof body.startingCash === "number" && Number.isFinite(body.startingCash) ? body.startingCash : STARTING_CASH;
  const oldCash = typeof body.cash === "number" && Number.isFinite(body.cash) ? body.cash : oldStart;
  base.startingCash = STARTING_CASH;
  base.cash = oldStart === STARTING_CASH ? oldCash : STARTING_CASH + (oldCash - oldStart);
  base.trades = Array.isArray(body.trades) ? body.trades : [];
  for (const symbol of ["NIFTY", "BANKNIFTY"]) {
    const incoming = body.symbols?.[symbol];
    if (!incoming) continue;
    base.symbols[symbol] = {
      pending: incoming.pending ?? null,
      position: incoming.position ?? null,
      seenEntry: incoming.seenEntry ?? {},
      seenExit: incoming.seenExit ?? {},
      processedClose: incoming.processedClose ?? {}
    };
  }
  return base;
}

// server/store.ts
var hosted = Boolean(process.env.VERCEL || process.env.NETLIFY);
var root = hosted ? path.join("/tmp", "terading") : path.resolve(process.cwd(), "data");
function remoteConfigured() {
  return Boolean(process.env.BOOK_URL && process.env.BOOK_SECRET);
}
function requireStore() {
  if (hosted && !remoteConfigured()) {
    throw new Error("Supabase book store is not configured.");
  }
}
function fileFor(id) {
  return path.join(root, id === "live" ? "book.json" : "options-book.json");
}
function remoteUrl(id) {
  const base = process.env.BOOK_URL;
  const join = base.includes("?") ? "&" : "?";
  return `${base}${join}id=${id}`;
}
async function remoteReadRaw(id) {
  const res = await fetch(remoteUrl(id), {
    headers: { "x-terading-secret": process.env.BOOK_SECRET },
    signal: AbortSignal.timeout(8e3)
  });
  if (!res.ok) throw new Error(`Book read failed (${res.status}).`);
  const body = await res.json();
  return body.book ?? null;
}
async function remoteWriteRaw(id, book) {
  const res = await fetch(remoteUrl(id), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-terading-secret": process.env.BOOK_SECRET
    },
    body: JSON.stringify(book),
    signal: AbortSignal.timeout(8e3)
  });
  if (!res.ok) throw new Error(`Book write failed (${res.status}).`);
}
async function mirrorReadRaw(id) {
  const route = id === "live" ? "book" : "options-book";
  const res = await fetch(`${process.env.BOOK_MIRROR_URL.replace(/\/$/, "")}/api/${route}`, {
    signal: AbortSignal.timeout(8e3)
  });
  if (!res.ok) throw new Error(`Mirror read failed (${res.status}).`);
  return res.json();
}
async function readRaw(id) {
  if (remoteConfigured()) return remoteReadRaw(id);
  if (process.env.BOOK_MIRROR_URL) return mirrorReadRaw(id);
  return readFileRaw(id);
}
function readFileRaw(id) {
  const file = fileFor(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fs.renameSync(file, `${file}.corrupt`);
    return null;
  }
}
function writeFileRaw(id, book) {
  const file = fileFor(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(book));
  fs.renameSync(tmp, file);
}
async function readBook() {
  requireStore();
  const raw = await readRaw("live");
  if (raw == null) return freshBook();
  return normalizeBook(raw);
}
async function writeBook(raw) {
  requireStore();
  const book = normalizeBook(raw);
  if (remoteConfigured()) await remoteWriteRaw("live", book);
  else writeFileRaw("live", book);
  return book;
}
async function readOptionsBook() {
  requireStore();
  const raw = await readRaw("options");
  if (raw == null) return freshOptionsBook();
  return normalizeOptionsBook(raw);
}
async function writeOptionsBook(raw) {
  requireStore();
  const book = normalizeOptionsBook(raw);
  if (remoteConfigured()) await remoteWriteRaw("options", book);
  else writeFileRaw("options", book);
  return book;
}
function bookReadOnly() {
  return process.env.BOOK_READONLY === "1" || Boolean(process.env.BOOK_MIRROR_URL);
}
function bookStoreName() {
  if (remoteConfigured()) return "supabase";
  return process.env.BOOK_MIRROR_URL ? "mirror" : "file";
}

// server/app.ts
function createApp() {
  const symbols = /* @__PURE__ */ new Set(["NIFTY", "BANKNIFTY"]);
  const intervals = /* @__PURE__ */ new Set(["5m", "15m", "1h"]);
  const cache = /* @__PURE__ */ new Map();
  const TTL_MS = 2e3;
  const QUOTE_TTL_MS = 1e3;
  const CHAIN_TTL_MS = 15e3;
  let quoteCache = null;
  const app = express();
  app.use("/api", express.json({ limit: "4mb" }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, store: bookStoreName(), readOnly: bookReadOnly() });
  });
  app.put(["/api/book", "/api/options-book"], (_req, res, next) => {
    if (!bookReadOnly()) return next();
    res.status(403).json({ ok: false, error: "Book is read-only on this server." });
  });
  app.get("/api/book", async (_req, res) => {
    try {
      res.json(await readBook());
    } catch (err) {
      console.error(err instanceof Error ? err.message : "book read failed");
      res.status(503).json({ ok: false, error: "Book store unavailable." });
    }
  });
  app.put("/api/book", async (req, res) => {
    try {
      res.json(await writeBook(req.body));
    } catch (err) {
      console.error(err instanceof Error ? err.message : "book write failed");
      res.status(503).json({ ok: false, error: "Book store unavailable." });
    }
  });
  app.get("/api/options-book", async (_req, res) => {
    try {
      res.json(await readOptionsBook());
    } catch (err) {
      console.error(err instanceof Error ? err.message : "options book read failed");
      res.status(503).json({ ok: false, error: "Options book store unavailable." });
    }
  });
  app.put("/api/options-book", async (req, res) => {
    try {
      res.json(await writeOptionsBook(req.body));
    } catch (err) {
      console.error(err instanceof Error ? err.message : "options book write failed");
      res.status(503).json({ ok: false, error: "Options book store unavailable." });
    }
  });
  app.get("/api/candles", async (req, res) => {
    const symbol = String(req.query.symbol ?? "");
    const interval = String(req.query.interval ?? "");
    if (!symbols.has(symbol) || !intervals.has(interval)) {
      res.status(400).json({ ok: false, symbol, interval, error: "Unknown symbol or interval." });
      return;
    }
    const key = `${symbol}|${interval}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      res.status(hit.body.ok === false ? 502 : 200).json(hit.body);
      return;
    }
    const body = await fetchCandles(symbol, interval);
    cache.set(key, { at: Date.now(), body });
    if (!body.ok) console.error(body.error);
    res.status(body.ok ? 200 : 502).json(body);
  });
  app.get("/api/quotes", async (_req, res) => {
    if (quoteCache && Date.now() - quoteCache.at < QUOTE_TTL_MS) {
      const cached = quoteCache.body;
      res.status(cached.ok === false ? 502 : 200).json(quoteCache.body);
      return;
    }
    const body = await fetchQuotes();
    quoteCache = { at: Date.now(), body };
    if (!body.ok) console.error(body.error);
    res.status(body.ok ? 200 : 502).json(body);
  });
  app.get("/api/option-chain", async (req, res) => {
    const symbol = String(req.query.symbol ?? "");
    if (!symbols.has(symbol)) {
      res.status(400).json({ ok: false, symbol, error: "Unknown symbol.", fetchedAt: Date.now() });
      return;
    }
    const key = `chain|${symbol}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CHAIN_TTL_MS) {
      res.status(hit.body.ok === false ? 502 : 200).json(hit.body);
      return;
    }
    const body = await fetchOptionChain(symbol);
    cache.set(key, { at: Date.now(), body });
    if (!body.ok) console.error(body.error);
    res.status(body.ok ? 200 : 502).json(body);
  });
  return app;
}

// netlify/function-entry.ts
var handle = serverless(createApp());
var FUNCTION_PREFIX = "/.netlify/functions/api";
function apiPath(event) {
  const raw = event.rawUrl ? new URL(event.rawUrl).pathname : event.path ?? "/";
  if (raw === FUNCTION_PREFIX || raw.startsWith(`${FUNCTION_PREFIX}/`)) {
    const rest = raw.slice(FUNCTION_PREFIX.length);
    return `/api${rest}` || "/api";
  }
  return raw;
}
var handler = (event, context) => handle({ ...event, path: apiPath(event) }, context);
export {
  handler
};
