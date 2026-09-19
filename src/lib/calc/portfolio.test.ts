import { describe, expect, it } from 'vitest';
import {
  resolvePrice,
  summarizePortfolio,
  tickersIn,
  valueAccount,
  type InvestmentAccount,
  type PriceMap,
} from './portfolio';

const now = new Date('2026-03-10T12:00:00Z');

const prices: PriceMap = {
  VOO: { ticker: 'VOO', price: 500, updatedAt: '2026-03-10T10:00:00Z', source: 'stooq' },
  SCHD: { ticker: 'SCHD', price: 28, updatedAt: '2026-03-01T10:00:00Z', source: 'stooq' },
};

const account = (over: Partial<InvestmentAccount> = {}): InvestmentAccount => ({
  id: 'a1',
  name: 'Brokerage',
  kind: 'brokerage',
  holdings: [{ id: 'h1', ticker: 'VOO', shares: 10 }],
  ...over,
});

describe('resolvePrice', () => {
  it('prefers a manual price over a fetched one', () => {
    const resolved = resolvePrice({ id: 'h', ticker: 'VOO', shares: 1, manualPrice: 480 }, prices, now);
    expect(resolved).toEqual({ price: 480, source: 'manual', updatedAt: null, stale: false });
  });

  it('uses a fresh market price', () => {
    const resolved = resolvePrice({ id: 'h', ticker: 'VOO', shares: 1 }, prices, now);
    expect(resolved.price).toBe(500);
    expect(resolved.source).toBe('market');
    expect(resolved.stale).toBe(false);
  });

  it('marks a price older than a day as stale but still uses it', () => {
    const resolved = resolvePrice({ id: 'h', ticker: 'SCHD', shares: 1 }, prices, now);
    expect(resolved.price).toBe(28);
    expect(resolved.stale).toBe(true);
  });

  it('reports no price for an unknown ticker rather than guessing', () => {
    const resolved = resolvePrice({ id: 'h', ticker: 'FUND-X', shares: 1 }, prices, now);
    expect(resolved).toEqual({ price: 0, source: 'none', updatedAt: null, stale: false });
  });

  it('is case-insensitive about tickers', () => {
    expect(resolvePrice({ id: 'h', ticker: ' voo ', shares: 1 }, prices, now).price).toBe(500);
  });
});

describe('valueAccount', () => {
  it('values holdings at shares × price', () => {
    expect(valueAccount(account(), prices, now).value).toBe(5000);
  });

  it('values a cash account from its balance', () => {
    const cash = account({ kind: 'cash', balance: 12_500, holdings: [] });
    expect(valueAccount(cash, prices, now).value).toBe(12_500);
  });

  it('computes gain against a cost basis when one is entered', () => {
    const withBasis = account({
      holdings: [{ id: 'h1', ticker: 'VOO', shares: 10, costBasis: 4000 }],
    });
    const holding = valueAccount(withBasis, prices, now).holdings[0];
    expect(holding.gain).toBe(1000);
    expect(holding.gainPct).toBe(25);
  });

  it('leaves gain null when no cost basis was entered', () => {
    expect(valueAccount(account(), prices, now).holdings[0].gain).toBeNull();
  });

  it('flags holdings that could not be priced', () => {
    const unpriced = account({ holdings: [{ id: 'h1', ticker: 'FUND-X', shares: 100 }] });
    expect(valueAccount(unpriced, prices, now).hasUnpricedHoldings).toBe(true);
  });

  it('flags stale prices', () => {
    const stale = account({ holdings: [{ id: 'h1', ticker: 'SCHD', shares: 100 }] });
    expect(valueAccount(stale, prices, now).hasStalePrices).toBe(true);
  });

  it('falls back to the name for a fund with no public ticker', () => {
    const fund = account({
      holdings: [{ id: 'h1', ticker: '', name: 'Target 2055 Fund', shares: 100, manualPrice: 25 }],
    });
    const holding = valueAccount(fund, prices, now).holdings[0];
    expect(holding.displayName).toBe('Target 2055 Fund');
    expect(holding.value).toBe(2500);
  });
});

describe('summarizePortfolio', () => {
  const accounts: InvestmentAccount[] = [
    account({ id: 'a', name: '401k', kind: 'traditional_401k', holdings: [{ id: 'h1', ticker: 'VOO', shares: 20 }] }),
    account({ id: 'b', name: 'Roth', kind: 'roth_ira', holdings: [{ id: 'h2', ticker: 'SCHD', shares: 100 }] }),
    account({ id: 'c', name: 'Savings', kind: 'cash', balance: 5000, holdings: [] }),
  ];

  it('totals every account', () => {
    // 20 × 500 + 100 × 28 + 5000
    expect(summarizePortfolio(accounts, prices, now).total).toBe(17_800);
  });

  it('breaks the portfolio down by account, asset, and account kind', () => {
    const summary = summarizePortfolio(accounts, prices, now);
    expect(summary.byAccount[0]).toEqual({ label: '401k', value: 10_000, pct: 56.18 });
    expect(summary.byAsset.map((a) => a.label)).toEqual(['VOO', 'Cash', 'SCHD']);
    expect(summary.byAccountKind.map((k) => k.kind)).toContain('traditional_401k');
  });

  it('sums percentages to 100', () => {
    const summary = summarizePortfolio(accounts, prices, now);
    const total = summary.byAsset.reduce((sum, a) => sum + a.pct, 0);
    expect(total).toBeCloseTo(100, 1);
  });

  it('reports a stale-data state without blocking the total', () => {
    const summary = summarizePortfolio(accounts, prices, now);
    expect(summary.hasStalePrices).toBe(true);
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.oldestPriceAt).toBe('2026-03-01T10:00:00Z');
  });

  it('handles an empty portfolio', () => {
    const summary = summarizePortfolio([], prices, now);
    expect(summary.total).toBe(0);
    expect(summary.byAsset).toEqual([]);
  });

  it('combines the same ticker held in more than one account', () => {
    const summary = summarizePortfolio(
      [
        account({ id: 'a', holdings: [{ id: '1', ticker: 'VOO', shares: 5 }] }),
        account({ id: 'b', holdings: [{ id: '2', ticker: 'VOO', shares: 5 }] }),
      ],
      prices,
      now,
    );
    expect(summary.byAsset).toEqual([{ label: 'VOO', value: 5000, pct: 100 }]);
  });
});

describe('tickersIn', () => {
  it('collects distinct tickers needing a price', () => {
    expect(
      tickersIn([
        account({ id: 'a', holdings: [{ id: '1', ticker: 'voo', shares: 1 }] }),
        account({ id: 'b', holdings: [{ id: '2', ticker: 'VOO', shares: 1 }, { id: '3', ticker: 'SCHD', shares: 1 }] }),
      ]),
    ).toEqual(['SCHD', 'VOO']);
  });

  it('skips holdings with a manual price and cash accounts', () => {
    expect(
      tickersIn([
        account({ id: 'a', holdings: [{ id: '1', ticker: 'VOO', shares: 1, manualPrice: 500 }] }),
        account({ id: 'b', kind: 'cash', balance: 100, holdings: [] }),
      ]),
    ).toEqual([]);
  });
});
