/**
 * Feature 6 — Debt payoff with shift and overtime scenarios.
 *
 * Educational tooling, not advice. The comparison between snowball and
 * avalanche is presented with its real trade-off — avalanche usually costs
 * less, snowball is usually easier to stick to — rather than declaring one
 * correct.
 */

import { useMemo, useState } from 'react';
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
  SelectField,
  Stat,
  TextField,
} from '@/components/ui';
import { ProGate } from '@/components/ProGate';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, insertRow } from '@/services/crud';
import type { DebtRow } from '@/types/database';
import {
  DEBT_KIND_LABELS,
  buildPayoffPlan,
  compareStrategies,
  monthlyInterestCost,
  scenarioDelta,
  shiftsToMonthlyExtra,
  totalMinimums,
  type Debt,
  type DebtKind,
  type PayoffStrategy,
} from '@/lib/calc/debt';
import { effectiveRate } from '@/lib/calc/hours';
import { formatIsoDate, todayIso } from '@/lib/calc/dates';
import { fmtMoney, fmtMonths, fmtPct } from '@/lib/format';
import { num } from '@/lib/calc/money';
import { downloadCsv } from '@/lib/export';

export function DebtPage() {
  const { user } = useAuth();
  const { effective } = usePayProfile();
  const { items: debtRows, loading, refresh } = useCollection<DebtRow>('debts', {
    orderBy: 'balance',
    ascending: true,
    isNull: ['paid_off_at'],
  });

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    kind: 'credit_card' as DebtKind,
    balance: '',
    apr: '',
    minimumPayment: '',
    promoApr: '',
    promoEndDate: '',
  });
  const [strategy, setStrategy] = useState<PayoffStrategy>('avalanche');
  const [extraMonthly, setExtraMonthly] = useState('');
  const [oneTime, setOneTime] = useState('');
  const [extraShifts, setExtraShifts] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debts: Debt[] = useMemo(
    () =>
      debtRows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as DebtKind,
        balance: row.balance,
        apr: row.apr,
        minimumPayment: row.minimum_payment,
        promoApr: row.promo_apr,
        promoEndDate: row.promo_end_date,
      })),
    [debtRows],
  );

  // What one 8-hour overtime shift nets, using the user's own rate and their
  // estimated marginal withholding.
  const netPerShift = useMemo(() => {
    const rate = effectiveRate(effective.baseRate, effective.defaultDesignation, effective.premiums);
    return rate * 8 * effective.rules.overtimeMultiplier * (1 - effective.marginalDeductionPct / 100);
  }, [effective]);

  const extraFromShifts = shiftsToMonthlyExtra(netPerShift, num(extraShifts));

  const baseline = useMemo(
    () => buildPayoffPlan({ debts, strategy, startDate: todayIso() }),
    [debts, strategy],
  );

  const scenario = useMemo(
    () =>
      buildPayoffPlan({
        debts,
        strategy,
        extraMonthlyPayment: num(extraMonthly),
        oneTimeExtraPayment: num(oneTime),
        extraFromShiftsMonthly: extraFromShifts,
        startDate: todayIso(),
      }),
    [debts, strategy, extraMonthly, oneTime, extraFromShifts],
  );

  const comparison = useMemo(
    () =>
      compareStrategies({
        debts,
        extraMonthlyPayment: num(extraMonthly),
        oneTimeExtraPayment: num(oneTime),
        extraFromShiftsMonthly: extraFromShifts,
        startDate: todayIso(),
      }),
    [debts, extraMonthly, oneTime, extraFromShifts],
  );

  const delta = useMemo(() => scenarioDelta(baseline, scenario), [baseline, scenario]);
  const hasExtra = num(extraMonthly) > 0 || num(oneTime) > 0 || extraFromShifts > 0;

  async function addDebt() {
    if (!user) return;
    if (!draft.name.trim() || num(draft.balance) <= 0) {
      setError('Give the debt a name and a balance.');
      return;
    }
    if (draft.promoApr !== '' && !draft.promoEndDate) {
      setError('A promotional rate needs an end date, or it would apply forever.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await insertRow('debts', user.id, {
        name: draft.name.trim(),
        kind: draft.kind,
        balance: num(draft.balance),
        balance_as_of: todayIso(),
        apr: num(draft.apr),
        minimum_payment: num(draft.minimumPayment),
        promo_apr: draft.promoApr === '' ? null : num(draft.promoApr),
        promo_end_date: draft.promoEndDate || null,
      });
      setDraft({ name: '', kind: 'credit_card', balance: '', apr: '', minimumPayment: '', promoApr: '', promoEndDate: '' });
      setAdding(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that debt.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading your debts…" />;

  return (
    <>
      <PageHeader
        title="Debt payoff"
        feature="debt_scenarios"
        description="What your debts cost, how long they take, and what an extra shift a month would do to that."
        actions={
          <Button variant={adding ? 'ghost' : 'primary'} onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add a debt'}
          </Button>
        }
      />

      <ErrorMessage>{error}</ErrorMessage>

      {adding && (
        <Panel title="New debt">
          <Grid min={170}>
            <TextField
              label="Name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <SelectField
              label="Type"
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as DebtKind })}
            >
              {(Object.keys(DEBT_KIND_LABELS) as DebtKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {DEBT_KIND_LABELS[kind]}
                </option>
              ))}
            </SelectField>
            <NumberField
              label="Balance"
              prefix="$"
              step="1"
              min="0"
              value={draft.balance}
              onChange={(event) => setDraft({ ...draft, balance: event.target.value })}
            />
            <NumberField
              label="APR"
              suffix="%"
              step="0.01"
              min="0"
              max="100"
              value={draft.apr}
              onChange={(event) => setDraft({ ...draft, apr: event.target.value })}
            />
            <NumberField
              label="Minimum payment"
              prefix="$"
              step="1"
              min="0"
              value={draft.minimumPayment}
              onChange={(event) => setDraft({ ...draft, minimumPayment: event.target.value })}
            />
            <NumberField
              label="Promotional APR"
              suffix="%"
              step="0.01"
              min="0"
              max="100"
              value={draft.promoApr}
              onChange={(event) => setDraft({ ...draft, promoApr: event.target.value })}
              hint="Optional — a 0% intro rate, for instance."
            />
            <TextField
              label="Promotional rate ends"
              type="date"
              value={draft.promoEndDate}
              onChange={(event) => setDraft({ ...draft, promoEndDate: event.target.value })}
            />
          </Grid>
          <Button variant="primary" loading={saving} onClick={() => void addDebt()}>
            Save debt
          </Button>
        </Panel>
      )}

      {debts.length === 0 ? (
        <Panel>
          <EmptyState
            title="No debts tracked"
            icon="▼"
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add a debt
              </Button>
            }
          >
            Add what you owe and NetShift will show what it costs each month, how long it takes, and
            what an extra shift would change.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel title="What you owe">
            <Grid min={160}>
              <Stat
                label="Total balance"
                value={fmtMoney(debts.reduce((sum, debt) => sum + debt.balance, 0))}
              />
              <Stat label="Minimum payments" value={fmtMoney(totalMinimums(debts))} sub="per month" />
              <Stat
                label="Interest each month"
                value={fmtMoney(monthlyInterestCost(debts))}
                tone="negative"
                sub="What waiting costs"
              />
            </Grid>

            <DataTable
              caption="Your debts"
              columns={[
                { key: 'name', header: 'Debt', render: (debt: DebtRow) => debt.name },
                {
                  key: 'balance',
                  header: 'Balance',
                  align: 'right',
                  render: (debt: DebtRow) => fmtMoney(debt.balance),
                },
                {
                  key: 'apr',
                  header: 'APR',
                  align: 'right',
                  render: (debt: DebtRow) =>
                    debt.promo_apr !== null && debt.promo_end_date ? (
                      <span>
                        {fmtPct(debt.promo_apr, 2)} <Badge tone="blue">until {formatIsoDate(debt.promo_end_date)}</Badge>
                        <br />
                        <span className="ns-muted">then {fmtPct(debt.apr, 2)}</span>
                      </span>
                    ) : (
                      fmtPct(debt.apr, 2)
                    ),
                },
                {
                  key: 'minimum',
                  header: 'Minimum',
                  align: 'right',
                  render: (debt: DebtRow) => fmtMoney(debt.minimum_payment),
                },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (debt: DebtRow) => (
                    <ConfirmButton
                      variant="link"
                      onConfirm={async () => {
                        if (!user) return;
                        await deleteRow('debts', debt.id, user.id);
                        await refresh();
                      }}
                    >
                      Delete
                    </ConfirmButton>
                  ),
                },
              ]}
              rows={debtRows}
              getKey={(debt) => debt.id}
            />
          </Panel>

          <ProGate
            feature="debt_scenarios"
            preview={<Panel title="Payoff plan"><p>&nbsp;</p></Panel>}
          >
            <Panel title="Your payoff plan">
              <Grid min={180}>
                <SelectField
                  label="Order"
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value as PayoffStrategy)}
                >
                  <option value="avalanche">Avalanche — highest rate first</option>
                  <option value="snowball">Snowball — smallest balance first</option>
                  <option value="as_entered">The order I entered them</option>
                </SelectField>
                <NumberField
                  label="Extra each month"
                  prefix="$"
                  step="10"
                  min="0"
                  value={extraMonthly}
                  onChange={(event) => setExtraMonthly(event.target.value)}
                />
                <NumberField
                  label="One-off extra payment"
                  prefix="$"
                  step="50"
                  min="0"
                  value={oneTime}
                  onChange={(event) => setOneTime(event.target.value)}
                />
                <NumberField
                  label="Extra shifts a month"
                  step="0.5"
                  min="0"
                  value={extraShifts}
                  onChange={(event) => setExtraShifts(event.target.value)}
                  hint={
                    netPerShift > 0
                      ? `About ${fmtMoney(netPerShift)} net each, at your rate.`
                      : 'Set your hourly rate to price these.'
                  }
                />
              </Grid>

              {!scenario.amortizes ? (
                <Callout tone="danger" icon="!">
                  {scenario.warnings[0] ??
                    'These balances do not clear at the current payment. Increasing the monthly amount is what changes that.'}
                </Callout>
              ) : (
                <>
                  <Grid min={165}>
                    <Stat
                      label="Debt-free"
                      value={formatIsoDate(scenario.debtFreeDate)}
                      size="large"
                      tone="positive"
                      estimated
                      sub={fmtMonths(scenario.monthsToDebtFree)}
                    />
                    <Stat
                      label="Total interest"
                      value={fmtMoney(scenario.totalInterest)}
                      tone="negative"
                      estimated
                    />
                    <Stat
                      label="Paying each month"
                      value={fmtMoney(scenario.monthlyPayment)}
                      sub={
                        extraFromShifts > 0
                          ? `including ${fmtMoney(extraFromShifts)} from extra shifts`
                          : undefined
                      }
                    />
                  </Grid>

                  {hasExtra && baseline.amortizes && (
                    <Callout tone="success" icon="↗">
                      Against paying only the minimums: {delta.description}
                    </Callout>
                  )}

                  <DataTable
                    caption="Payoff order"
                    columns={[
                      { key: 'name', header: 'Debt', render: (row) => row.name },
                      {
                        key: 'paid',
                        header: 'Clear by',
                        render: (row) => formatIsoDate(row.payoffDate),
                      },
                      {
                        key: 'months',
                        header: 'Months',
                        align: 'right',
                        render: (row) => fmtMonths(row.monthsToPayoff),
                      },
                      {
                        key: 'interest',
                        header: 'Interest',
                        align: 'right',
                        render: (row) => fmtMoney(row.totalInterest),
                      },
                    ]}
                    rows={scenario.perDebt}
                    getKey={(row) => row.debtId}
                  />

                  <Button
                    variant="ghost"
                    onClick={() =>
                      downloadCsv(
                        'netshift-payoff-plan.csv',
                        ['Debt', 'Month', 'Date', 'Starting balance', 'Interest', 'Principal', 'Payment', 'Ending balance'],
                        scenario.perDebt.flatMap((debt) =>
                          debt.schedule.map((month) => [
                            debt.name,
                            month.monthIndex + 1,
                            month.date,
                            month.startingBalance,
                            month.interest,
                            month.principal,
                            month.payment,
                            month.endingBalance,
                          ]),
                        ),
                      )
                    }
                  >
                    Export the full schedule
                  </Button>
                </>
              )}
            </Panel>

            <Panel title="Snowball or avalanche?">
              {comparison.snowball.amortizes && comparison.avalanche.amortizes ? (
                <>
                  <Grid min={200}>
                    <Stat
                      label="Avalanche — highest rate first"
                      value={fmtMoney(comparison.avalanche.totalInterest)}
                      sub={`Debt-free ${formatIsoDate(comparison.avalanche.debtFreeDate)}`}
                      tone={comparison.interestSavedByAvalanche > 0 ? 'positive' : 'default'}
                      estimated
                    />
                    <Stat
                      label="Snowball — smallest balance first"
                      value={fmtMoney(comparison.snowball.totalInterest)}
                      sub={`Debt-free ${formatIsoDate(comparison.snowball.debtFreeDate)}`}
                      tone={comparison.interestSavedByAvalanche < 0 ? 'positive' : 'default'}
                      estimated
                    />
                  </Grid>
                  <Callout tone="info" icon="i">
                    {comparison.recommendation}
                  </Callout>
                </>
              ) : (
                <Callout tone="warning" icon="!">
                  {comparison.recommendation}
                </Callout>
              )}
            </Panel>
          </ProGate>
        </>
      )}

      <Callout tone="neutral">
        These projections assume the rates and payments stay as entered. They are an educational
        tool, not financial advice, and they do not account for fees, rate changes, or anything else
        your lender may do.
      </Callout>
    </>
  );
}
