import { useEffect, useMemo, useRef, useState } from "react";
import { ChartPane, type ChartLine } from "./components/ChartPane";
import { OptionsDesk } from "./components/OptionsDesk";
import { freshBook } from "./lib/book";
import { buildReplay, flattenLive, stepLive, unrealized, type Feed, type ReplayBuild } from "./lib/execution";
import { formatBarTime, formatClock, inr, inrPlain, px, rMultiple, signedPx } from "./lib/format";
import { computeIndicators } from "./lib/indicators";
import { armSound, isSoundEnabled, playTradeSound, setSoundEnabled, soundForClose, type TradeSound } from "./lib/sounds";
import { evaluateSetupAt, sentimentAt } from "./lib/strategy";
import { changeExecutionInterval, describeWatch } from "./lib/watch";
import { higherInterval, istDateKey, sessionState, splitCandles, tradeInBlotterRange, type BlotterRange } from "./lib/time";
import {
  DEFAULT_LOTS,
  INTERVAL_LABEL,
  INTERVAL_SECONDS,
  INTERVALS,
  LOT_NOTE,
  SYMBOLS,
  type BarIndicators,
  type Book,
  type Candle,
  type CandleResponse,
  type IntervalId,
  type Mode,
  type QuoteTick,
  type Sentiment,
  type Setup,
  type SymbolId,
  type Trade,
} from "./lib/types";

type ClientFeed = CandleResponse & { stale?: boolean };
type Pack = { candles: Candle[]; ind: BarIndicators[] };

interface Notice {
  id: string;
  kind: "open" | "close";
  sound: TradeSound;
  title: string;
  body: string;
}

const EMPTY_SETUP: Setup = {
  symbol: "NIFTY",
  interval: "5m",
  status: "flat",
  direction: null,
  entry: null,
  stop: null,
  target: null,
  riskPoints: null,
  rMultiple: null,
  signalTime: null,
  conditions: [],
  summary: "Waiting for candles.",
  structure: "",
};

