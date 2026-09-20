/**
 * The dashboard.
 *
 * Answers the three questions a shift worker actually opens the app with:
 * what is my next paycheck, what is safe to spend, and is anything wrong. It
 * links onward rather than duplicating each feature, and it is honest when
 * there is not enough data to say anything yet.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import {
  Badge,
  Callout,
  EmptyState,
  Grid,
  LoadingState,
  Panel,
  Progress,
  Stat,
} from '@/components/ui';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import { useCollection } from '@/hooks/useCollection';
import type { DebtRow, GoalRow, LoggedShiftRow, PayStubRow } from '@/types/database';
import { bucketWeek, effectiveRate, grossFromBuckets } from '@/lib/calc/hours';
import { averageDeductionPct } from '@/lib/calc/pay';
import { daysBetween, formatIsoDate, nextPayday, startOfWeek, todayIso } from '@/lib/calc/dates';
import { fmtHours, fmtMoney, fmtPct } from '@/lib/format';
import './dashboard.css';

export function DashboardPage() {
  const { user } = useAuth();
  const { effective, loading: profileLoading } = usePayProfile();
  const { subscription, isPro } = useEntitlement();

  const { items: shifts, loading: shiftsLoading } = useCollection<LoggedShiftRow>('logged_shifts', {
    orderBy: 'work_date',
    ascending: false,
    limit: 60,
  });
  const { items: stubs } = useCollection<PayStubRow>('pay_stubs', {
    orderBy: 'pay_date',
    ascending: false,
    limit: 24,
  });
  const { items: goals } = useCollection<GoalRow>('goals', { isNull: ['completed_at'] });
  const { items: debts } = useCollection<DebtRow>('debts', { isNull: ['paid_off_at'] });

  const today = todayIso();
  const weekStart = startOfWeek(today);

  const thisWeek = useMemo(() => {
    const days = [0, 0, 0, 0, 0, 0, 0];
    for (const shift of shifts) {
      const offset = daysBetween(weekStart, shift.work_date);
      if (offset >= 0 && offset < 7) days[offset] += shift.paid_hours;
    }
    const buckets = bucketWeek(days, effective.rules);
    const rate = effectiveRate(
      effective.baseRate,
      effective.defaultDesignation,
      effective.premiums,
    );
    return {
      days,
      buckets,
      total: days.reduce((sum, value) => sum + value, 0),
      gross: grossFromBuckets(buckets, rate, effective.rules),
    };
  }, [shifts, weekStart, effective]);

  const upcomingPayday = useMemo(() => {
    if (!effective.anchorPayday) return null;
    let cursor = effective.anchorPayday;
    let guard = 0;
    while (cursor < today && guard++ < 500) {
      cursor = nextPayday(cursor, effective.payFrequency);
    }
    return cursor;
  }, [effective.anchorPayday, effective.payFrequency, today]);

  const learnedDeduction = useMemo(
    () => averageDeductionPct(stubs.map((s) => ({ grossPay: s.gross_pay, netPay: s.net_pay }))),
    [stubs],
  );

  const setupSteps = [
    { done: effective.baseRate > 0, label: 'Add your hourly rate', to: '/pay-profile' },
    { done: Boolean(effective.anchorPayday), label: 'Set a recent payday', to: '/pay-profile' },
    { done: shifts.length > 0, label: 'Log some hours', to: '/hours' },
    { done: stubs.length > 0, label: 'Save a pay stub', to: '/paychecks' },
    { done: goals.length > 0, label: 'Set a goal', to: '/goals' },
  ];
  const doneCount = setupSteps.filter((step) => step.done).length;
  const setupComplete = doneCount === setupSteps.length;

  if (profileLoading || shiftsLoading) return <LoadingState label="Loading your dashboard…" />;

  return (
    <>
      <PageHeader
        title={`Welcome back${user?.email ? '' : ''}`}
        description="Where your pay, hours, and plans stand today."
      />

      {!setupComplete && (
        <Panel title="Finish setting up" tone="warning">
          <Progress value={doneCount} max={setupSteps.length} label="Setup progress" />
          <p className="ns-dash__setup-count">
            {doneCount} of {setupSteps.length} done. Each one makes the rest of NetShift more
            accurate.
          </p>
          <ul className="ns-dash__setup">
            {setupSteps.map((step) => (
              <li key={step.label} className={step.done ? 'ns-dash__setup--done' : ''}>
                <span aria-hidden="true">{step.done ? '✓' : '○'}</span>
                {step.done ? <span>{step.label}</span> : <Link to={step.to}>{step.label}</Link>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="This week">
        <Grid min={155}>
          <Stat
            label="Hours logged"
            value={fmtHours(thisWeek.total)}
            sub={`Week of ${formatIsoDate(weekStart)}`}
          />
          <Stat
            label="Overtime so far"
            value={fmtHours(thisWeek.buckets.overtime)}
            tone={thisWeek.buckets.overtime > 0 ? 'warning' : 'default'}
          />
          {effective.baseRate > 0 && (
            <Stat label="Gross this week" value={fmtMoney(thisWeek.gross)} estimated />
          )}
          {upcomingPayday && (
            <Stat
              label="Next payday"
              value={formatIsoDate(upcomingPayday)}
              sub={
                daysBetween(today, upcomingPayday) === 0
                  ? 'Today'
                  : `In ${daysBetween(today, upcomingPayday)} days`
              }
            />
          )}
        </Grid>

        {thisWeek.total === 0 && (
          <Callout tone="neutral">
            No hours logged this week yet. <Link to="/hours">Add them</Link> and your forecast,
            audit, and shift calculations all sharpen up.
          </Callout>
        )}

        <div className="ns-dash__actions">
          <Link to="/hours" className="ns-btn ns-btn--secondary">
            Log hours
          </Link>
          <Link to="/calculators" className="ns-btn ns-btn--secondary">
            Run a calculation
          </Link>
          <Link to="/shift-value" className="ns-btn ns-btn--secondary">
            Price an extra shift
          </Link>
        </div>
      </Panel>

      <Grid min={300}>
        <Panel title="Your pay">
          {effective.baseRate > 0 ? (
            <>
              <Stat
                label="Base rate"
                value={`${fmtMoney(effective.baseRate)}/hr`}
                sub={effective.currentStepLabel ?? undefined}
              />
              {learnedDeduction !== null && (
                <Stat
                  label="Average deductions"
                  value={fmtPct(learnedDeduction)}
                  size="small"
                  sub={`From ${stubs.length} saved paychecks`}
                />
              )}
              <Link to="/pay-profile" className="ns-btn ns-btn--link">
                Review your pay profile
              </Link>
            </>
          ) : (
            <EmptyState
              title="No rate set"
              action={
                <Link to="/pay-profile" className="ns-btn ns-btn--primary">
                  Add your rate
                </Link>
              }
            >
              Almost everything in NetShift starts from your hourly rate.
            </EmptyState>
          )}
        </Panel>

        <Panel title="Goals">
          {goals.length === 0 ? (
            <EmptyState
              title="No goals yet"
              action={
                <Link to="/goals" className="ns-btn ns-btn--primary">
                  Set a goal
                </Link>
              }
            >
              An emergency fund, a repair, a down payment — NetShift turns it into hours.
            </EmptyState>
          ) : (
            goals.slice(0, 3).map((goal) => {
              const pct =
                goal.target_amount > 0 ? (goal.current_amount / goal.target_amount) * 100 : 0;
              return (
                <div key={goal.id} className="ns-dash__goal">
                  <div className="ns-dash__goal-head">
                    <span>{goal.name}</span>
                    <span className="tabular">
                      {fmtMoney(goal.current_amount)} / {fmtMoney(goal.target_amount)}
                    </span>
                  </div>
                  <Progress value={pct} label={`${goal.name} progress`} />
                </div>
              );
            })
          )}
        </Panel>

        {debts.length > 0 && (
          <Panel title="Debt">
            <Stat
              label="Total owed"
              value={fmtMoney(debts.reduce((sum, debt) => sum + debt.balance, 0))}
              tone="negative"
            />
            <Link to="/debt" className="ns-btn ns-btn--link">
              See your payoff plan
            </Link>
          </Panel>
        )}

        <Panel title="Your plan">
          <Stat
            label="Current plan"
            value={isPro ? 'NetShift Pro' : 'Free'}
            tone={isPro ? 'positive' : 'default'}
            size="small"
          />
          {subscription.documentParses.limit !== null && (
            <Stat
              label="Document parses left"
              value={`${subscription.documentParses.remaining ?? 0} of ${subscription.documentParses.limit}`}
              size="small"
              sub="Resets at the start of next month"
              tone={(subscription.documentParses.remaining ?? 0) <= 1 ? 'warning' : 'default'}
            />
          )}
          {subscription.inGracePeriod && (
            <Callout tone="warning" icon="!">
              A payment did not go through. <Link to="/billing">Update your card</Link> to keep Pro.
            </Callout>
          )}
          <Link to="/billing" className="ns-btn ns-btn--link">
            {isPro ? 'Manage your subscription' : 'See what Pro includes'}
          </Link>
        </Panel>
      </Grid>

      {stubs.length > 0 && (
        <Panel title="Recent paychecks">
          {stubs.slice(0, 3).map((stub) => (
            <div key={stub.id} className="ns-dash__stub">
              <span>{formatIsoDate(stub.pay_date)}</span>
              <span className="tabular">{fmtMoney(stub.gross_pay)} gross</span>
              <span className="tabular">{fmtMoney(stub.net_pay)} take-home</span>
              <Badge
                tone={stub.source === 'local' ? 'green' : stub.source === 'ai' ? 'blue' : 'neutral'}
              >
                {stub.source === 'local'
                  ? 'read locally'
                  : stub.source === 'ai'
                    ? 'AI-read'
                    : 'by hand'}
              </Badge>
            </div>
          ))}
          <div className="ns-dash__actions">
            <Link to="/audit" className="ns-btn ns-btn--secondary">
              Check a paycheck
            </Link>
            <Link to="/paychecks" className="ns-btn ns-btn--secondary">
              All paychecks
            </Link>
          </div>
        </Panel>
      )}

      {stubs.length >= 3 && (
        <Callout tone="info" icon="i">
          You have enough paycheck history for NetShift to size an income buffer.{' '}
          <Link to="/buffer">See what it suggests</Link>.
        </Callout>
      )}
    </>
  );
}
