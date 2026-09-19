/**
 * Investments — portfolio value and allocation.
 *
 * Prices are treated as facts with an age. A stale price is still shown (an
 * approximate portfolio value beats a blank screen when the market-data
 * provider is down), but it is always labelled, and a manual override always
 * wins over a fetched price because the user knows their 401(k) fund better
 * than any ticker lookup does.
 */

import { nonNegative, roundMoney, roundTo } from './money';

export type AccountKind =
  | 'traditional_401k'
  | 'roth_401k'
  | 'traditional_ira'
  | 'roth_ira'
  | 'brokerage'
  | 'hsa'
  | 'cash'
  | 'custom';

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  traditional_401k: '401(k)',
  roth_401k: 'Roth 401(k)',
  traditional_ira: 'Traditional IRA',
  roth_ira: 'Roth IRA',
  brokerage: 'Brokerage',
  hsa: 'HSA',
  cash: 'Cash / money market',
  custom: 'Custom',
};

/** Accounts that hold a single balance rather than tickers. */
export const CASH_LIKE_KINDS: AccountKind[] = ['cash'];

export interface Holding {
  id: string;
  ticker: string;
  /** Free-text name for funds with no public ticker. */
  name?: string | null;
  shares: number;
  costBasis?: number | null;
  /** User-entered price. Always wins over a fetched one. */
  manualPrice?: number | null;
}

export interface InvestmentAccount {
  id: string;
  name: string;
  kind: AccountKind;
  /** Used when the account is cash-like. */
  balance?: number | null;
  holdings: Holding[];
}

export interface PriceQuote {
  ticker: string;
  price: number;
  /** ISO timestamp of when the price was retrieved. */
  updatedAt: string;
  source: string;
}

export type PriceMap = Record<string, PriceQuote>;

export const STALE_PRICE_HOURS = 24;

export interface ResolvedPrice {
  price: number;
  source: 'manual' | 'market' | 'none';
  updatedAt: string | null;
  stale: boolean;
}

/** Picks the price to value a holding at, and says where it came from. */
export function resolvePrice(
  holding: Holding,
  prices: PriceMap,
  now: Date = new Date(),
): ResolvedPrice {
  const manual = holding.manualPrice;
  if (manual !== null && manual !== undefined && manual > 0) {
    return { price: manual, source: 'manual', updatedAt: null, stale: false };
  }

  const ticker = (holding.ticker || '').trim().toUpperCase();
  const quote = ticker ? prices[ticker] : undefined;
  if (quote && quote.price > 0) {
    const ageMs = now.getTime() - new Date(quote.updatedAt).getTime();
    const stale = !Number.isFinite(ageMs) || ageMs > STALE_PRICE_HOURS * 3_600_000;
    return { price: quote.price, source: 'market', updatedAt: quote.updatedAt, stale };
  }

  return { price: 0, source: 'none', updatedAt: null, stale: false };
}

export interface HoldingValue {
  holdingId: string;
  ticker: string;
  displayName: string;
  shares: number;
  price: ResolvedPrice;
  value: number;
  costBasis: number | null;
  gain: number | null;
  gainPct: number | null;
}

export interface AccountValue {
  accountId: string;
  name: string;
  kind: AccountKind;
  value: number;
  holdings: HoldingValue[];
  /** `true` when at least one holding could not be priced. */
  hasUnpricedHoldings: boolean;
  hasStalePrices: boolean;
}

export function valueAccount(
  account: InvestmentAccount,
  prices: PriceMap,
  now: Date = new Date(),
): AccountValue {
  if (CASH_LIKE_KINDS.includes(account.kind)) {
    return {
      accountId: account.id,
      name: account.name,
      kind: account.kind,
      value: roundMoney(nonNegative(account.balance)),
      holdings: [],
      hasUnpricedHoldings: false,
      hasStalePrices: false,
    };
  }

  const holdings: HoldingValue[] = account.holdings.map((holding) => {
    const price = resolvePrice(holding, prices, now);
    const shares = nonNegative(holding.shares);
    const value = roundMoney(shares * price.price);
    const costBasis =
      holding.costBasis !== null && holding.costBasis !== undefined
        ? roundMoney(holding.costBasis)
        : null;
    const gain = costBasis !== null && price.source !== 'none' ? roundMoney(value - costBasis) : null;
    return {
      holdingId: holding.id,
      ticker: (holding.ticker || '').trim().toUpperCase(),
      displayName: holding.name || (holding.ticker || '').trim().toUpperCase() || 'Unnamed holding',
      shares,
      price,
      value,
      costBasis,
      gain,
      gainPct: gain !== null && costBasis && costBasis > 0 ? roundTo((gain / costBasis) * 100, 2) : null,
    };
  });

  return {
    accountId: account.id,
    name: account.name,
    kind: account.kind,
    value: roundMoney(holdings.reduce((sum, h) => sum + h.value, 0)),
    holdings,
    hasUnpricedHoldings: holdings.some((h) => h.shares > 0 && h.price.source === 'none'),
    hasStalePrices: holdings.some((h) => h.price.stale),
  };
}

