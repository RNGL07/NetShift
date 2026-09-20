/**
 * GET/POST /api/prices?tickers=VOO,SCHD
 *
 * Real market data from Stooq, a free CSV endpoint that needs no key. This is
 * deliberately **not** an LLM call: a language model asked for a share price
 * returns a confident number that may be months stale or simply invented, and
 * a portfolio valued from it would be wrong in a way the user cannot see.
 *
 * Results are cached in a shared table, because VOO's close is the same for
 * every user and re-fetching per user would be pointless load. A stale cached
 * price is still returned when the provider is unreachable — an approximate
 * portfolio value with a visible "last updated" beats a blank screen.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from './_lib/auth';
import { ApiError, logServerError, methodGuard, ok, withErrorHandling } from './_lib/http';
import { PRICES_RATE_LIMIT, consumeRateLimit } from './_lib/rateLimit';
import { serviceClient } from './_lib/supabase';

/** How long a cached price is served without re-fetching. */
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_TICKERS = 40;
const FETCH_TIMEOUT_MS = 8000;

export interface PriceEntry {
  ticker: string;
  price: number | null;
  asOfDate: string | null;
  fetchedAt: string | null;
  source: string;
  /** `true` when the figure came from cache because a live fetch failed. */
  stale: boolean;
  /** Set when no price could be found; shown next to the holding. */
  error: string | null;
}

interface CacheRow {
  ticker: string;
  price: number;
  as_of_date: string | null;
  fetched_at: string;
  source: string;
  last_error: string | null;
}

/** Only real ticker shapes; anything else is a 401(k) fund name, not a symbol. */
function normalizeTicker(raw: string): string | null {
  const ticker = raw.trim().toUpperCase();
  if (!ticker || ticker.length > 10) return null;
  return /^[A-Z][A-Z.-]*$/.test(ticker) ? ticker : null;
}

function parseTickers(req: VercelRequest): string[] {
  const fromQuery = req.query?.tickers;
  const fromBody = (req.body as { tickers?: unknown } | undefined)?.tickers;

  let raw: string[] = [];
  if (Array.isArray(fromBody)) {
    raw = fromBody.map(String);
  } else if (typeof fromBody === 'string') {
    raw = fromBody.split(',');
  } else if (Array.isArray(fromQuery)) {
    raw = fromQuery.flatMap((value) => String(value).split(','));
  } else if (typeof fromQuery === 'string') {
    raw = fromQuery.split(',');
  }

  const seen = new Set<string>();
  for (const entry of raw) {
    const ticker = normalizeTicker(entry);
    if (ticker) seen.add(ticker);
  }
  return [...seen].slice(0, MAX_TICKERS);
}

/**
 * Fetches one quote from Stooq.
 *
 * Stooq wants a lower-cased symbol with a `.us` suffix for US listings, and
 * returns a CSV whose price column is the literal string `N/D` for an unknown
 * symbol — which parses as NaN if you are not looking for it.
 */
async function fetchQuote(
  ticker: string,
): Promise<{ price: number; asOfDate: string | null } | null> {
  const symbol = `${ticker.toLowerCase()}.us`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/csv' },
    });
    if (!response.ok) return null;

    const csv = await response.text();
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return null;

    // Symbol,Date,Time,Open,High,Low,Close,Volume
    const columns = lines[1].split(',');
    if (columns.length < 7) return null;

    const close = Number(columns[6]);
    if (!Number.isFinite(close) || close <= 0) return null;

    const date = /^\d{4}-\d{2}-\d{2}$/.test(columns[1]) ? columns[1] : null;
    return { price: close, asOfDate: date };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export default withErrorHandling('prices', async (req: VercelRequest, res: VercelResponse) => {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;

  const user = await requireUser(req);
  await consumeRateLimit(user.id, PRICES_RATE_LIMIT);

  const tickers = parseTickers(req);
  if (tickers.length === 0) {
    throw new ApiError('invalid_request', 'Add at least one ticker symbol to look up.');
  }

  const db = serviceClient();
  const { data: cached } = await db
    .from('market_prices')
    .select('ticker, price, as_of_date, fetched_at, source, last_error')
    .in('ticker', tickers);

  const cacheByTicker = new Map<string, CacheRow>();
  for (const row of (cached ?? []) as CacheRow[]) cacheByTicker.set(row.ticker, row);

  const now = Date.now();
  const needsFetch = tickers.filter((ticker) => {
    const row = cacheByTicker.get(ticker);
    if (!row) return true;
    return now - new Date(row.fetched_at).getTime() > CACHE_TTL_MS;
  });

  // Fetched in parallel; one bad symbol must not delay the rest.
  const fetched = await Promise.all(
    needsFetch.map(async (ticker) => ({ ticker, quote: await fetchQuote(ticker) })),
  );

  const upserts: Record<string, unknown>[] = [];
  const freshByTicker = new Map<string, { price: number; asOfDate: string | null }>();

  for (const { ticker, quote } of fetched) {
    if (quote) {
      freshByTicker.set(ticker, quote);
      upserts.push({
        ticker,
        price: quote.price,
        as_of_date: quote.asOfDate,
        source: 'stooq',
        fetched_at: new Date().toISOString(),
        last_error: null,
        last_error_at: null,
      });
    } else if (!cacheByTicker.has(ticker)) {
      // Record the miss so a fund name typed into a ticker field is not
      // re-fetched on every page load.
      upserts.push({
        ticker,
        price: 0,
        source: 'stooq',
        fetched_at: new Date().toISOString(),
        last_error: 'not_found',
        last_error_at: new Date().toISOString(),
      });
    }
  }

  if (upserts.length > 0) {
    const { error } = await db.from('market_prices').upsert(upserts, { onConflict: 'ticker' });
    if (error) logServerError('prices.cache', error, { count: upserts.length });
  }

  const entries: PriceEntry[] = tickers.map((ticker) => {
    const fresh = freshByTicker.get(ticker);
    if (fresh) {
      return {
        ticker,
        price: fresh.price,
        asOfDate: fresh.asOfDate,
        fetchedAt: new Date().toISOString(),
        source: 'stooq',
        stale: false,
        error: null,
      };
    }

    const row = cacheByTicker.get(ticker);
    if (row && row.price > 0) {
      // A live fetch failed but we have something: serve it and mark it stale
      // rather than blanking the user's portfolio.
      return {
        ticker,
        price: row.price,
        asOfDate: row.as_of_date,
        fetchedAt: row.fetched_at,
        source: row.source,
        stale: now - new Date(row.fetched_at).getTime() > CACHE_TTL_MS,
        error: null,
      };
    }

    return {
      ticker,
      price: null,
      asOfDate: null,
      fetchedAt: null,
      source: 'stooq',
      stale: false,
      error:
        'No public price found for this symbol. Many workplace retirement funds are not exchange-traded — enter a price manually for those.',
    };
  });

  const anyFailed = entries.some((entry) => entry.price === null);
  const anyStale = entries.some((entry) => entry.stale);

  res.setHeader('Cache-Control', 'private, max-age=60');
  ok(res, {
    prices: entries,
    provider: 'stooq',
    // The UI surfaces this rather than silently showing old numbers.
    degraded: anyStale,
    notFound: entries.filter((entry) => entry.price === null).map((entry) => entry.ticker),
    message: anyFailed
      ? 'Some symbols could not be priced. Manual prices are used for those.'
      : anyStale
        ? 'Live prices were unavailable, so the most recent cached prices are shown.'
        : null,
  });
});
