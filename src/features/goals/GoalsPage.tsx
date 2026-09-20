/**
 * Feature 4 — Goal Funding From Overtime.
 *
 * Translates a target into the thing a shift worker can act on: how many
 * overtime hours it is, and whether the date is reachable at all. Tax figures
 * are labelled as estimates everywhere they appear, because marginal
 * withholding on overtime genuinely is not predictable.
 */

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
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
} from '@/components/ui';
import { LimitNotice, ProGate } from '@/components/ProGate';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, insertRow, updateRow } from '@/services/crud';
import type { GoalContributionRow, GoalRow } from '@/types/database';
import { GOAL_TYPE_LABELS, calculateGoalFunding, type GoalType } from '@/lib/calc/goals';
import { effectiveRate } from '@/lib/calc/hours';
import { formatIsoDate, todayIso } from '@/lib/calc/dates';
import { fmtHours, fmtMoney, fmtPct } from '@/lib/format';
import { num } from '@/lib/calc/money';
import { PLAN_LIMITS } from '@/config/plans';
import './goals.css';

export function GoalsPage() {
  const { user } = useAuth();
  const { effective } = usePayProfile();
  const { isPro } = useEntitlement();
  const {
    items: goals,
    loading,
    refresh,
  } = useCollection<GoalRow>('goals', {
    orderBy: 'priority',
    ascending: true,
  });
  const { items: contributions, refresh: refreshContributions } =
    useCollection<GoalContributionRow>('goal_contributions', {
      orderBy: 'contributed_on',
      ascending: false,
    });

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    goalType: 'emergency_fund' as GoalType,
    targetAmount: '',
    targetDate: '',
    perPaycheck: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeGoals = goals.filter((goal) => !goal.completed_at && !goal.archived_at);
  const goalLimit = PLAN_LIMITS[isPro ? 'pro' : 'free'].activeGoals;
  const atLimit = activeGoals.length >= goalLimit;

  // The rate an extra hour actually pays, premiums included.
  const workingRate = effectiveRate(
    effective.baseRate,
    effective.defaultDesignation,
    effective.premiums,
  );

  async function addGoal() {
    if (!user) return;
    if (!draft.name.trim() || num(draft.targetAmount) <= 0) {
      setError('Give the goal a name and a target amount.');
      return;
    }
    if (atLimit) {
      setError(
        `The free plan allows ${goalLimit} active goal. Complete or archive it, or upgrade to run several at once.`,
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await insertRow('goals', user.id, {
        name: draft.name.trim(),
        goal_type: draft.goalType,
        target_amount: num(draft.targetAmount),
        target_date: draft.targetDate || null,
        per_paycheck_contribution: num(draft.perPaycheck),
        priority: goals.length,
      });
      setDraft({
        name: '',
        goalType: 'emergency_fund',
        targetAmount: '',
        targetDate: '',
        perPaycheck: '',
      });
      setAdding(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that goal.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading your goals…" />;

  return (
    <>
      <PageHeader
        title="Goals"
        description="What you are saving for, and what it would take in hours to get there."
        actions={
          <Button variant={adding ? 'ghost' : 'primary'} onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add a goal'}
          </Button>
        }
      />

      <ErrorMessage>{error}</ErrorMessage>
      <LimitNotice
        reached={atLimit && !isPro}
        limitLabel={`${goalLimit} active goal`}
        featureName="running several goals at once"
      />

      {adding && (
        <Panel title="New goal">
          <Grid min={180}>
            <TextField
              label="What is it for"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Emergency fund"
            />
            <SelectField
              label="Type"
              value={draft.goalType}
              onChange={(event) => setDraft({ ...draft, goalType: event.target.value as GoalType })}
            >
              {(Object.keys(GOAL_TYPE_LABELS) as GoalType[]).map((type) => (
                <option key={type} value={type}>
                  {GOAL_TYPE_LABELS[type]}
                </option>
              ))}
            </SelectField>
            <NumberField
              label="Target amount"
              prefix="$"
              step="1"
              min="0"
              value={draft.targetAmount}
              onChange={(event) => setDraft({ ...draft, targetAmount: event.target.value })}
            />
            <TextField
              label="Target date"
              type="date"
              value={draft.targetDate}
              onChange={(event) => setDraft({ ...draft, targetDate: event.target.value })}
              hint="Optional. NetShift works out what each paycheck needs to carry."
            />
            <NumberField
              label="Putting in each paycheck"
              prefix="$"
              step="1"
              min="0"
              value={draft.perPaycheck}
              onChange={(event) => setDraft({ ...draft, perPaycheck: event.target.value })}
            />
          </Grid>
          <Button variant="primary" loading={saving} onClick={() => void addGoal()}>
            Save goal
          </Button>
        </Panel>
      )}

      {activeGoals.length === 0 && !adding ? (
        <Panel>
          <EmptyState
            title="No goals yet"
            icon="◎"
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add your first goal
              </Button>
            }
          >
            An emergency fund, a truck repair, a down payment — NetShift works out how many hours it
            is, not just how many dollars.
          </EmptyState>
        </Panel>
      ) : (
        activeGoals.map((goal) => (
          <GoalCard
            key={goal.id}
            goal={goal}
            contributions={contributions.filter((row) => row.goal_id === goal.id)}
            workingRate={workingRate}
            frequency={effective.payFrequency}
            marginalDeductionPct={effective.marginalDeductionPct}
            rules={effective.rules}
            userId={user?.id ?? null}
            onChanged={async () => {
              await refresh();
              await refreshContributions();
            }}
            onError={setError}
          />
        ))
      )}

      {goals.some((goal) => goal.completed_at) && (
        <Panel title="Completed">
          <DataTable
            caption="Completed goals"
            columns={[
              { key: 'name', header: 'Goal', render: (goal: GoalRow) => goal.name },
              {
                key: 'amount',
                header: 'Reached',
                align: 'right',
                render: (goal: GoalRow) => fmtMoney(goal.target_amount),
              },
              {
                key: 'when',
                header: 'When',
                render: (goal: GoalRow) => formatIsoDate(goal.completed_at?.slice(0, 10) ?? null),
              },
            ]}
            rows={goals.filter((goal) => goal.completed_at)}
            getKey={(goal) => goal.id}
          />
        </Panel>
      )}
    </>
  );
}

function GoalCard({
  goal,
  contributions,
  workingRate,
  frequency,
  marginalDeductionPct,
  rules,
  userId,
  onChanged,
  onError,
}: {
  goal: GoalRow;
  contributions: GoalContributionRow[];
  workingRate: number;
  frequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  marginalDeductionPct: number;
  rules: {
    overtimeMultiplier: number;
    doubleTimeMultiplier: number;
    weeklyThreshold: number | null;
    dailyThreshold: number | null;
    sundayTreatment: 'regular' | 'ot' | 'double';
  };
  userId: string | null;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [contribution, setContribution] = useState('');
  const [busy, setBusy] = useState(false);

  const funding = useMemo(
    () =>
      calculateGoalFunding({
        targetAmount: goal.target_amount,
        currentAmount: goal.current_amount,
        targetDate: goal.target_date,
        perPaycheckContribution: goal.per_paycheck_contribution,
        frequency,
        baseRate: workingRate,
        effectiveRate: workingRate,
        marginalDeductionPct,
        rules,
      }),
    [goal, frequency, workingRate, marginalDeductionPct, rules],
  );

  async function addContribution() {
    if (!userId || num(contribution) <= 0) return;
    setBusy(true);
    onError(null);
    try {
      await insertRow('goal_contributions', userId, {
        goal_id: goal.id,
        amount: num(contribution),
        contributed_on: todayIso(),
        source: 'manual',
      });
      setContribution('');
      await onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not record that contribution.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={goal.name}
      description={GOAL_TYPE_LABELS[goal.goal_type as GoalType] ?? undefined}
      tone={funding.complete ? 'success' : funding.targetDateUnreachable ? 'warning' : 'default'}
      actions={
        <ConfirmButton
          variant="link"
          onConfirm={async () => {
            if (!userId) return;
            await deleteRow('goals', goal.id, userId);
            await onChanged();
          }}
        >
          Delete
        </ConfirmButton>
      }
    >
      <Progress
        value={funding.progressPct}
        label={`${goal.name} progress`}
        tone={funding.complete ? 'green' : 'amber'}
      />

      <Grid min={155}>
        <Stat
          label="Saved so far"
          value={fmtMoney(funding.currentAmount)}
          sub={`of ${fmtMoney(funding.targetAmount)} — ${fmtPct(funding.progressPct, 0)}`}
          tone={funding.complete ? 'positive' : 'default'}
        />
        <Stat label="Still to go" value={fmtMoney(funding.remaining)} />
        {funding.requiredPerPaycheck !== null && (
          <Stat
            label="Needed each paycheck"
            value={fmtMoney(funding.requiredPerPaycheck)}
            sub={`over ${funding.paychecksUntilTarget} paychecks`}
            estimated
            tone={funding.targetDateUnreachable ? 'negative' : 'warning'}
          />
        )}
        {funding.projectedCompletionDate && (
          <Stat
            label="On track for"
            value={formatIsoDate(funding.projectedCompletionDate)}
            sub={`at ${fmtMoney(goal.per_paycheck_contribution)} a paycheck`}
            estimated
          />
        )}
      </Grid>

      <ProGate feature="goal_projections" preview={<div style={{ minHeight: 120 }} />}>
        {funding.hoursNeeded.overtime !== null && workingRate > 0 && (
          <>
            <h4 className="ns-goals__subhead">What that is in hours</h4>
            <DataTable
              caption="Hours needed per paycheck"
              columns={[
                {
                  key: 'kind',
                  header: 'Paid at',
                  render: (row: [string, number | null]) => row[0],
                },
                {
                  key: 'hours',
                  header: 'Hours each paycheck',
                  align: 'right',
                  render: (row: [string, number | null]) => fmtHours(row[1]),
                },
              ]}
              rows={[
                ['Straight time', funding.hoursNeeded.regular] as [string, number | null],
                [`Overtime (${rules.overtimeMultiplier}×)`, funding.hoursNeeded.overtime],
                [`Double time (${rules.doubleTimeMultiplier}×)`, funding.hoursNeeded.doubleTime],
              ]}
              getKey={(row) => row[0]}
            />

            {funding.extraShiftEffect && (
              <Callout tone="info" icon="↗">
                One extra 8-hour overtime shift is worth about{' '}
                <strong>{fmtMoney(funding.extraShiftEffect.netPerShift)}</strong> after estimated
                withholding. One a week would fund this by{' '}
                <strong>
                  {formatIsoDate(funding.extraShiftEffect.completionWithOneShiftPerWeek)}
                </strong>
                ; one a month by{' '}
                {formatIsoDate(funding.extraShiftEffect.completionWithOneShiftPerMonth)}.
              </Callout>
            )}
          </>
        )}
      </ProGate>

      {funding.notes.map((note) => (
        <Callout key={note} tone={funding.targetDateUnreachable ? 'warning' : 'neutral'}>
          {note}
        </Callout>
      ))}

      <div className="ns-goals__contribute">
        <NumberField
          label="Record a contribution"
          prefix="$"
          step="1"
          min="0"
          value={contribution}
          onChange={(event) => setContribution(event.target.value)}
        />
        <Button
          variant="primary"
          loading={busy}
          disabled={num(contribution) <= 0}
          onClick={() => void addContribution()}
        >
          Add
        </Button>
      </div>

      {contributions.length > 0 && (
        <details className="ns-workings">
          <summary>{contributions.length} contributions recorded</summary>
          <div className="ns-workings__body">
            <DataTable
              caption="Contributions"
              columns={[
                {
                  key: 'date',
                  header: 'Date',
                  render: (row: GoalContributionRow) => formatIsoDate(row.contributed_on),
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  align: 'right',
                  render: (row: GoalContributionRow) => fmtMoney(row.amount),
                },
                {
                  key: 'source',
                  header: 'From',
                  render: (row: GoalContributionRow) => row.source.replace(/_/g, ' '),
                },
              ]}
              rows={contributions}
              getKey={(row) => row.id}
            />
          </div>
        </details>
      )}

      {funding.complete && !goal.completed_at && (
        <Button
          variant="primary"
          onClick={async () => {
            if (!userId) return;
            await updateRow('goals', goal.id, userId, { completed_at: new Date().toISOString() });
            await onChanged();
          }}
        >
          Mark this goal complete
        </Button>
      )}
    </Panel>
  );
}
