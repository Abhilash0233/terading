import type { SymbolId } from "../src/lib/types.js";
import type { ChainContractQuote, ExpiryKind, OptionChainResponse, OptionRight } from "../src/lib/options/types.js";
import { nearestExpiry } from "../src/lib/options/expiry.js";

const UA = "Mozilla/5.0 (compatible; Terading/1.0; paper-trading)";

async function tryNse(symbol: SymbolId): Promise<{ contracts: ChainContractQuote[]; expiry: string; detail: string } | null> {
  const ticker = symbol === "NIFTY" ? "NIFTY" : "BANKNIFTY";
  const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${ticker}`;
  try {
    const warm = await fetch("https://www.nseindia.com/option-chain", {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(6000),
    });
    const cookie = warm.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ")
      ?? warm.headers.get("set-cookie")?.split(",").map((c) => c.split(";")[0].trim()).join("; ")
      ?? "";
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: "https://www.nseindia.com/option-chain",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const body = await response.json() as {
      records?: {
        expiryDates?: string[];
        data?: {
          strikePrice: number;
          expiryDate: string;
          CE?: { lastPrice?: number };
          PE?: { lastPrice?: number };
        }[];
      };
    };
    const expiryRaw = body.records?.expiryDates?.[0];
    if (!expiryRaw || !body.records?.data?.length) return null;
    const expiry = normalizeNseDate(expiryRaw);
    const contracts: ChainContractQuote[] = [];
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

async function tryGroww(symbol: SymbolId): Promise<{ contracts: ChainContractQuote[]; expiry: string; detail: string } | null> {
  const ticker = symbol === "NIFTY" ? "NIFTY" : "BANKNIFTY";
  const urls = [
    `https://groww.in/v1/api/stocks_fo_data/v1/option_chain_with_ltp?underlying=${ticker}&exchange=NSE`,
    `https://groww.in/v1/api/option_chain_api/v1/option_chain/exchange/NSE/${ticker.toLowerCase()}`,
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const body = await response.json() as Record<string, unknown>;
      const parsed = parseGrowwChain(body, nearestExpiry(symbol).expiry);
      if (parsed) return { ...parsed, detail: `Groww ${url}` };
    } catch {
      // try next
    }
  }
  return null;
}

function parseGrowwChain(body: Record<string, unknown>, fallbackExpiry: string): { contracts: ChainContractQuote[]; expiry: string } | null {
  const rows = (body.optionChain ?? body.data ?? body.chains ?? body) as unknown;
  if (!Array.isArray(rows)) return null;
  const contracts: ChainContractQuote[] = [];
  let expiry = fallbackExpiry;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const strike = Number(item.strikePrice ?? item.strike ?? item.strike_price);
    if (!Number.isFinite(strike)) continue;
    const exp = String(item.expiry ?? item.expiryDate ?? item.expiry_date ?? fallbackExpiry);
    expiry = normalizeLooseDate(exp) || fallbackExpiry;
    const ce = Number((item.CE as { ltp?: number })?.ltp ?? item.ceLtp ?? item.call_ltp);
    const pe = Number((item.PE as { ltp?: number })?.ltp ?? item.peLtp ?? item.put_ltp);
    if (Number.isFinite(ce) && ce > 0) contracts.push({ strike, right: "CE" as OptionRight, expiry, ltp: ce });
    if (Number.isFinite(pe) && pe > 0) contracts.push({ strike, right: "PE" as OptionRight, expiry, ltp: pe });
  }
  if (contracts.length === 0) return null;
  return { contracts, expiry };
}

function normalizeNseDate(raw: string): string {
  // "27-Oct-2026" or "27-OCT-2026"
  const m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return normalizeLooseDate(raw);
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const mm = months[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()];
  if (!mm) return raw;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

function normalizeLooseDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function fetchOptionChain(symbol: SymbolId): Promise<OptionChainResponse> {
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
      expiryKind: (nse.expiry === planned.expiry ? planned.kind : planned.kind) as ExpiryKind,
      contracts: nse.contracts,
      fetchedAt,
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
      fetchedAt,
    };
  }
  return {
    ok: false,
    symbol,
    expiry: planned.expiry,
    expiryKind: planned.kind,
    error: "No public option-chain quote loaded. Premiums below are modeled estimates, not exchange LTP.",
    fetchedAt,
  };
}
