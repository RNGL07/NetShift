/**
 * Investments.
 *
 * Prices come from `/api/prices`, a real market-data source — never from a
 * language model. A model asked for a share price returns a confident number
 * that may be months stale, and a portfolio valued from it is wrong in a way
 * the user cannot see.
 *
 * When the provider is unreachable the last cached price is still shown, with
 * its age visible. An approximate value with an honest timestamp beats a blank
 * screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  Badge,
  Button,
  Callout,
  ConfirmButton,
  DataTable,
  EmptyState,
  ErrorMessage,
  Grid,
  LoadingState,
  NumberField,
  Panel,
  Progress,
  SelectField,
  Stat,
  TextField,
  Workings,
} from '@/components/ui';
import { useAuth } from '@/features/auth/AuthContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, insertRow, updateRow } from '@/services/crud';
import { apiRequest, ApiClientError } from '@/lib/api/client';
import type { HoldingRow, InvestmentAccountRow } from '@/types/database';
import {
  ACCOUNT_KIND_LABELS,
  CASH_LIKE_KINDS,
  summarizePortfolio,
  tickersIn,
  type AccountKind,
  type InvestmentAccount,
  type PriceMap,
} from '@/lib/calc/portfolio';
import { projectGrowth } from '@/lib/calc/growth';
import { fmtMoney, fmtPct, fmtRelativeTime } from '@/lib/format';
import { num } from '@/lib/calc/money';
import './investments.css';

interface PriceResponse {
  prices: {
    ticker: string;
    price: number | null;
    asOfDate: string | null;
    fetchedAt: string | null;
    source: string;
    stale: boolean;
    error: string | null;
  }[];
  degraded: boolean;
  notFound: string[];
  message: string | null;
}

export function InvestmentsPage() {
  const { user } = useAuth();
  const {
    items: accountRows,
    loading,
    refresh,
  } = useCollection<InvestmentAccountRow>('investment_accounts', {
    orderBy: 'sort_order',
    ascending: true,
    isNull: ['archived_at'],
  });
  const { items: holdingRows, refresh: refreshHoldings } = useCollection<HoldingRow>('holdings', {
    orderBy: 'sort_order',
    ascending: true,
  });

  const [prices, setPrices] = useState<PriceMap>({});
  const [priceNotice, setPriceNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', kind: 'brokerage' as AccountKind, balance: '' });

  const accounts: InvestmentAccount[] = useMemo(
    () =>
      accountRows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as AccountKind,
        balance: row.balance,
        holdings: holdingRows
          .filter((holding) => holding.account_id === row.id)
          .map((holding) => ({
            id: holding.id,
            ticker: holding.ticker,
            name: holding.name,
            shares: holding.shares,
            costBasis: holding.cost_basis,
            manualPrice: holding.manual_price,
          })),
      })),
    [accountRows, holdingRows],
  );

  const summary = useMemo(() => summarizePortfolio(accounts, prices), [accounts, prices]);
  const tickers = useMemo(() => tickersIn(accounts), [accounts]);

  const refreshPrices = useCallback(async () => {
    if (tickers.length === 0) {
      setPriceNotice('Add a ticker symbol to a holding first.');
      return;
    }
    setRefreshing(true);
    setError(null);
    try {
      const response = await apiRequest<PriceResponse>('/api/prices', {
        method: 'GET',
        query: { tickers: tickers.join(',') },
      });
      const next: PriceMap = {};
      for (const entry of response.prices) {
        if (entry.price !== null) {
          next[entry.ticker] = {
            ticker: entry.ticker,
            price: entry.price,
            updatedAt: entry.fetchedAt ?? new Date().toISOString(),
            source: entry.source,
          };
        }
      }
      setPrices(next);
      setPriceNotice(response.message);
    } catch (caught) {
      // A price failure must not take the rest of the page with it.
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not reach the market-data service. Your manual prices are still being used.',
      );
    } finally {
      setRefreshing(false);
    }
  }, [tickers]);

  // Fetch once, when tickers first exist and nothing is cached yet. A ref
  // rather than a dependency on `prices` because including it would re-run the
  // effect on every successful fetch — refreshing after that is deliberate and
  // manual, via the button.
  const pricesFetched = useRef(false);
  useEffect(() => {
    if (pricesFetched.current || tickers.length === 0) return;
    pricesFetched.current = true;
    void refreshPrices();
  }, [tickers.length, refreshPrices]);

  async function addAccount() {
    if (!user) return;
    if (!draft.name.trim()) {
      setError('Give the account a name.');
      return;
    }
    const isCash = CASH_LIKE_KINDS.includes(draft.kind);
    try {
      await insertRow('investment_accounts', user.id, {
        name: draft.name.trim(),
        kind: draft.kind,
        balance: isCash ? num(draft.balance) : null,
        sort_order: accountRows.length,
      });
      setDraft({ name: '', kind: 'brokerage', balance: '' });
      setAdding(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that account.');
    }
  }

  if (loading) return <LoadingState label="Loading your accounts…" />;

  return (
    <>
      <PageHeader
        title="Investments"
        feature="investments"
        description="Accounts and holdings you track by hand, valued with real market prices."
        actions={
          <Button variant={adding ? 'ghost' : 'primary'} onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add an account'}
          </Button>
        }
      />

      <ErrorMessage>{error}</ErrorMessage>

      {adding && (
        <Panel title="New account">
          <Grid min={170}>
            <TextField
              label="Name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="401(k)"
            />
            <SelectField
              label="Type"
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as AccountKind })}
            >
              {(Object.keys(ACCOUNT_KIND_LABELS) as AccountKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {ACCOUNT_KIND_LABELS[kind]}
                </option>
              ))}
            </SelectField>
            {CASH_LIKE_KINDS.includes(draft.kind) && (
              <NumberField
                label="Balance"
                prefix="$"
                step="1"
                min="0"
                value={draft.balance}
                onChange={(event) => setDraft({ ...draft, balance: event.target.value })}
              />
            )}
          </Grid>
          <Button variant="primary" onClick={() => void addAccount()}>
            Add account
          </Button>
        </Panel>
      )}

      {accounts.length === 0 ? (
        <Panel>
          <EmptyState
            title="No accounts yet"
            icon="▲"
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add your first account
              </Button>
            }
          >
            Track a 401(k), an IRA, a brokerage, or cash. Holdings with a real ticker are priced
            automatically; workplace funds take a manual price.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel
            title="Your portfolio"
            actions={
              <Button variant="ghost" loading={refreshing} onClick={() => void refreshPrices()}>
                Refresh prices
              </Button>
            }
          >
            <Grid min={170}>
              <Stat label="Total value" value={fmtMoney(summary.total)} size="large" />
              {summary.totalGain !== null && (
                <Stat
                  label="Gain on what you entered"
                  value={fmtMoney(summary.totalGain)}
                  tone={summary.totalGain >= 0 ? 'positive' : 'negative'}
                  sub={
                    summary.totalCostBasis
                      ? `on ${fmtMoney(summary.totalCostBasis)} of cost basis`
                      : undefined
                  }
                />
              )}
              <Stat label="Accounts" value={String(accounts.length)} />
            </Grid>

            {summary.hasStalePrices && (
              <Callout tone="warning" icon="!">
                Some prices are more than a day old
                {summary.oldestPriceAt &&
                  ` — the oldest is from ${fmtRelativeTime(summary.oldestPriceAt)}`}
                . The values below use them, so treat the total as approximate until you refresh.
              </Callout>
            )}
            {summary.hasUnpricedHoldings && (
              <Callout tone="info" icon="i">
                Some holdings have no price. Workplace retirement funds usually have no public
                ticker — enter a price by hand for those and they will be included.
              </Callout>
            )}
            {priceNotice && <Callout tone="neutral">{priceNotice}</Callout>}

            {summary.byAsset.length > 0 && (
              <>
                <h4 className="ns-invest__subhead">Where it sits</h4>
                {summary.byAsset.map((entry) => (
                  <div key={entry.label} className="ns-invest__alloc">
                    <div className="ns-invest__alloc-head">
                      <span>{entry.label}</span>
                      <span className="tabular">
                        {fmtMoney(entry.value)} · {fmtPct(entry.pct, 1)}
                      </span>
                    </div>
                    <Progress value={entry.pct} label={`${entry.label} allocation`} />
                  </div>
                ))}
              </>
            )}
          </Panel>

          {summary.accounts.map((account) => (
            <AccountPanel
              key={account.accountId}
              account={account}
              raw={accountRows.find((row) => row.id === account.accountId)!}
              userId={user?.id ?? null}
              onChanged={async () => {
                await refresh();
                await refreshHoldings();
              }}
              onError={setError}
            />
          ))}

          <GrowthProjection startingBalance={summary.total} />
        </>
      )}

      <Callout tone="neutral">
        Prices come from a public market-data source and may be delayed. NetShift tracks what you
        enter — it is not connected to your accounts and cannot place trades. Nothing here is
        investment advice.
      </Callout>
    </>
  );
}

function AccountPanel({
  account,
  raw,
  userId,
  onChanged,
  onError,
}: {
  account: ReturnType<typeof summarizePortfolio>['accounts'][number];
  raw: InvestmentAccountRow;
  userId: string | null;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    ticker: '',
    name: '',
    shares: '',
    costBasis: '',
    manualPrice: '',
  });
  const [balance, setBalance] = useState(String(raw.balance ?? ''));
  const isCash = CASH_LIKE_KINDS.includes(account.kind);

  async function addHolding() {
    if (!userId) return;
    if (!draft.ticker.trim() && !draft.name.trim()) {
      onError('Enter a ticker symbol, or a name for a fund that has none.');
      return;
    }
    try {
      await insertRow('holdings', userId, {
        account_id: account.accountId,
        ticker: draft.ticker.trim().toUpperCase(),
        name: draft.name.trim() || null,
        shares: num(draft.shares),
        cost_basis: draft.costBasis === '' ? null : num(draft.costBasis),
        manual_price: draft.manualPrice === '' ? null : num(draft.manualPrice),
        sort_order: account.holdings.length,
      });
      setDraft({ ticker: '', name: '', shares: '', costBasis: '', manualPrice: '' });
      setAdding(false);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not add that holding.');
    }
  }

  return (
    <Panel
      title={account.name}
      description={ACCOUNT_KIND_LABELS[account.kind]}
      actions={
        <>
          <span className="ns-invest__total tabular">{fmtMoney(account.value)}</span>
          <ConfirmButton
            variant="link"
            onConfirm={async () => {
              if (!userId) return;
              await deleteRow('investment_accounts', account.accountId, userId);
              await onChanged();
            }}
          >
            Delete
          </ConfirmButton>
        </>
      }
    >
      {isCash ? (
        <div className="ns-invest__cash">
          <NumberField
            label="Balance"
            prefix="$"
            step="1"
            min="0"
            value={balance}
            onChange={(event) => setBalance(event.target.value)}
            onBlur={async () => {
              if (!userId) return;
              await updateRow('investment_accounts', account.accountId, userId, {
                balance: num(balance),
              });
              await onChanged();
            }}
          />
        </div>
      ) : (
        <>
          <DataTable
            caption={`${account.name} holdings`}
            columns={[
              {
                key: 'name',
                header: 'Holding',
                render: (holding) => (
                  <>
                    {holding.displayName}
                    {holding.price.source === 'manual' && <Badge tone="blue">manual price</Badge>}
                    {holding.price.stale && <Badge tone="amber">stale</Badge>}
                    {holding.price.source === 'none' && holding.shares > 0 && (
                      <Badge tone="rust">no price</Badge>
                    )}
                  </>
                ),
              },
              {
                key: 'shares',
                header: 'Shares',
                align: 'right',
                render: (holding) =>
                  holding.shares.toLocaleString(undefined, { maximumFractionDigits: 4 }),
              },
              {
                key: 'price',
                header: 'Price',
                align: 'right',
                render: (holding) =>
                  holding.price.source === 'none' ? (
                    <span className="ns-muted">—</span>
                  ) : (
                    <>
                      {fmtMoney(holding.price.price)}
                      {holding.price.updatedAt && (
                        <span className="ns-invest__stamp">
                          {fmtRelativeTime(holding.price.updatedAt)}
                        </span>
                      )}
                    </>
                  ),
              },
              {
                key: 'value',
                header: 'Value',
                align: 'right',
                render: (holding) => fmtMoney(holding.value),
              },
              {
                key: 'gain',
                header: 'Gain',
                align: 'right',
                render: (holding) =>
                  holding.gain === null ? (
                    <span className="ns-muted">—</span>
                  ) : (
                    <span style={{ color: holding.gain >= 0 ? 'var(--green)' : 'var(--rust)' }}>
                      {fmtMoney(holding.gain)}
                      {holding.gainPct !== null && ` (${fmtPct(holding.gainPct, 1)})`}
                    </span>
                  ),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (holding) => (
                  <ConfirmButton
                    variant="link"
                    onConfirm={async () => {
                      if (!userId) return;
                      await deleteRow('holdings', holding.holdingId, userId);
                      await onChanged();
                    }}
                  >
                    Remove
                  </ConfirmButton>
                ),
              },
            ]}
            rows={account.holdings}
            getKey={(holding) => holding.holdingId}
            empty={<p className="ns-muted">No holdings in this account yet.</p>}
          />

          {adding ? (
            <div className="ns-invest__add">
              <Grid min={140}>
                <TextField
                  label="Ticker"
                  value={draft.ticker}
                  onChange={(event) => setDraft({ ...draft, ticker: event.target.value })}
                  placeholder="VOO"
                  hint="Leave blank for a fund with no public symbol."
                />
                <TextField
                  label="Name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Target 2055 Fund"
                />
                <NumberField
                  label="Shares"
                  step="0.0001"
                  min="0"
                  value={draft.shares}
                  onChange={(event) => setDraft({ ...draft, shares: event.target.value })}
                />
                <NumberField
                  label="Cost basis"
                  prefix="$"
                  step="1"
                  min="0"
                  value={draft.costBasis}
                  onChange={(event) => setDraft({ ...draft, costBasis: event.target.value })}
                  hint="Optional — what you paid in total."
                />
                <NumberField
                  label="Manual price"
                  prefix="$"
                  step="0.01"
                  min="0"
                  value={draft.manualPrice}
                  onChange={(event) => setDraft({ ...draft, manualPrice: event.target.value })}
                  hint="Always wins over a fetched price."
                />
              </Grid>
              <div className="ns-review__actions">
                <Button variant="primary" onClick={() => void addHolding()}>
                  Add holding
                </Button>
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setAdding(true)}>Add a holding</Button>
          )}
        </>
      )}
    </Panel>
  );
}

function GrowthProjection({ startingBalance }: { startingBalance: number }) {
  const [monthly, setMonthly] = useState('500');
  const [rate, setRate] = useState('7');
  const [years, setYears] = useState('20');

  const result = useMemo(
    () =>
      projectGrowth({
        startingBalance,
        monthlyContribution: num(monthly),
        annualReturnPct: num(rate, 7),
        years: num(years, 20),
      }),
    [startingBalance, monthly, rate, years],
  );

  return (
    <Panel
      title="What it could grow to"
      description="A compound-growth projection from your current total. A steady return is an assumption, not a forecast."
    >
      <Grid min={150}>
        <NumberField
          label="Adding each month"
          prefix="$"
          step="50"
          min="0"
          value={monthly}
          onChange={(event) => setMonthly(event.target.value)}
        />
        <NumberField
          label="Assumed return"
          suffix="%"
          step="0.5"
          value={rate}
          onChange={(event) => setRate(event.target.value)}
        />
        <NumberField
          label="Years"
          step="1"
          min="1"
          max="60"
          value={years}
          onChange={(event) => setYears(event.target.value)}
        />
      </Grid>

      {result && (
        <>
          <Grid min={165}>
            <Stat
              label="Projected value"
              value={fmtMoney(result.futureValue)}
              size="large"
              estimated
            />
            <Stat label="You would have put in" value={fmtMoney(result.totalContributed)} />
            <Stat
              label="Growth"
              value={fmtMoney(result.totalGrowth)}
              tone={result.totalGrowth >= 0 ? 'positive' : 'negative'}
            />
          </Grid>

          <Workings summary="Show it year by year">
            <DataTable
              caption="Projection by year"
              columns={[
                { key: 'year', header: 'Year', render: (row) => String(row.year) },
                {
                  key: 'contributed',
                  header: 'Put in',
                  align: 'right',
                  render: (row) => fmtMoney(row.contributed),
                },
                {
                  key: 'balance',
                  header: 'Balance',
                  align: 'right',
                  render: (row) => fmtMoney(row.balance),
                },
              ]}
              rows={result.byYear.filter(
                (row) => row.year % 5 === 0 || row.year === result.byYear.length,
              )}
              getKey={(row) => String(row.year)}
            />
          </Workings>

          <Callout tone="neutral">
            Markets do not return a steady percentage. This shows what a constant rate would
            produce, which is useful for comparing choices and useless as a prediction.
          </Callout>
        </>
      )}
    </Panel>
  );
}