export interface PortfolioSummary {
  accounts: AccountValue[];
  total: number;
  byAccount: { label: string; value: number; pct: number }[];
  byAsset: { label: string; value: number; pct: number }[];
  byAccountKind: { kind: AccountKind; label: string; value: number; pct: number }[];
  totalCostBasis: number | null;
  totalGain: number | null;
  hasUnpricedHoldings: boolean;
  hasStalePrices: boolean;
  oldestPriceAt: string | null;
}

export function summarizePortfolio(
  accounts: readonly InvestmentAccount[],
  prices: PriceMap,
  now: Date = new Date(),
): PortfolioSummary {
  const valued = accounts.map((a) => valueAccount(a, prices, now));
  const total = roundMoney(valued.reduce((sum, a) => sum + a.value, 0));

  const assetMap = new Map<string, number>();
  const kindMap = new Map<AccountKind, number>();
  let costBasisTotal = 0;
  let costBasisCount = 0;
  let oldestPriceAt: string | null = null;

  for (const account of valued) {
    kindMap.set(account.kind, roundMoney((kindMap.get(account.kind) ?? 0) + account.value));
    if (CASH_LIKE_KINDS.includes(account.kind)) {
      assetMap.set('Cash', roundMoney((assetMap.get('Cash') ?? 0) + account.value));
      continue;
    }
    for (const holding of account.holdings) {
      const label = holding.displayName || '—';
      assetMap.set(label, roundMoney((assetMap.get(label) ?? 0) + holding.value));
      if (holding.costBasis !== null) {
        costBasisTotal = roundMoney(costBasisTotal + holding.costBasis);
        costBasisCount += 1;
      }
      const updatedAt = holding.price.updatedAt;
      if (updatedAt && (oldestPriceAt === null || updatedAt < oldestPriceAt)) {
        oldestPriceAt = updatedAt;
      }
    }
  }

  const pct = (value: number) => (total > 0 ? roundTo((value / total) * 100, 2) : 0);

  return {
    accounts: valued,
    total,
    byAccount: valued
      .map((a) => ({ label: a.name, value: a.value, pct: pct(a.value) }))
      .sort((a, b) => b.value - a.value),
    byAsset: [...assetMap.entries()]
      .map(([label, value]) => ({ label, value, pct: pct(value) }))
      .sort((a, b) => b.value - a.value),
    byAccountKind: [...kindMap.entries()]
      .map(([kind, value]) => ({ kind, label: ACCOUNT_KIND_LABELS[kind], value, pct: pct(value) }))
      .sort((a, b) => b.value - a.value),
    totalCostBasis: costBasisCount > 0 ? costBasisTotal : null,
    totalGain: costBasisCount > 0 ? roundMoney(total - costBasisTotal) : null,
    hasUnpricedHoldings: valued.some((a) => a.hasUnpricedHoldings),
    hasStalePrices: valued.some((a) => a.hasStalePrices),
    oldestPriceAt,
  };
}

/** Every distinct ticker in the portfolio, for a price refresh request. */
export function tickersIn(accounts: readonly InvestmentAccount[]): string[] {
  const set = new Set<string>();
  for (const account of accounts) {
    if (CASH_LIKE_KINDS.includes(account.kind)) continue;
    for (const holding of account.holdings) {
      const ticker = (holding.ticker || '').trim().toUpperCase();
      // A manual price means the user has already told us what it is worth.
      if (ticker && !(holding.manualPrice && holding.manualPrice > 0)) set.add(ticker);
    }
  }
  return [...set].sort();
}
