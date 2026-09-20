/**
 * Feature 2 — Paycheck Plan.
 *
 * Everything here is payday-to-payday. A bill belongs to the plan whose window
 * `[payday, next payday)` contains its due date, which is what makes
 * double-counting structurally impossible rather than merely unlikely — a bill
 * due on a payday lands in the *next* plan, never both.
 */

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  Badge,
  Button,
  Callout,
  CheckboxField,
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
  Workings,
  WorkingsLine,
} from '@/components/ui';
import { LimitNotice } from '@/components/ProGate';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, insertRow } from '@/services/crud';
import type { BillRow } from '@/types/database';
import { buildPaycheckPlan, type Bill, type BillCadence } from '@/lib/calc/paycheckPlan';
import {
  formatIsoDate,
  formatIsoDateShort,
  nextPayday,
  paydaySeries,
  todayIso,
} from '@/lib/calc/dates';
import { fmtMoney } from '@/lib/format';
import { num } from '@/lib/calc/money';
import { PLAN_LIMITS } from '@/config/plans';
import './plan.css';

const CADENCE_LABELS: Record<BillCadence, string> = {
  once: 'One-off',
  weekly: 'Weekly',
  biweekly: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Yearly',
};

export function PaycheckPlanPage() {
  const { user } = useAuth();
  const { effective } = usePayProfile();
  const { isPro } = useEntitlement();
  const {
    items: billRows,
    loading,
    refresh,
  } = useCollection<BillRow>('bills', {
    orderBy: 'due_date',
    ascending: true,
    isNull: ['archived_at'],
  });

  const [periodIndex, setPeriodIndex] = useState(0);
  const [startingBalance, setStartingBalance] = useState('');
  const [expectedGross, setExpectedGross] = useState('');
  const [expectedDeductions, setExpectedDeductions] = useState('');
  const [plannedSavings, setPlannedSavings] = useState('');
  const [plannedDebt, setPlannedDebt] = useState('');
  const [safetyBuffer, setSafetyBuffer] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Free users get the current and the next paycheck; Pro can look further out.
  const maxPeriods = PLAN_LIMITS[isPro ? 'pro' : 'free'].paycheckPlans;
  const periodCount = Number.isFinite(maxPeriods) ? Math.min(maxPeriods, 12) : 12;

  const paydays = useMemo(() => {
    const anchor = effective.anchorPayday;
    if (!anchor) return [];
    // Roll the anchor forward to the first payday on or after today, so the
    // "current" plan is genuinely the current one however old the anchor is.
    let cursor = anchor;
    let guard = 0;
    const today = todayIso();
    while (cursor < today && guard++ < 500) {
      cursor = nextPayday(cursor, effective.payFrequency);
    }
    return paydaySeries(cursor, effective.payFrequency, periodCount);
  }, [effective.anchorPayday, effective.payFrequency, periodCount]);

  const bills: Bill[] = useMemo(
    () =>
      billRows.map((row) => ({
        id: row.id,
        name: row.name,
        amount: row.amount,
        dueDate: row.due_date,
        cadence: row.cadence,
        endDate: row.end_date,
        essential: row.essential,
      })),
    [billRows],
  );

  const payday = paydays[periodIndex] ?? null;

  const plan = useMemo(() => {
    if (!payday) return null;
    return buildPaycheckPlan({
      payPeriodStart: payday,
      payPeriodEnd: payday,
      payday,
      frequency: effective.payFrequency,
      expectedGross: num(expectedGross),
      expectedDeductions: expectedDeductions === '' ? null : num(expectedDeductions),
      deductionPct: effective.deductionPct,
      perDiem: 0,
      startingAvailableBalance: num(startingBalance),
      bills,
      plannedSavings: num(plannedSavings),
      plannedDebtPayments: num(plannedDebt),
      safetyBuffer: num(safetyBuffer),
    });
  }, [
    payday,
    effective.payFrequency,
    effective.deductionPct,
    expectedGross,
    expectedDeductions,
    startingBalance,
    bills,
    plannedSavings,
    plannedDebt,
    safetyBuffer,
  ]);

  if (loading) return <LoadingState label="Loading your plan…" />;

  if (!effective.anchorPayday) {
    return (
      <>
        <PageHeader title="Paycheck plan" feature="paycheck_forecast" />
        <Panel>
          <EmptyState
            title="NetShift needs one payday to work from"
            icon="◷"
            action={
              <Button variant="primary" onClick={() => window.location.assign('/pay-profile')}>
                Set it in your pay profile
              </Button>
            }
          >
            Planning here runs payday to payday rather than by calendar month. Give NetShift one
            recent payday and it works out the rest.
          </EmptyState>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Paycheck plan"
        feature="paycheck_forecast"
        description="What is safe to spend between this payday and the next. Bills are placed in exactly one paycheck, so nothing gets counted twice."
      />

      <ErrorMessage>{error}</ErrorMessage>

      <Panel title="Which paycheck">
        <div className="ns-plan__periods">
          {paydays.map((date, index) => (
            <button
              key={date}
              type="button"
              className={`ns-plan__period ${index === periodIndex ? 'ns-plan__period--active' : ''}`}
              onClick={() => setPeriodIndex(index)}
              aria-current={index === periodIndex}
            >
              <span className="ns-plan__period-label">
                {index === 0 ? 'This paycheck' : index === 1 ? 'Next' : `+${index}`}
              </span>
              <span className="ns-plan__period-date">{formatIsoDateShort(date)}</span>
            </button>
          ))}
        </div>

        {!isPro && (
          <Callout tone="neutral">
            The free plan covers this paycheck and the next. Pro plans as far ahead as you like.
          </Callout>
        )}
      </Panel>

      {payday && plan && (
        <>
          <Panel title={`Paycheck of ${formatIsoDate(payday)}`}>
            <Grid min={190}>
              <NumberField
                label="Money in the account now"
                prefix="$"
                step="1"
                value={startingBalance}
                onChange={(event) => setStartingBalance(event.target.value)}
                hint="What is there before this paycheck lands."
              />
              <NumberField
                label="Expected gross"
                prefix="$"
                step="1"
                value={expectedGross}
                onChange={(event) => setExpectedGross(event.target.value)}
              />
              <NumberField
                label="Expected deductions"
                prefix="$"
                step="1"
                value={expectedDeductions}
                onChange={(event) => setExpectedDeductions(event.target.value)}
                hint={`Leave blank to estimate at ${effective.deductionPct.toFixed(1)}%.`}
              />
              <NumberField
                label="Putting into savings"
                prefix="$"
                step="1"
                value={plannedSavings}
                onChange={(event) => setPlannedSavings(event.target.value)}
              />
              <NumberField
                label="Paying toward debt"
                prefix="$"
                step="1"
                value={plannedDebt}
                onChange={(event) => setPlannedDebt(event.target.value)}
              />
              <NumberField
                label="Safety buffer to leave alone"
                prefix="$"
                step="1"
                value={safetyBuffer}
                onChange={(event) => setSafetyBuffer(event.target.value)}
              />
            </Grid>
          </Panel>

          <Panel
            title="Safe to spend"
            tone={plan.safeToSpend < 0 ? 'danger' : plan.safeToSpend < 100 ? 'warning' : 'success'}
          >
            <Grid min={170}>
              <Stat
                label="Safe to spend"
                value={fmtMoney(plan.safeToSpend)}
                size="large"
                tone={plan.safeToSpend < 0 ? 'negative' : 'positive'}
                estimated={plan.confidence.level === 'estimated'}
                sub={`${fmtMoney(plan.safeToSpendPerDay)} a day for the ${plan.daysCovered} days until ${formatIsoDateShort(plan.nextPayday)}`}
              />
              <Stat
                label="Expected take-home"
                value={fmtMoney(plan.expectedTakeHome)}
                estimated={plan.confidence.level === 'estimated'}
                sub={
                  plan.confidence.level === 'estimated'
                    ? `Likely between ${fmtMoney(plan.confidence.lowTakeHome)} and ${fmtMoney(plan.confidence.highTakeHome)}`
                    : 'From deduction amounts you entered'
                }
              />
              <Stat
                label="Bills due before next payday"
                value={fmtMoney(plan.billsDue)}
                sub={`${fmtMoney(plan.essentialBillsDue)} of that is essential`}
              />
            </Grid>

            <Callout tone={plan.confidence.level === 'confirmed' ? 'success' : 'info'} icon="i">
              {plan.confidence.explanation}
            </Callout>

            {plan.warnings.map((warning) => (
              <Callout key={warning} tone="warning" icon="!">
                {warning}
              </Callout>
            ))}

            <Workings summary="Show how safe-to-spend was worked out" defaultOpen>
              {plan.workings.map((line) => (
                <WorkingsLine
                  key={line.label}
                  label={line.label}
                  amount={line.amount}
                  sign={line.sign}
                  formatter={fmtMoney}
                />
              ))}
              <div className="ns-workings__result">
                <span>Safe to spend</span>
                <span className="tabular">{fmtMoney(plan.safeToSpend)}</span>
              </div>
              <p className="ns-workings__footnote">
                The safety buffer is held back rather than spent, so the balance projected for the
                day before your next paycheck is {fmtMoney(plan.projectedEndingBalance)}.
              </p>
            </Workings>
          </Panel>

          <Panel title="Bills in this window">
            <DataTable
              caption="Bills due before the next payday"
              columns={[
                { key: 'name', header: 'Bill', render: (bill) => bill.name },
                {
                  key: 'due',
                  header: 'Due',
                  render: (bill) => formatIsoDateShort(bill.dueDate),
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  align: 'right',
                  render: (bill) => fmtMoney(bill.amount),
                },
                {
                  key: 'essential',
                  header: 'Type',
                  align: 'right',
                  render: (bill) =>
                    bill.essential ? <Badge tone="rust">Essential</Badge> : <Badge>Optional</Badge>,
                },
              ]}
              rows={plan.bills}
              getKey={(bill) => `${bill.billId}-${bill.dueDate}`}
              empty={
                <EmptyState title="No bills fall in this window" icon="▤">
                  Add your bills below and NetShift places each one in the paycheck that has to
                  cover it.
                </EmptyState>
              }
            />
          </Panel>
        </>
      )}

      <BillsSection
        bills={billRows}
        isPro={isPro}
        onChanged={refresh}
        onError={setError}
        userId={user?.id ?? null}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

function BillsSection({
  bills,
  isPro,
  onChanged,
  onError,
  userId,
}: {
  bills: BillRow[];
  isPro: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
  userId: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    amount: '',
    dueDate: todayIso(),
    cadence: 'monthly' as BillCadence,
    essential: true,
  });
  const [saving, setSaving] = useState(false);

  const recurringCount = bills.filter((bill) => bill.cadence !== 'once').length;
  const recurringLimit = PLAN_LIMITS[isPro ? 'pro' : 'free'].recurringBills;
  const atRecurringLimit = recurringCount >= recurringLimit;

  async function addBill() {
    if (!userId) return;
    if (!draft.name.trim() || num(draft.amount) <= 0) {
      onError('Give the bill a name and an amount.');
      return;
    }
    if (draft.cadence !== 'once' && atRecurringLimit) {
      onError(
        'Recurring bills are part of NetShift Pro. You can still add this as a one-off for each paycheck.',
      );
      return;
    }

    setSaving(true);
    onError(null);
    try {
      await insertRow('bills', userId, {
        name: draft.name.trim(),
        amount: num(draft.amount),
        due_date: draft.dueDate,
        cadence: draft.cadence,
        essential: draft.essential,
      });
      setDraft({ name: '', amount: '', dueDate: todayIso(), cadence: 'monthly', essential: true });
      setAdding(false);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not save that bill.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="Your bills"
      description="Each bill is placed in the one paycheck that has to cover it, based on when it is due."
      actions={
        <Button variant={adding ? 'ghost' : 'primary'} onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : 'Add a bill'}
        </Button>
      }
    >
      <LimitNotice
        reached={atRecurringLimit && !isPro}
        limitLabel="no recurring bills"
        featureName="repeating bills"
      />

      {adding && (
        <div className="ns-plan__add">
          <Grid min={170}>
            <TextField
              label="Name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <NumberField
              label="Amount"
              prefix="$"
              step="0.01"
              min="0"
              value={draft.amount}
              onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
            />
            <TextField
              label="First due date"
              type="date"
              value={draft.dueDate}
              onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })}
            />
            <SelectField
              label="Repeats"
              value={draft.cadence}
              onChange={(event) =>
                setDraft({ ...draft, cadence: event.target.value as BillCadence })
              }
            >
              {(Object.keys(CADENCE_LABELS) as BillCadence[]).map((cadence) => (
                <option key={cadence} value={cadence} disabled={cadence !== 'once' && !isPro}>
                  {CADENCE_LABELS[cadence]}
                  {cadence !== 'once' && !isPro ? ' (Pro)' : ''}
                </option>
              ))}
            </SelectField>
          </Grid>
          <CheckboxField
            label="This is an essential bill"
            hint="Essentials are what NetShift protects first when money is tight."
            checked={draft.essential}
            onChange={(event) => setDraft({ ...draft, essential: event.target.checked })}
          />
          <Button variant="primary" loading={saving} onClick={() => void addBill()}>
            Save bill
          </Button>
        </div>
      )}

      <DataTable
        caption="All bills"
        columns={[
          { key: 'name', header: 'Bill', render: (bill: BillRow) => bill.name },
          {
            key: 'amount',
            header: 'Amount',
            align: 'right',
            render: (bill: BillRow) => fmtMoney(bill.amount),
          },
          {
            key: 'cadence',
            header: 'Repeats',
            render: (bill: BillRow) => CADENCE_LABELS[bill.cadence],
          },
          {
            key: 'due',
            header: 'Next due',
            render: (bill: BillRow) => formatIsoDate(bill.due_date),
          },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (bill: BillRow) => (
              <ConfirmButton
                variant="link"
                onConfirm={async () => {
                  if (!userId) return;
                  await deleteRow('bills', bill.id, userId);
                  await onChanged();
                }}
              >
                Delete
              </ConfirmButton>
            ),
          },
        ]}
        rows={bills}
        getKey={(bill) => bill.id}
        empty={
          <EmptyState title="No bills yet" icon="▤">
            Add the things that come out between paydays — rent, car, insurance, utilities.
          </EmptyState>
        }
      />
    </Panel>
  );
}
