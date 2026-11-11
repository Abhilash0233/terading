import express from "express";
import { fetchCandles, fetchQuotes } from "./market.js";
import { fetchOptionChain } from "./options.js";
import { bookReadOnly, bookStoreName, readBook, readOptionsBook, writeBook, writeOptionsBook } from "./store.js";
import type { IntervalId, SymbolId } from "../src/lib/types";

export function createApp(): express.Express {
  const symbols = new Set<SymbolId>(["NIFTY", "BANKNIFTY"]);
  const intervals = new Set<IntervalId>(["5m", "15m", "1h"]);
  const cache = new Map<string, { at: number; body: unknown }>();
  const TTL_MS = 2_000;
  const QUOTE_TTL_MS = 1_000;
  const CHAIN_TTL_MS = 15_000;
  let quoteCache: { at: number; body: unknown } | null = null;

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
    const symbol = String(req.query.symbol ?? "") as SymbolId;
    const interval = String(req.query.interval ?? "") as IntervalId;
    if (!symbols.has(symbol) || !intervals.has(interval)) {
      res.status(400).json({ ok: false, symbol, interval, error: "Unknown symbol or interval." });
      return;
    }
    const key = `${symbol}|${interval}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      res.status((hit.body as { ok?: boolean }).ok === false ? 502 : 200).json(hit.body);
      return;
    }
    const body = await fetchCandles(symbol, interval);
    cache.set(key, { at: Date.now(), body });
    if (!body.ok) console.error(body.error);
    res.status(body.ok ? 200 : 502).json(body);
  });

  app.get("/api/quotes", async (_req, res) => {
    if (quoteCache && Date.now() - quoteCache.at < QUOTE_TTL_MS) {
      const cached = quoteCache.body as { ok?: boolean };
      res.status(cached.ok === false ? 502 : 200).json(quoteCache.body);
      return;
    }
    const body = await fetchQuotes();
    quoteCache = { at: Date.now(), body };
    if (!body.ok) console.error(body.error);
    res.status(body.ok ? 200 : 502).json(body);
  });

  app.get("/api/option-chain", async (req, res) => {
    const symbol = String(req.query.symbol ?? "") as SymbolId;
    if (!symbols.has(symbol)) {
      res.status(400).json({ ok: false, symbol, error: "Unknown symbol.", fetchedAt: Date.now() });
      return;
    }
    const key = `chain|${symbol}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CHAIN_TTL_MS) {
      res.status((hit.body as { ok?: boolean }).ok === false ? 502 : 200).json(hit.body);
      return;
    }
    const body = await fetchOptionChain(symbol);
    cache.set(key, { at: Date.now(), body });
    if (!body.ok) console.error(body.error);
    res.status(body.ok ? 200 : 502).json(body);
  });

  return app;
}
