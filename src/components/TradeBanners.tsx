import { useEffect, useState } from "react";

/** A trade alert that stays on screen until the user closes it. Saved per browser so a reload keeps it. */
export interface TradeBanner {
  id: string;
  kind: "open" | "close";
  /** "profit" or "loss" colours a closed trade; ignored for opens. */
  outcome?: "profit" | "loss";
  title: string;
  /** Short facts shown as labelled cells, e.g. { label: "Entry time", value: "25 Nov 21:35 IST" }. */
  facts: { label: string; value: string }[];
}

const LIMIT = 30;

function load(key: string): TradeBanner[] {
  try {
    const raw = localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as TradeBanner[]) : [];
    return Array.isArray(list) ? list.slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function useTradeBanners(storageKey: string) {
  const [banners, setBanners] = useState<TradeBanner[]>(() => load(storageKey));
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(banners));
    } catch {
      /* ignore quota / private mode */
    }
  }, [banners, storageKey]);
  return {
    banners,
    add(next: TradeBanner[]) {
      setBanners((current) => {
        const fresh = next.filter((item) => !current.some((old) => old.id === item.id));
        return [...fresh, ...current].slice(0, LIMIT);
      });
    },
    close(id: string) {
      setBanners((current) => current.filter((item) => item.id !== id));
    },
    closeAll() {
      setBanners([]);
    },
  };
}

export function TradeBanners(props: { banners: TradeBanner[]; onClose: (id: string) => void; onCloseAll: () => void }) {
  if (props.banners.length === 0) return null;
  return (
    <section className="trade-banners" aria-label="Trade alerts" aria-live="polite">
      {props.banners.length > 1 && (
        <div className="trade-banners-head">
          <span>{props.banners.length} unread trade alerts</span>
          <button type="button" onClick={props.onCloseAll}>Close all</button>
        </div>
      )}
      {props.banners.map((banner) => (
        <div
          key={banner.id}
          className={`trade-banner ${banner.kind}${banner.outcome ? ` ${banner.outcome}` : ""}`}
          role="status"
          data-testid="trade-banner"
        >
          <strong>{banner.title}</strong>
          <dl>
            {banner.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
          <button type="button" className="trade-banner-close" aria-label="Close alert" title="Close" onClick={() => props.onClose(banner.id)}>
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
