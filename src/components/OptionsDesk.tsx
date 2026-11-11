import { useEffect, useMemo, useRef, useState } from "react";
import { formatBarTime, inr, inrPlain, px, signedPx } from "../lib/format";
import { freshOptionsBook } from "../lib/options/book";
import { nearestExpiry, formatExpiryLabel } from "../lib/options/expiry";
import { flattenOption, optionUnrealized, stepOptions, type OptionFeed } from "../lib/options/execution";
import { markOption } from "../lib/options/pricing";
import type { OptionChainResponse, OptionsBook, OptionTrade } from "../lib/options/types";
import { describeOptionWatch } from "../lib/options/watch";
import { playTradeSound, soundForClose, type TradeSound } from "../lib/sounds";
import type { IntervalId, Setup, SymbolId } from "../lib/types";
import { SYMBOLS } from "../lib/types";

interface Notice {
  id: string;
  kind: "open" | "close";
  sound: TradeSound;
  title: string;
  body: string;
}

interface Props {
  setups: Partial<Record<SymbolId, Setup>>;
  spots: Partial<Record<SymbolId, number | null>>;
  atr: Partial<Record<SymbolId, number | null>>;
  lots: Record<SymbolId, number>;
  auto: boolean;
  activeInterval: IntervalId;
  feeds: OptionFeed[];
  live: boolean;
  readOnly: boolean;
}