export function App() {
  const [book, setBook] = useState<Book>(freshBook);
  const [feeds, setFeeds] = useState<Record<string, ClientFeed>>({});
  const [quotes, setQuotes] = useState<Partial<Record<SymbolId, QuoteTick>>>({});
  const [tfDrops, setTfDrops] = useState<Partial<Record<SymbolId, string>>>({});
  const [hydrated, setHydrated] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [replayNote, setReplayNote] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [soundOn, setSoundOn] = useState(() => isSoundEnabled());
  const [blotterRange, setBlotterRange] = useState<BlotterRange>("today");
  const saved = useRef("");
  const seenEvents = useRef<Set<string> | null>(null);
  const feedsRef = useRef(feeds);
  const bookRef = useRef(book);
  const appliedKey = useRef("");
  const lockCursor = useRef(false);
  const dropTimers = useRef<Partial<Record<SymbolId, number>>>({});
  feedsRef.current = feeds;
  bookRef.current = book;

  const symbol = book.ui.symbol;
  const interval = book.ui.interval;
  const mode = book.ui.mode;
  const activeKey = `${symbol}|${interval}`;

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      const [bookResult, health, nextFeeds, nextQuotes] = await Promise.all([
        fetch("/api/book").then((res) => res.json()).catch(() => freshBook()),
        fetch("/api/health").then((res) => res.json()).catch(() => null),
        pullFeeds({}),
        pullQuotes(),
      ]);
      if (cancel) return;
      const loaded = bookResult as Book;
      saved.current = JSON.stringify(loaded);
      setBook(loaded);
      setReadOnly(health?.readOnly === true);
      setFeeds(nextFeeds);
      setQuotes(nextQuotes);
      setHydrated(true);
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const id = setInterval(() => {
      void pullFeeds(feedsRef.current).then(setFeeds);
    }, 2000);
    return () => clearInterval(id);
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const id = setInterval(() => {
      void pullQuotes().then((next) => {
        if (Object.keys(next).length === 0) return;
        setQuotes((prev) => ({ ...prev, ...next }));
      });
    }, 1500);
    return () => clearInterval(id);
  }, [hydrated]);

  useEffect(() => {
    // Only dismiss a TF-drop notice early when a position opens. A new armed
    // order after the switch must not hide the cancel reason.
    setTfDrops((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of SYMBOLS) {
        if (current[item.id] && book.symbols[item.id].position) {
          delete next[item.id];
          changed = true;
          const timer = dropTimers.current[item.id];
          if (timer) window.clearTimeout(timer);
          delete dropTimers.current[item.id];
        }
      }
      return changed ? next : current;
    });
  }, [book.symbols]);

  const feedStamp = Object.entries(feeds).map(([key, feed]) => {
    const last = feed.candles?.at(-1);
    return `${key}:${feed.fetchedAt ?? 0}:${last?.time ?? 0}:${last?.close ?? 0}:${last?.high ?? 0}:${last?.low ?? 0}:${feed.ok}`;
  }).join("|");
  // Wall-clock tick so bar closes are processed even when Yahoo OHLC is unchanged.
  // Without this, fills often only appear after a timeframe switch re-runs stepLive.
  const liveClockSec = Math.floor(now.getTime() / 1000);

  useEffect(() => {
    if (!hydrated || readOnly) return;
    const list = toFeeds(feeds);
    if (list.length === 0) return;
    setBook((current) => {
      const next = stepLive(current, list, current.ui.interval, Date.now() / 1000);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [hydrated, readOnly, feedStamp, feeds, book.ui.interval, book.auto, book.lots.NIFTY, book.lots.BANKNIFTY, liveClockSec]);

  useEffect(() => {
    if (!hydrated || !readOnly) return;
    const id = setInterval(() => {
      void fetch("/api/book")
        .then((res) => (res.ok ? res.json() : null))
        .then((remote: Book | null) => {
          if (!remote?.symbols) return;
          setBook((current) => {
            const next = { ...remote, ui: current.ui };
            return JSON.stringify(next) === JSON.stringify(current) ? current : next;
          });
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [hydrated, readOnly]);

  useEffect(() => {
    if (!hydrated) return;
    const next = new Set<string>();
    const events: Notice[] = [];
    for (const id of ["NIFTY", "BANKNIFTY"] as SymbolId[]) {
      const position = book.symbols[id].position;
      if (position?.mode === "live") {
        const key = `open:${position.id}`;
        next.add(key);
        if (seenEvents.current && !seenEvents.current.has(key)) {
          const name = id === "NIFTY" ? "Nifty" : "Bank Nifty";
          events.push({
            id: key,
            kind: "open",
            sound: "open",
            title: `${name} ${position.interval} ${position.direction.toUpperCase()} opened`,
            body: `Filled at ${px(position.entry)}. Stop ${px(position.stop)}. Target ${px(position.target)}.`,
          });
        }
      }
    }
    for (const trade of book.trades) {
      if (trade.mode !== "live") continue;
      const key = `close:${trade.id}`;
      next.add(key);
      if (seenEvents.current && !seenEvents.current.has(key)) {
        const name = trade.symbol === "NIFTY" ? "Nifty" : "Bank Nifty";
        const why = trade.reason === "target" ? "target" : trade.reason === "stop" ? "stop" : "flatten";
        events.push({
          id: key,
          kind: "close",
          sound: soundForClose(trade.reason, trade.pnl),
          title: `${name} ${trade.interval} ${trade.direction.toUpperCase()} closed · ${why}`,
          body: `Exit ${px(trade.exit)} from ${px(trade.entry)}. ${signedPx(trade.points)} pts, ${inr(trade.pnl)}.`,
        });
      }
    }
    if (seenEvents.current && mode === "live" && events.length > 0) {
      setNotices((current) => [...events, ...current].slice(0, 4));
      for (const event of events) playTradeSound(event.sound);
      const headline = events.map((event) => event.title).join(" · ");
      const priorTitle = document.title;
      document.title = headline;
      window.setTimeout(() => {
        if (document.title === headline) document.title = priorTitle.startsWith("Terading") ? priorTitle : "Terading";
      }, 8000);
      for (const event of events) {
        window.setTimeout(() => {
          setNotices((current) => current.filter((notice) => notice.id !== event.id));
        }, 14000);
      }
    }
    seenEvents.current = next;
  }, [hydrated, mode, book]);

  useEffect(() => {
    if (!hydrated || readOnly) return;
    const serial = JSON.stringify(book);
    if (serial === saved.current) return;
    const handle = setTimeout(() => {
      saved.current = serial;
      void fetch("/api/book", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: serial,
      });
    }, 400);
    return () => clearTimeout(handle);
  }, [book, hydrated, readOnly]);

  const packed = useMemo(() => {
    const map = new Map<string, Pack>();
    for (const item of SYMBOLS) {
      for (const tf of INTERVALS) {
        const candles = feeds[`${item.id}|${tf}`]?.candles;
        if (!candles?.length) continue;
        map.set(`${item.id}|${tf}`, { candles, ind: computeIndicators(candles) });
      }
    }
    return map;
  }, [feedStamp, feeds]);

  const replay = useMemo<ReplayBuild | null>(() => {
    const series = packed.get(activeKey);
    if (!series) return null;
    const higher = higherInterval(interval);
    const higherPack = higher ? packed.get(`${symbol}|${higher}`) : undefined;
    const htf = higher && higherPack ? { interval: higher, candles: higherPack.candles, ind: higherPack.ind } : null;
    const flattens = book.ui.replayFlattens[activeKey] ?? [];
    return buildReplay({
      symbol,
      interval,
      candles: series.candles,
      htf,
      lotSize: book.lots[symbol],
      auto: book.auto,
      flattenTimes: flattens,
    });
  }, [packed, activeKey, symbol, interval, book.lots, book.auto, book.ui.replayFlattens]);

  useEffect(() => {
    if (!replay?.snaps.length) return;
    if (lockCursor.current) {
      lockCursor.current = false;
      appliedKey.current = activeKey;
      return;
    }
    if (appliedKey.current === activeKey) return;
    appliedKey.current = activeKey;
    const savedTime = bookRef.current.ui.replayTime[activeKey];
    const exists = savedTime != null && replay.snaps.some((snap) => snap.time === savedTime);
    setCursorTime(exists ? savedTime! : replay.snaps[replay.snaps.length - 1].time);
  }, [replay, activeKey]);

  useEffect(() => {
    if (!hydrated || cursorTime == null) return;
    setBook((current) => {
      if (
        current.ui.replayTime[activeKey] === cursorTime
        && current.ui.mode === mode
        && current.ui.symbol === symbol
        && current.ui.interval === interval
      ) return current;
      return {
        ...current,
        ui: {
          ...current.ui,
          mode,
          symbol,
          interval,
          replayTime: { ...current.ui.replayTime, [activeKey]: cursorTime },
        },
      };
    });
  }, [hydrated, cursorTime, mode, symbol, interval, activeKey]);

  const snapIndex = replay?.snaps.findIndex((snap) => snap.time === cursorTime) ?? -1;
  const safeIndex = snapIndex >= 0 ? snapIndex : Math.max(0, (replay?.snaps.length ?? 1) - 1);
  const snap = replay?.snaps[safeIndex];
  const replayTrades = replay ? replay.trades.slice(0, snap?.tradeCount ?? 0) : [];

  const playRef = useRef({ replay, safeIndex });
  playRef.current = { replay, safeIndex };
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const current = playRef.current;
      const snaps = current.replay?.snaps ?? [];
      if (current.safeIndex >= snaps.length - 1) {
        setPlaying(false);
        return;
      }
      setCursorTime(snaps[current.safeIndex + 1].time);
    }, 220);
    return () => clearInterval(id);
  }, [playing]);

  const session = sessionState(now);
  const selectedFeed = feeds[activeKey];
  const selectedPack = packed.get(activeKey) ?? null;
  const view = mode === "replay" && selectedPack ? {
    candles: selectedPack.candles.slice(0, safeIndex + 1),
    ind: selectedPack.ind.slice(0, safeIndex + 1),
  } : selectedPack;

  const positionOpen = Boolean(book.symbols[symbol].position);
  const decisionSec = Math.floor(now.getTime() / 30000) * 30;
  const liveSetup = useMemo(
    () => setupFor(symbol, interval, selectedPack, packed, positionOpen, decisionSec),
    [symbol, interval, selectedPack, packed, positionOpen, decisionSec],
  );
  const setup = mode === "replay" ? (snap?.setup ?? EMPTY_SETUP) : (liveSetup ?? EMPTY_SETUP);
  const pending = mode === "replay" ? snap?.pending ?? null : book.symbols[symbol].pending;

  const lines = useMemo<ChartLine[]>(() => {
    const position = mode === "replay" ? snap?.position ?? null : book.symbols[symbol].position;
    if (position) {
      return [
        { price: position.entry, title: "Entry", color: "#8eb4d6", dashed: false },
        { price: position.stop, title: "Stop", color: "#ff6d67", dashed: false },
        { price: position.target, title: "Target", color: "#3ddc97", dashed: false },
      ];
    }
    if (setup.entry != null && setup.stop != null && setup.target != null && (setup.status === "long" || setup.status === "short")) {
      return [
        { price: setup.entry, title: "Entry", color: "#8eb4d6", dashed: true },
        { price: setup.stop, title: "Stop", color: "#ff6d67", dashed: true },
        { price: setup.target, title: "Target", color: "#3ddc97", dashed: true },
      ];
    }
    const closed = replayTrades.at(-1);
    if (mode === "replay" && closed && snap?.time === closed.closedAt) {
      return [
        { price: closed.entry, title: "Entry", color: "#8eb4d6", dashed: false },
        { price: closed.stop, title: "Stop", color: "#ff6d67", dashed: false },
        { price: closed.target, title: "Target", color: "#3ddc97", dashed: false },
      ];
    }
    return [];
  }, [mode, symbol, setup.status, setup.entry, setup.stop, setup.target, snap?.position?.id, snap?.time, replayTrades.length, book.symbols[symbol].position?.id]);

  function priceOf(id: SymbolId): number | null {
    if (mode === "replay" && id === symbol) return view?.candles.at(-1)?.close ?? null;
    const live = quotes[id]?.price;
    if (live != null && live > 0) return live;
    const pack = packed.get(`${id}|${interval}`) ?? packed.get(`${id}|5m`) ?? packed.get(`${id}|15m`) ?? packed.get(`${id}|1h`);
    return pack?.candles.at(-1)?.close ?? null;
  }

  function jump() {
    if (!replay || replay.trades.length === 0) {
      setReplayNote("No completed round trip in the loaded candles.");
      setMode("replay");
      return;
    }
    const trade = replay.trades.find((row) => row.reason === "target") ?? replay.trades[0];
    lockCursor.current = true;
    setReplayNote("");
    setPlaying(false);
    setMode("replay");
    setCursorTime(trade.closedAt);
  }

  function flatten(id: SymbolId) {
    if (mode === "live") {
      if (readOnly) return;
      const price = priceOf(id);
      if (price == null) return;
      setBook((current) => flattenLive(current, id, price, Date.now() / 1000));
      return;
    }
    if (cursorTime == null) return;
    setBook((current) => {
      const list = current.ui.replayFlattens[activeKey] ?? [];
      if (list.includes(cursorTime)) return current;
      return { ...current, ui: { ...current.ui, replayFlattens: { ...current.ui.replayFlattens, [activeKey]: [...list, cursorTime] } } };
    });
  }

  const trades = mode === "replay" ? replayTrades : book.trades.filter((trade) => trade.mode === "live");
  const nowSec = now.getTime() / 1000;
  const rangeTrades = [...trades]
    .filter((trade) => mode === "replay" || tradeInBlotterRange(trade.closedAt, blotterRange, nowSec))
    .sort((a, b) => b.closedAt - a.closedAt || b.openedAt - a.openedAt);
  const rangePnl = rangeTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const openPositions = (["NIFTY", "BANKNIFTY"] as SymbolId[]).flatMap((id) => {
    const position = mode === "replay" ? (id === symbol ? snap?.position ?? null : null) : book.symbols[id].position;
    if (!position) return [];
    const mark = priceOf(id) ?? position.entry;
    return [{ position, mark, ...unrealized(position, mark) }];
  });
  const today = istDateKey(now.getTime() / 1000);
  const realized = book.trades.filter((trade) => trade.mode === "live" && istDateKey(trade.closedAt) === today).reduce((sum, trade) => sum + trade.pnl, 0);
  const openPnl = (["NIFTY", "BANKNIFTY"] as SymbolId[]).reduce((sum, id) => {
    const position = book.symbols[id].position;
    const mark = priceOf(id);
    if (!position || mark == null || mode === "replay") return sum;
    return sum + unrealized(position, mark).pnl;
  }, 0);
  const replayPnl = replayTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const cash = mode === "replay" ? (snap?.cash ?? book.startingCash) : book.cash;
  const latest = view?.ind.at(-1);
  const hasVolume = view?.candles.some((bar) => bar.volume > 0) ?? false;

  const watches = SYMBOLS.map((item) => {
    const ownReplay = mode === "replay" && item.id === symbol;
    const position = ownReplay ? snap?.position ?? null : book.symbols[item.id].position;
    const order = ownReplay ? snap?.pending ?? null : book.symbols[item.id].pending;
    const pack = packed.get(`${item.id}|${interval}`) ?? null;
    const read = ownReplay
      ? (snap?.setup ?? EMPTY_SETUP)
      : (setupFor(item.id, interval, pack, packed, Boolean(book.symbols[item.id].position), decisionSec) ?? EMPTY_SETUP);
    return {
      id: item.id,
      name: item.name,
      ...describeWatch({
        auto: book.auto,
        position,
        pending: order,
        setup: read,
        mark: priceOf(item.id),
        dropped: ownReplay ? null : tfDrops[item.id] ?? null,
      }),
    };
  });

  return (
    <div className="app">
      <div className="toasts" aria-live="assertive">
        {notices.map((notice) => (
          <button
            key={notice.id}
            type="button"
            className={`toast ${notice.kind}`}
            data-testid="trade-popup"
            onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}
          >
            <strong>{notice.title}</strong>
            <span>{notice.body}</span>
          </button>
        ))}
      </div>
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 22 22" aria-hidden="true">
            <rect x="1" y="1" width="20" height="20" fill="#12161c" stroke="#8eb4d6" />
            <path d="M4 15 L9 10 L12 13 L18 6" fill="none" stroke="#3ddc97" strokeWidth="1.6" />
          </svg>
          <div>
            <strong>TERADING</strong>
            <span>Nifty 50 · Bank Nifty</span>
          </div>
        </div>
        <div className="badges">
          <span className="badge">Paper trading</span>
          <span className="badge">Not advice</span>
          <span className="badge">Quotes may be delayed</span>
          {readOnly ? <span className="badge" data-testid="mirror-badge">Mirror · read-only</span> : null}
          <button
            type="button"
            className={`badge sound-toggle ${soundOn ? "on" : "off"}`}
            data-testid="sound-toggle"
            aria-pressed={soundOn}
            onClick={() => {
              const next = !soundOn;
              setSoundEnabled(next);
              setSoundOn(next);
              if (next) armSound(true);
            }}
          >
            {soundOn ? "Sound on" : "Sound off"}
          </button>
        </div>
        <div className="clock">
          <time dateTime={now.toISOString()}>{formatClock(now)}</time>
          <span className={session.open ? "session open" : "session closed"} data-testid="session">{session.label}</span>
          <small>NSE cash 09:15–15:30 IST · weekdays</small>
        </div>
        <div className="modes" role="group" aria-label="Data mode">
          <button type="button" aria-pressed={mode === "live"} onClick={() => { setPlaying(false); setMode("live"); }}>Live</button>
          <button type="button" className="replay-on" aria-pressed={mode === "replay"} data-testid="mode-replay" onClick={() => setMode("replay")}>Replay</button>
        </div>
      </header>

      <section className="watch" data-testid="watch" aria-label="Order status">
        {watches.map((row) => (
          <div key={row.id} className={`watch-row ${row.tone}`} data-testid={`watch-${row.id}`} data-tone={row.tone}>
            <strong>{row.name}</strong>
            <span className="watch-label">{row.label}</span>
            <p>{row.reason}</p>
          </div>
        ))}
      </section>

      <div className="workspace">
        <aside className="quotes">
          {SYMBOLS.map((item) => {
            const cardPack = mode === "replay" && item.id === symbol ? view : (packed.get(`${item.id}|${interval}`) ?? null);
            const cardFeed = feeds[`${item.id}|${interval}`];
            const sentiment = cardPack ? readSentiment(item.id, interval, cardPack, packed, mode === "replay" && item.id === symbol ? (cardPack.candles.at(-1)?.time ?? 0) + INTERVAL_SECONDS[interval] : now.getTime() / 1000) : null;
            const quote = cardPack ? changeOf(cardPack.candles) : null;
            const last = mode === "replay" && item.id === symbol
              ? quote?.last ?? null
              : (quotes[item.id]?.price ?? quote?.last ?? null);
            const day = quote && last != null
              ? (() => {
                const ref = quote.last - quote.delta;
                const delta = last - ref;
                return { delta, pct: ref ? (delta / ref) * 100 : 0 };
              })()
              : null;
            return (
              <button
                key={item.id}
                type="button"
                className={item.id === symbol ? "quote selected" : "quote"}
                aria-pressed={item.id === symbol}
                data-testid={`quote-${item.id}`}
                onClick={() => setSymbol(item.id)}
              >
                <div className="quote-head">
                  <span className="name">{item.name}</span>
                  {sentiment ? <span className={`bias ${sentiment.bias}`}>{sentiment.bias}</span> : <span className="bias neutral">Wait</span>}
                </div>
                {last != null && day ? (
                  <div className="last-row">
                    <span className="price num" data-testid={`last-${item.id}`}>{px(last)}</span>
                    <span className={day.delta >= 0 ? "chg up" : "chg down"}>{signedPx(day.delta)} {day.pct >= 0 ? "+" : "−"}{Math.abs(day.pct).toFixed(2)}%</span>
                  </div>
                ) : (
                  <div className="price">{cardFeed && !cardFeed.ok ? "No feed" : "Loading"}</div>
                )}
                {cardFeed && !cardFeed.ok ? <p className="summary" role="alert">{cardFeed.error}</p> : null}
                <ul className="reasons">
                  {(sentiment?.reasons ?? []).map((reason) => (
                    <li key={reason.id}>
                      <i className={`dot ${reason.bias}`} />
                      <span><b>{reason.label}.</b> {reason.detail}</span>
                    </li>
                  ))}
                </ul>
                <footer>
                  {mode === "replay" && item.id === symbol ? "Replay tape" : (quotes[item.id] ? "Live quote" : "Live read")}
                  {quote ? ` · Candle ${formatBarTime(cardPack!.candles.at(-1)!.time)}` : ""}
                  {cardFeed?.stale ? " · stale" : ""}
                </footer>
              </button>
            );
          })}
          <p className="lot-note">{LOT_NOTE}</p>
        </aside>

        <section className="main-col">
          <div className="toolbar">
            <div className="tfs" role="group" aria-label="Execution timeframe">
              {INTERVALS.map((tf) => (
                <button key={tf} type="button" aria-pressed={tf === interval} data-testid={`tf-${tf}`} onClick={() => setIntervalTf(tf)}>
                  {tf === "1h" ? "1H" : tf.toUpperCase()}
                </button>
              ))}
            </div>
            <button type="button" className="text-btn" data-testid="jump-trade" onClick={jump}>Round trip</button>
            <label className="auto">
              <input type="checkbox" checked={book.auto} disabled={readOnly} onChange={(event) => setBook((current) => ({ ...current, auto: event.target.checked }))} />
              Auto {book.auto ? "on" : "off"}
            </label>
            <div className="lots">
              {SYMBOLS.map((item) => (
                <label key={item.id}>
                  {item.id === "NIFTY" ? "Nifty lot" : "Bank lot"}
                  <input
                    className="num"
                    aria-label={`${item.name} lot size`}
                    type="number"
                    min={1}
                    step={1}
                    value={book.lots[item.id]}
                    disabled={readOnly}
                    onChange={(event) => setLot(item.id, event.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="source-line">
              {selectedFeed?.sourceDetail ?? "Loading feed"}
              {selectedFeed?.warning ? ` · ${selectedFeed.warning}` : ""}
              {selectedFeed?.stale ? " · STALE" : ""}
            </div>
          </div>

          <div className="chart-stage">
            <div className={mode === "replay" ? "chart-tag replay" : "chart-tag"} data-testid="mode-label">{mode === "replay" ? "REPLAY" : "LIVE"}</div>
            {view && view.candles.length > 0 ? (
              <ChartPane candles={view.candles} indicators={view.ind} lines={lines} pinKey={`${activeKey}|${mode}`} />
            ) : (
              <div className="error-pane" role="alert" data-testid="feed-error">
                <div>
                  <strong>{selectedFeed && !selectedFeed.ok ? "FEED ERROR" : "LOADING CANDLES"}</strong>
                  <p>{selectedFeed && !selectedFeed.ok ? selectedFeed.error : `Requesting ${SYMBOLS.find((item) => item.id === symbol)?.name} ${INTERVAL_LABEL[interval]} bars.`}</p>
                </div>
              </div>
            )}
            <div className="pane-label rsi">RSI</div>
            <div className="pane-label atr">ATR</div>
          </div>

          <div className="techs" data-testid="technicals">
            <Metric label="EMA 9" value={latest?.ema9} />
            <Metric label="EMA 21" value={latest?.ema21} />
            <Metric label="Session VWAP" value={latest?.vwap} note={latest?.vwapMode === "equal-weight" ? "equal-weight" : "volume"} />
            <Metric label="RSI 14" value={latest?.rsi} digits={1} />
            <Metric label="ATR 14" value={latest?.atr} />
            <div className="metric structure">
              <span>Structure</span>
              <strong>{setup.structure || "Waiting for swings."}</strong>
            </div>
            <div className="legend">
              <span><i className="swatch" style={{ background: "#e0b15c" }} />EMA 9</span>
              <span><i className="swatch" style={{ background: "#8eb4d6" }} />EMA 21</span>
              <span><i className="swatch" style={{ background: "#d7dde6" }} />VWAP</span>
              {!hasVolume ? <span>No volume in this feed</span> : <span>Volume on chart</span>}
            </div>
          </div>

          {mode === "replay" ? (
            <div className="replay-bar">
              <div className="stepper">
                <button type="button" onClick={() => setCursorTime(replay?.snaps[Math.min(40, (replay?.snaps.length ?? 1) - 1)]?.time ?? null)} aria-label="Rewind">|&lt;</button>
                <button type="button" onClick={() => stepCursor(-1)} aria-label="Previous candle">&lt;</button>
                <button type="button" onClick={() => setPlaying((value) => !value)} data-testid="play">{playing ? "Pause" : "Play"}</button>
                <button type="button" onClick={() => stepCursor(1)} aria-label="Next candle">&gt;</button>
              </div>
              <button type="button" className="text-btn" onClick={jump}>Jump to round trip</button>
              <input
                type="range"
                min={0}
                max={Math.max(0, (replay?.snaps.length ?? 1) - 1)}
                value={Math.min(safeIndex, Math.max(0, (replay?.snaps.length ?? 1) - 1))}
                aria-label="Replay position"
                onChange={(event) => {
                  const next = replay?.snaps[Number(event.target.value)];
                  if (next) setCursorTime(next.time);
                }}
              />
              <div className="replay-meta">
                {snap ? `${safeIndex + 1}/${replay?.snaps.length} · ${formatBarTime(snap.time)}` : "No tape"}
                {replayNote ? ` · ${replayNote}` : ""}
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <section className="deck">
        <article className="panel" data-testid="setup-card">
          <div className="card-head">
            <h2>Setup · {INTERVAL_LABEL[interval]}</h2>
            <span className={`bias ${setup.status}`}>{setup.status === "stand-aside" ? "Stand aside" : setup.status}</span>
          </div>
          <p className={`status-word ${setup.status}`}>{setup.status === "long" ? "LONG" : setup.status === "short" ? "SHORT" : setup.status === "stand-aside" ? "STAND ASIDE" : "FLAT"}</p>
          <p className="summary">{pending ? `Working order. ${setup.summary}` : setup.summary}</p>
          <p className="rules">
            Higher-timeframe bias gates the side. Long needs a pullback to EMA 9 or VWAP, a reclaim of EMA 9, and RSI 40–65. Short is the mirror with RSI 35–60. Neutral bias stands aside. Entry is the signal high, or the low for a short. Stop is beyond that extreme and at least 0.5×ATR. Target is 1.5R. One position per index. Stop fills before target on the same candle.
          </p>
          <div className="levels">
            <Level label="Entry" value={setup.entry} />
            <Level label="Stop" value={setup.stop} />
            <Level label="Target" value={setup.target} />
            <Level label="R" text={setup.rMultiple == null ? "—" : rMultiple(setup.rMultiple)} />
          </div>
          <ul className="conditions">
            {setup.conditions.map((condition) => (
              <li key={condition.id}>
                <span className={`mark ${condition.state}`}>{condition.state === "pass" ? "PASS" : condition.state === "fail" ? "FAIL" : "—"}</span>
                <span>{condition.label}<small>{condition.detail}</small></span>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel blotter-panel">
          <div className="card-head">
            <h2>Blotter</h2>
            <span className="num">{mode === "live" ? "LIVE" : "REPLAY"} · {trades.length}</span>
          </div>
          <div className="account account-inline">
            <div><span>Cash</span><strong className="num">{inrPlain(cash)}</strong></div>
            <div><span>{mode === "replay" ? "Replay P&L" : "Realized today"}</span><strong className={pnlClass(mode === "replay" ? replayPnl : realized)}>{inr(mode === "replay" ? replayPnl : realized)}</strong></div>
            {mode === "live" ? <div><span>Open P&L</span><strong className={pnlClass(openPnl)}>{inr(openPnl)}</strong></div> : <div><span>Live cash</span><strong className="num">{inrPlain(book.cash)}</strong></div>}
            <div><span>Start</span><strong className="num">{inrPlain(book.startingCash)}</strong></div>
          </div>
          <h2>Open positions</h2>
          {openPositions.length === 0 ? <p className="empty">Flat. One position per index.</p> : (
            <table className="positions">
              <thead>
                <tr><th>Index</th><th>Side</th><th>Entry</th><th>Mark</th><th>U.P&L</th><th></th></tr>
              </thead>
              <tbody>
                {openPositions.map(({ position, mark, pnl }) => (
                  <tr key={position.id}>
                    <td>{position.symbol === "NIFTY" ? "Nifty" : "Bank"} {position.interval}</td>
                    <td className={position.direction === "long" ? "up" : "down"}>{position.direction.toUpperCase()}</td>
                    <td>{px(position.entry)}</td>
                    <td data-testid={`mark-${position.symbol}`}>{px(mark)}</td>
                    <td className={pnlClass(pnl)} data-testid={`upnl-${position.symbol}`}>{inr(pnl)}</td>
                    <td><button type="button" className="flatten" disabled={readOnly && mode === "live"} onClick={() => flatten(position.symbol)}>Flatten</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="lot-note">P&L = index points × lot. Defaults {DEFAULT_LOTS.NIFTY} / {DEFAULT_LOTS.BANKNIFTY}.</p>
          <div className="blotter-fills-head">
            <h2>Fills</h2>
            <div className="tfs blotter-range" role="group" aria-label="Fill range">
              {([
                ["today", "Today"],
                ["yesterday", "Yesterday"],
                ["week", "This week"],
                ["month", "Month"],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={blotterRange === id}
                  data-testid={`blotter-range-${id}`}
                  onClick={() => setBlotterRange(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className={`num ${rangePnl > 0 ? "up" : rangePnl < 0 ? "down" : ""}`}>
              {rangeTrades.length} · {inr(rangePnl)}
            </span>
          </div>
          {trades.length === 0 ? <p className="empty">No paper fills yet. Auto fills when price trades through the entry.</p> : rangeTrades.length === 0 ? (
            <p className="empty">No fills in this range.</p>
          ) : (
            <div className="blotter-wrap">
              <table className="blotter" data-testid="blotter">
                <thead>
                  <tr>
                    <th>In</th><th>Out</th><th>Index</th><th>Side</th><th>Entry</th><th>Exit</th><th>Pts</th><th>P&L</th><th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {rangeTrades.map((trade) => (
                    <tr key={trade.id} data-testid="trade-row">
                      <td>{formatBarTime(trade.openedAt)}</td>
                      <td>{formatBarTime(trade.closedAt)}</td>
                      <td>{trade.symbol === "NIFTY" ? "Nifty" : "Bank"} {trade.interval}</td>
                      <td className={trade.direction === "long" ? "up" : "down"}>{trade.direction.toUpperCase()}</td>
                      <td>{px(trade.entry)}</td>
                      <td>{px(trade.exit)}</td>
                      <td className={pnlClass(trade.points)}>{signedPx(trade.points)}</td>
                      <td className={pnlClass(trade.pnl)}>{inr(trade.pnl)}</td>
                      <td>{trade.reason.toUpperCase()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>

      <OptionsDesk
        live={mode === "live"}
        readOnly={readOnly}
        auto={book.auto}
        activeInterval={interval}
        lots={book.lots}
        feeds={toFeeds(feeds)}
        setups={Object.fromEntries(SYMBOLS.map((item) => {
          const pack = packed.get(`${item.id}|${interval}`) ?? null;
          const read = mode === "replay" && item.id === symbol
            ? (snap?.setup ?? EMPTY_SETUP)
            : (setupFor(item.id, interval, pack, packed, false, decisionSec) ?? EMPTY_SETUP);
          return [item.id, read];
        })) as Record<SymbolId, Setup>}
        spots={Object.fromEntries(SYMBOLS.map((item) => [item.id, priceOf(item.id)])) as Record<SymbolId, number | null>}
        atr={Object.fromEntries(SYMBOLS.map((item) => {
          const pack = packed.get(`${item.id}|${interval}`) ?? packed.get(`${item.id}|5m`);
          const last = pack?.ind.at(-1)?.atr ?? null;
          return [item.id, last];
        })) as Record<SymbolId, number | null>}
      />
    </div>
  );

  function setMode(next: Mode) {
    setBook((current) => ({ ...current, ui: { ...current.ui, mode: next } }));
  }
  function setSymbol(next: SymbolId) {
    setBook((current) => ({ ...current, ui: { ...current.ui, symbol: next } }));
  }
  function setIntervalTf(next: IntervalId) {
    const { book: nextBook, drops } = changeExecutionInterval(bookRef.current, next);
    if (Object.keys(drops).length > 0) {
      setTfDrops((prev) => {
        const merged = { ...prev, ...drops };
        for (const id of Object.keys(drops) as SymbolId[]) {
          const prior = dropTimers.current[id];
          if (prior) window.clearTimeout(prior);
          dropTimers.current[id] = window.setTimeout(() => {
            setTfDrops((state) => {
              if (!state[id]) return state;
              const copy = { ...state };
              delete copy[id];
              return copy;
            });
            delete dropTimers.current[id];
          }, 20000);
        }
        return merged;
      });
    }
    setBook(nextBook);
  }
  function setLot(id: SymbolId, value: string) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return;
    const lot = Math.min(100000, Math.max(1, parsed));
    setBook((current) => ({ ...current, lots: { ...current.lots, [id]: lot } }));
  }
  function stepCursor(delta: number) {
    if (!replay) return;
    const next = replay.snaps[Math.min(replay.snaps.length - 1, Math.max(0, safeIndex + delta))];
    if (next) setCursorTime(next.time);
  }
}

function Metric({ label, value, digits = 2, note }: { label: string; value: number | null | undefined; digits?: number; note?: string }) {
  const text = value == null ? "—" : value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (
    <div className="metric">
      <span>{label}{note ? ` · ${note}` : ""}</span>
      <strong className="num">{text}</strong>
    </div>
  );
}

function Level({ label, value, text }: { label: string; value?: number | null; text?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong className="num">{text ?? (value == null ? "—" : px(value))}</strong>
    </div>
  );
}

function pnlClass(value: number): string {
  return `num ${value > 0 ? "up" : value < 0 ? "down" : ""}`;
}

function changeOf(candles: Candle[]) {
  const last = candles[candles.length - 1].close;
  const day = istDateKey(candles[candles.length - 1].time);
  let ref = candles[0].open;
  for (const bar of candles) {
    if (istDateKey(bar.time) !== day) ref = bar.close;
  }
  const delta = last - ref;
  return { last, delta, pct: ref ? (delta / ref) * 100 : 0 };
}

function readSentiment(id: SymbolId, interval: IntervalId, pack: Pack, packed: Map<string, Pack>, asOf: number): Sentiment {
  const higher = higherInterval(interval);
  const higherPack = higher ? packed.get(`${id}|${higher}`) : undefined;
  const htf = higher && higherPack ? { interval: higher, candles: higherPack.candles, ind: higherPack.ind } : null;
  return sentimentAt(interval, pack.candles, pack.ind, pack.candles.length - 1, htf, asOf);
}

function setupFor(id: SymbolId, interval: IntervalId, pack: Pack | null, packed: Map<string, Pack>, positionOpen: boolean, nowSec: number): Setup | null {
  if (!pack) return null;
  const { lastClosed } = splitCandles(pack.candles.map((bar) => bar.time), interval, nowSec);
  const index = lastClosed >= 0 ? lastClosed : pack.candles.length - 1;
  const higher = higherInterval(interval);
  const higherPack = higher ? packed.get(`${id}|${higher}`) : undefined;
  const htf = higher && higherPack ? { interval: higher, candles: higherPack.candles, ind: higherPack.ind } : null;
  const bar = pack.candles[index];
  return evaluateSetupAt(id, interval, pack.candles, pack.ind, index, htf, positionOpen, Math.min(bar.time + INTERVAL_SECONDS[interval], nowSec));
}

async function pullFeeds(prev: Record<string, ClientFeed>): Promise<Record<string, ClientFeed>> {
  const jobs = SYMBOLS.flatMap((item) => INTERVALS.map((interval) => ({ symbol: item.id, interval })));
  const results = await Promise.all(jobs.map(async (job) => {
    try {
      const response = await fetch(`/api/candles?symbol=${job.symbol}&interval=${job.interval}`);
      return (await response.json()) as CandleResponse;
    } catch (error) {
      return {
        ok: false,
        symbol: job.symbol,
        interval: job.interval,
        error: error instanceof Error ? error.message : "Network error",
      } satisfies CandleResponse;
    }
  }));
  const next = { ...prev };
  for (const body of results) {
    const key = `${body.symbol}|${body.interval}`;
    if (!body.ok && prev[key]?.candles?.length) next[key] = { ...prev[key], stale: true, warning: body.error ?? prev[key].warning };
    else next[key] = { ...body, stale: false };
  }
  return next;
}

async function pullQuotes(): Promise<Partial<Record<SymbolId, QuoteTick>>> {
  try {
    const response = await fetch("/api/quotes");
    const body = await response.json() as { ok?: boolean; quotes?: Partial<Record<SymbolId, QuoteTick>> };
    if (!body.ok || !body.quotes) return {};
    return body.quotes;
  } catch {
    return {};
  }
}

function toFeeds(feeds: Record<string, ClientFeed>): Feed[] {
  const list: Feed[] = [];
  for (const item of SYMBOLS) {
    for (const interval of INTERVALS) {
      const row = feeds[`${item.id}|${interval}`];
      if (row?.candles?.length) list.push({ symbol: item.id, interval, candles: row.candles });
    }
  }
  return list;
}