export function OptionsDesk(props: Props) {
  const [book, setBook] = useState<OptionsBook>(freshOptionsBook);
  const [hydrated, setHydrated] = useState(false);
  const [chains, setChains] = useState<Partial<Record<SymbolId, OptionChainResponse>>>({});
  const [notices, setNotices] = useState<Notice[]>([]);
  const [now, setNow] = useState(() => new Date());
  const saved = useRef("");
  const seen = useRef<Set<string> | null>(null);
  const bookRef = useRef(book);
  bookRef.current = book;

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancel = false;
    void fetch("/api/options-book")
      .then((res) => res.json())
      .then((body) => {
        if (cancel) return;
        const loaded = body?.cash != null ? body as OptionsBook : freshOptionsBook();
        saved.current = JSON.stringify(loaded);
        setBook(loaded);
        setHydrated(true);
      })
      .catch(() => {
        if (cancel) return;
        setHydrated(true);
      });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const pull = () => {
      void Promise.all(SYMBOLS.map(async (item) => {
        try {
          const res = await fetch(`/api/option-chain?symbol=${item.id}`);
          return (await res.json()) as OptionChainResponse;
        } catch {
          return { ok: false, symbol: item.id, error: "Network error", fetchedAt: Date.now() } satisfies OptionChainResponse;
        }
      })).then((rows) => {
        const next: Partial<Record<SymbolId, OptionChainResponse>> = {};
        for (const row of rows) next[row.symbol] = row;
        setChains(next);
      });
    };
    pull();
    const id = window.setInterval(pull, 20000);
    return () => window.clearInterval(id);
  }, [hydrated]);

  const chainMeta = useMemo(() => {
    const listed: Partial<Record<SymbolId, number[]>> = {};
    const ltps: Partial<Record<SymbolId, Partial<Record<number, number>>>> = {};
    const markLtp: Partial<Record<SymbolId, number | null>> = {};
    for (const item of SYMBOLS) {
      const chain = chains[item.id];
      if (!chain?.ok || !chain.contracts?.length) {
        markLtp[item.id] = null;
        continue;
      }
      listed[item.id] = [...new Set(chain.contracts.map((c) => c.strike))];
      const byKey: Partial<Record<number, number>> = {};
      for (const c of chain.contracts) byKey[c.strike] = c.ltp;
      ltps[item.id] = byKey;
      markLtp[item.id] = null;
    }
    return { listed, ltps, markLtp };
  }, [chains]);

  const feedStamp = props.feeds.map((f) => {
    const last = f.candles.at(-1);
    return `${f.symbol}|${f.interval}:${last?.time ?? 0}:${last?.close ?? 0}:${last?.high ?? 0}:${last?.low ?? 0}`;
  }).join(";");
  const liveClockSec = Math.floor(now.getTime() / 1000);

  useEffect(() => {
    if (!hydrated || !props.readOnly) return;
    const id = window.setInterval(() => {
      void fetch("/api/options-book")
        .then((res) => (res.ok ? res.json() : null))
        .then((remote: OptionsBook | null) => {
          if (remote?.cash == null) return;
          setBook((current) => (JSON.stringify(remote) === JSON.stringify(current) ? current : remote));
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(id);
  }, [hydrated, props.readOnly]);

  useEffect(() => {
    if (!hydrated || !props.live || props.readOnly) return;
    if (props.feeds.length === 0) return;
    setBook((current) => {
      const next = stepOptions(current, props.feeds, {
        setups: props.setups,
        atr: props.atr,
        chainLtp: Object.fromEntries(SYMBOLS.map((item) => {
          const pos = current.symbols[item.id].position ?? current.symbols[item.id].pending;
          if (!pos) return [item.id, null];
          const chain = chains[item.id];
          const hit = chain?.contracts?.find((c) => c.strike === pos.strike && c.right === pos.right);
          return [item.id, hit?.ltp ?? null];
        })) as Partial<Record<SymbolId, number | null>>,
        listedStrikes: chainMeta.listed,
        chainLtps: chainMeta.ltps,
        lots: props.lots,
        auto: props.auto,
        active: props.activeInterval,
        nowSec: Date.now() / 1000,
        now: new Date(),
      });
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [hydrated, feedStamp, props.live, props.readOnly, props.auto, props.activeInterval, props.lots.NIFTY, props.lots.BANKNIFTY, props.setups, chains, chainMeta.listed, chainMeta.ltps, props.feeds, props.atr, liveClockSec]);

  useEffect(() => {
    if (!hydrated || props.readOnly) return;
    const serial = JSON.stringify(book);
    if (serial === saved.current) return;
    const handle = window.setTimeout(() => {
      saved.current = serial;
      void fetch("/api/options-book", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: serial,
      });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [book, hydrated, props.readOnly]);

  useEffect(() => {
    if (!hydrated || !props.live) return;
    const next = new Set<string>();
    const events: Notice[] = [];
    for (const item of SYMBOLS) {
      const position = book.symbols[item.id].position;
      if (position) {
        const key = `opt-open:${position.id}`;
        next.add(key);
        if (seen.current && !seen.current.has(key)) {
          events.push({
            id: key,
            kind: "open",
            sound: "open",
            title: `${item.name} ${position.right} ${px(position.strike)} bought`,
            body: `Premium ${px(position.premiumEntry)} · stop ${px(position.premiumStop)} · target ${px(position.premiumTarget)} · ${position.premiumSource === "chain" ? "chain LTP" : "modeled estimate"}`,
          });
        }
      }
    }
    for (const trade of book.trades) {
      const key = `opt-close:${trade.id}`;
      next.add(key);
      if (seen.current && !seen.current.has(key)) {
        const name = trade.symbol === "NIFTY" ? "Nifty" : "Bank Nifty";
        events.push({
          id: key,
          kind: "close",
          sound: soundForClose(trade.reason, trade.pnl),
          title: `${name} ${trade.right} ${px(trade.strike)} closed · ${trade.reason}`,
          body: `Exit premium ${px(trade.premiumExit)} from ${px(trade.premiumEntry)}. ${signedPx(trade.points)} pts, ${inr(trade.pnl)}.`,
        });
      }
    }
    if (seen.current && events.length > 0) {
      setNotices((current) => [...events, ...current].slice(0, 4));
      for (const event of events) playTradeSound(event.sound);
      for (const event of events) {
        window.setTimeout(() => {
          setNotices((current) => current.filter((n) => n.id !== event.id));
        }, 14000);
      }
    }
    seen.current = next;
  }, [hydrated, props.live, book]);

  const watches = SYMBOLS.map((item) => {
    const setup = props.setups[item.id]!;
    const state = book.symbols[item.id];
    const spot = props.spots[item.id] ?? null;
    const contract = state.position ?? state.pending;
    const chain = chains[item.id];
    const chainLtp = contract && chain?.contracts
      ? chain.contracts.find((c) => c.strike === contract.strike && c.right === contract.right)?.ltp ?? null
      : null;
    const mark = contract && spot != null
      ? markOption({
        symbol: item.id,
        spot,
        strike: contract.strike,
        right: contract.right,
        expiry: contract.expiry,
        atr: props.atr[item.id] ?? null,
        chainLtp,
      })
      : null;
    return {
      id: item.id,
      name: item.name,
      expiry: nearestExpiry(item.id),
      chain,
      mark,
      ...describeOptionWatch({
        auto: props.auto,
        position: state.position,
        pending: state.pending,
        setup,
        markPremium: mark?.premium ?? null,
        spot,
      }),
    };
  });

  const openRows = SYMBOLS.flatMap((item) => {
    const position = book.symbols[item.id].position;
    if (!position) return [];
    const spot = props.spots[item.id] ?? position.indexEntry;
    const chain = chains[item.id];
    const chainLtp = chain?.contracts?.find((c) => c.strike === position.strike && c.right === position.right)?.ltp ?? null;
    const mark = markOption({
      symbol: item.id,
      spot,
      strike: position.strike,
      right: position.right,
      expiry: position.expiry,
      atr: props.atr[item.id] ?? null,
      chainLtp,
    });
    return [{ position, mark, ...optionUnrealized(position, mark.premium) }];
  });

  const trades = [...book.trades].sort((a, b) => b.closedAt - a.closedAt || b.openedAt - a.openedAt);
  const premiumNote = watches.some((w) => w.chain?.ok)
    ? "Premiums use a public chain LTP when the quote loads; otherwise a labeled Black–Scholes estimate."
    : "No public option-chain quote loaded right now. Premiums are labeled Black–Scholes estimates, not exchange LTP.";

  return (
    <section className="options-desk" data-testid="options-desk" aria-label="Options paper trading">
      <div className="options-head">
        <div>
          <h2>Options paper desk</h2>
          <p>Buy-only CE/PE mapped from the index scalp above. Separate book from the futures-style blotter. Never sells premium.</p>
        </div>
        <div className="options-cash">
          <span>Options cash</span>
          <strong className="num">{inrPlain(book.cash)}</strong>
        </div>
      </div>

      <p className="options-note" data-testid="options-premium-source">{premiumNote}</p>

      <div className="watch options-watch" data-testid="options-watch">
        {watches.map((row) => (
          <div key={row.id} className={`watch-row ${row.tone}`} data-testid={`options-watch-${row.id}`} data-tone={row.tone}>
            <strong>{row.name}</strong>
            <span className="watch-label">{row.label}</span>
            <p>
              {row.reason}
              <small className="expiry-meta">
                {row.expiry.label} · {formatExpiryLabel(row.expiry.expiry)} · {row.expiry.daysLeft === 0 ? "expiry day" : `${row.expiry.daysLeft}d left`}
                {row.mark ? ` · ${row.mark.source === "chain" ? "chain LTP" : "estimate"} ${px(row.mark.premium)}` : ""}
              </small>
            </p>
          </div>
        ))}
      </div>

      <div className="options-grid">
        <article className="panel">
          <div className="card-head">
            <h2>Open option buys</h2>
            <span className="num">{openRows.length}</span>
          </div>
          {openRows.length === 0 ? <p className="empty">Flat. One long option per index.</p> : (
            <table className="positions" data-testid="options-positions">
              <thead>
                <tr>
                  <th>Index</th><th>Contract</th><th>Entry</th><th>Mark</th><th>U.P&L</th><th></th>
                </tr>
              </thead>
              <tbody>
                {openRows.map(({ position, mark, pnl }) => (
                  <tr key={position.id}>
                    <td>{position.symbol === "NIFTY" ? "Nifty" : "Bank"} {position.interval}</td>
                    <td className="up">{position.right} {px(position.strike)} · {formatExpiryLabel(position.expiry)}</td>
                    <td>{px(position.premiumEntry)}{position.premiumSource === "estimate" ? " est." : ""}</td>
                    <td data-testid={`options-mark-${position.symbol}`}>{px(mark.premium)}{mark.source === "estimate" ? " est." : ""}</td>
                    <td className={pnl > 0 ? "num up" : pnl < 0 ? "num down" : "num"}>{inr(pnl)}</td>
                    <td>
                      <button
                        type="button"
                        className="flatten"
                        disabled={props.readOnly}
                        onClick={() => setBook((current) => flattenOption(current, position.symbol, mark.premium, Date.now() / 1000))}
                      >
                        Flatten
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="lot-note">P&L = premium points × lot ({props.lots.NIFTY} / {props.lots.BANKNIFTY}). Expiry-day square-off from 15:20 IST.</p>
        </article>

        <article className="panel">
          <div className="card-head">
            <h2>Options blotter</h2>
            <span className="num">{trades.length}</span>
          </div>
          {trades.length === 0 ? <p className="empty">No option buys yet. Fills only after a later candle trades through the index entry.</p> : (
            <div className="blotter-wrap">
              <table className="blotter" data-testid="options-blotter">
                <thead>
                  <tr>
                    <th>In</th><th>Out</th><th>Contract</th><th>Entry</th><th>Exit</th><th>Pts</th><th>P&L</th><th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade: OptionTrade) => (
                    <tr key={trade.id}>
                      <td>{formatBarTime(trade.openedAt)}</td>
                      <td>{formatBarTime(trade.closedAt)}</td>
                      <td className="up">{trade.symbol === "NIFTY" ? "Nifty" : "Bank"} {trade.right} {px(trade.strike)}</td>
                      <td>{px(trade.premiumEntry)}{trade.premiumSource === "estimate" ? " est." : ""}</td>
                      <td>{px(trade.premiumExit)}</td>
                      <td className={trade.points > 0 ? "num up" : trade.points < 0 ? "num down" : "num"}>{signedPx(trade.points)}</td>
                      <td className={trade.pnl > 0 ? "num up" : trade.pnl < 0 ? "num down" : "num"}>{inr(trade.pnl)}</td>
                      <td>{trade.reason.toUpperCase()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </div>

      {notices.length > 0 && (
        <div className="toasts options-toasts" data-testid="options-toasts">
          {notices.map((notice) => (
            <button
              key={notice.id}
              type="button"
              className={`toast ${notice.kind === "open" ? "open" : "close"}`}
              data-testid="options-trade-popup"
              onClick={() => setNotices((current) => current.filter((n) => n.id !== notice.id))}
            >
              <strong>{notice.title}</strong>
              <span>{notice.body}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
