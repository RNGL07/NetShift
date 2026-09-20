/**
 * Feature 3 — "Is This Shift Worth It?"
 *
 * The whole point is that a shift cannot be priced in isolation: the 41st hour
 * of a week pays 1.5× and the 1st does not. So this page loads the hours
 * already logged in the shift's own workweek and prices the shift *marginally*
 * against them.
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
  Workings,
  WorkingsLine,
} from '@/components/ui';
import { ProGate } from '@/components/ProGate';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, insertRow } from '@/services/crud';
import type { DebtRow, GoalRow, LoggedShiftRow, ShiftScenarioRow } from '@/types/database';
import { evaluateShiftValue, shiftImpact } from '@/lib/calc/shiftValue';
import { daysBetween, formatIsoDate, startOfWeek, todayIso } from '@/lib/calc/dates';
import type { ShiftDesignation } from '@/lib/calc/hours';
import { fmtHours, fmtMoney, fmtRate } from '@/lib/format';
import { num } from '@/lib/calc/money';

export function ShiftValuePage() {
  const { user } = useAuth();
  const { effective, loading: profileLoading } = usePayProfile();
  const { items: shifts, loading: shiftsLoading } = useCollection<LoggedShiftRow>('logged_shifts', {
    orderBy: 'work_date',
    ascending: true,
  });
  const { items: goals } = useCollection<GoalRow>('goals', { isNull: ['completed_at'] });
  const { items: debts } = useCollection<DebtRow>('debts', { isNull: ['paid_off_at'] });
  const { items: scenarios, refresh: refreshScenarios } = useCollection<ShiftScenarioRow>(
    'shift_scenarios',
    { orderBy: 'shift_date', ascending: false },
  );

  const [date, setDate] = useState(todayIso());
  const [useTimes, setUseTimes] = useState(false);
  const [hours, setHours] = useState('8');
  const [startTime, setStartTime] = useState('06:00');
  const [endTime, setEndTime] = useState('14:30');
  const [breakMinutes, setBreakMinutes] = useState('30');
  const [designation, setDesignation] = useState<ShiftDesignation>('day');
  const [isHoliday, setIsHoliday] = useState(false);
  const [commute, setCommute] = useState('');
  const [meals, setMeals] = useState('');
  const [childcare, setChildcare] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [scenarioName, setScenarioName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Hours already logged in the same Monday-start week as the proposed shift. */
  const priorWeekHours = useMemo(() => {
    const weekStart = startOfWeek(date);
    const week = [0, 0, 0, 0, 0, 0, 0];
    for (const shift of shifts) {
      const offset = daysBetween(weekStart, shift.work_date);
      // The proposed day's own logged hours are excluded — this prices the
      // shift as an addition, not a duplicate of something already recorded.
      if (offset >= 0 && offset < 7 && shift.work_date !== date) {
        week[offset] += shift.paid_hours;
      }
    }
    return week;
  }, [shifts, date]);

  const priorTotal = priorWeekHours.reduce((sum, value) => sum + value, 0);

  const result = useMemo(
    () =>
      evaluateShiftValue({
        date,
        hours: useTimes ? undefined : num(hours),
        startTime: useTimes ? startTime : undefined,
        endTime: useTimes ? endTime : undefined,
        unpaidBreakMinutes: num(breakMinutes),
        baseRate: effective.baseRate,
        designation,
        premiums: effective.premiums,
        rules: effective.rules,
        sundayTreatment: effective.rules.sundayTreatment,
        holidayMultiplier: isHoliday ? (effective.holidayMultiplier ?? 2) : null,
        priorWeekHours,
        marginalDeductionPct: effective.marginalDeductionPct,
        commuteCost: num(commute),
        mealCost: num(meals),
        childcareCost: num(childcare),
      }),
    [
      date,
      useTimes,
      hours,
      startTime,
      endTime,
      breakMinutes,
      effective,
      designation,
      isHoliday,
      priorWeekHours,
      commute,
      meals,
      childcare,
    ],
  );

  const target = useMemo(() => {
    if (!targetKey) return null;
    const [kind, id] = targetKey.split(':');
    if (kind === 'goal') {
      const goal = goals.find((item) => item.id === id);
      return goal
        ? {
            kind: 'goal' as const,
            name: goal.name,
            remaining: Math.max(0, goal.target_amount - goal.current_amount),
          }
        : null;
    }
    const debt = debts.find((item) => item.id === id);
    return debt ? { kind: 'debt' as const, name: debt.name, remaining: debt.balance } : null;
  }, [targetKey, goals, debts]);

  const impact = useMemo(() => shiftImpact(result.netGain, target), [result.netGain, target]);

  async function saveScenario() {
    if (!user) return;
    if (!scenarioName.trim()) {
      setError('Give this scenario a name so you can find it again.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const [kind, id] = targetKey ? targetKey.split(':') : [null, null];
      await insertRow('shift_scenarios', user.id, {
        name: scenarioName.trim(),
        shift_date: date,
        hours: useTimes ? null : num(hours),
        start_time: useTimes ? startTime : null,
        end_time: useTimes ? endTime : null,
        unpaid_break_minutes: num(breakMinutes),
        designation,
        is_holiday: isHoliday,
        commute_cost: num(commute),
        meal_cost: num(meals),
        childcare_cost: num(childcare),
        linked_goal_id: kind === 'goal' ? id : null,
        linked_debt_id: kind === 'debt' ? id : null,
        gross_incremental: result.grossIncremental,
        net_gain: result.netGain,
        net_hourly_rate: result.netHourlyRate,
        computed_at: new Date().toISOString(),
      });
      setScenarioName('');
      await refreshScenarios();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that scenario.');
    } finally {
      setSaving(false);
    }
  }

  if (profileLoading || shiftsLoading) return <LoadingState label="Loading…" />;

  return (
    <>
      <PageHeader
        title="Is this shift worth it?"
        feature="shift_value_basic"
        description="What one extra shift actually leaves you with, after the tax it attracts and the costs of going in."
      />

      <ErrorMessage>{error}</ErrorMessage>

      {effective.baseRate <= 0 && (
        <Callout tone="warning" icon="!">
          Set your hourly rate in your pay profile first — without it there is nothing to price.
        </Callout>
      )}

      <Panel title="The shift">
        <Grid min={180}>
          <TextField
            label="Date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <SelectField
            label="How to enter it"
            value={useTimes ? 'times' : 'hours'}
            onChange={(event) => setUseTimes(event.target.value === 'times')}
          >
            <option value="hours">Just the hours</option>
            <option value="times">Start and end times</option>
          </SelectField>
          {useTimes ? (
            <>
              <TextField
                label="Start"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
              <TextField
                label="End"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                hint="An end before the start is read as a night shift."
              />
              <NumberField
                label="Unpaid break (min)"
                step="5"
                min="0"
                value={breakMinutes}
                onChange={(event) => setBreakMinutes(event.target.value)}
              />
            </>
          ) : (
            <NumberField
              label="Hours"
              step="0.25"
              min="0"
              max="24"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
            />
          )}
          <SelectField
            label="Shift"
            value={designation}
            onChange={(event) => setDesignation(event.target.value as ShiftDesignation)}
          >
            <option value="day">Day</option>
            <option value="evening">Mids</option>
            <option value="night">Night</option>
          </SelectField>
          <SelectField
            label="Holiday"
            value={isHoliday ? 'yes' : 'no'}
            onChange={(event) => setIsHoliday(event.target.value === 'yes')}
          >
            <option value="no">A normal day</option>
            <option value="yes">A paid holiday</option>
          </SelectField>
        </Grid>

        <Callout tone={priorTotal > 0 ? 'info' : 'neutral'} icon="i">
          {priorTotal > 0 ? (
            <>
              You already have <strong>{fmtHours(priorTotal)} hours</strong> logged in the week
              starting {formatIsoDate(startOfWeek(date))}. This shift is priced on top of those, so
              the overtime rule is applied correctly.
            </>
          ) : (
            <>
              No hours are logged yet in the week starting {formatIsoDate(startOfWeek(date))}, so
              this shift is priced as straight time. Log that week&rsquo;s hours to see whether the
              shift would actually land in overtime.
            </>
          )}
        </Callout>
      </Panel>

      <Panel title="What it costs you to go in">
        <Grid min={170}>
          <NumberField
            label="Fuel and travel"
            prefix="$"
            step="0.5"
            min="0"
            value={commute}
            onChange={(event) => setCommute(event.target.value)}
          />
          <NumberField
            label="Food"
            prefix="$"
            step="0.5"
            min="0"
            value={meals}
            onChange={(event) => setMeals(event.target.value)}
          />
          <NumberField
            label="Childcare"
            prefix="$"
            step="1"
            min="0"
            value={childcare}
            onChange={(event) => setChildcare(event.target.value)}
          />
        </Grid>
        <ProGate feature="saved_shift_scenarios" compact>
          <p className="ns-muted">
            Pro also lets you save these as scenarios and set costs that repeat.
          </p>
        </ProGate>
      </Panel>

      <Panel
        title="What you would actually keep"
        tone={
          !result.valid
            ? 'default'
            : result.netHourlyRate < effective.baseRate * 0.6
              ? 'warning'
              : 'success'
        }
      >
        {!result.valid ? (
          <p className="ns-muted">{result.notes[0]}</p>
        ) : (
          <>
            <Grid min={165}>
              <Stat
                label="Net gain"
                value={fmtMoney(result.netGain)}
                size="large"
                tone={result.netGain > 0 ? 'positive' : 'negative'}
                estimated
              />
              <Stat
                label="Effective hourly"
                value={fmtRate(result.netHourlyRate)}
                estimated
                sub={`Headline rate is ${fmtRate(result.grossHourlyRate)}`}
                tone={result.netHourlyRate < effective.baseRate * 0.6 ? 'warning' : 'default'}
              />
              <Stat
                label="Gross for this shift"
                value={fmtMoney(result.grossIncremental)}
                sub={`${fmtHours(result.buckets.regular)} reg · ${fmtHours(result.buckets.overtime)} OT${result.buckets.doubleTime > 0 ? ` · ${fmtHours(result.buckets.doubleTime)} DT` : ''}`}
              />
            </Grid>

            {result.notes.map((note) => (
              <Callout key={note} tone="neutral">
                {note}
              </Callout>
            ))}

            <Workings summary="Show how this was worked out" defaultOpen>
              {result.workings.map((line, index) => (
                <WorkingsLine
                  key={`${line.label}-${index}`}
                  label={line.label}
                  amount={line.amount}
                  sign={line.sign}
                  note={line.note}
                  formatter={fmtMoney}
                />
              ))}
              <div className="ns-workings__result">
                <span>What you keep</span>
                <span className="tabular">{fmtMoney(result.netGain)}</span>
              </div>
            </Workings>

            {result.netHourlyRate < effective.baseRate * 0.6 && result.netGain > 0 && (
              <Callout tone="warning" icon="!">
                After tax and costs this shift works out at {fmtRate(result.netHourlyRate)} — well
                under your headline rate of {fmtRate(effective.baseRate)}. Worth knowing before you
                say yes.
              </Callout>
            )}
            {result.netGain <= 0 && (
              <Callout tone="danger" icon="!">
                On these figures the shift costs more than it pays.
              </Callout>
            )}
          </>
        )}
      </Panel>

      {(goals.length > 0 || debts.length > 0) && result.valid && (
        <Panel title="What it would do for a goal or a debt">
          <SelectField
            label="Put it toward"
            value={targetKey}
            onChange={(event) => setTargetKey(event.target.value)}
          >
            <option value="">Nothing in particular</option>
            {goals.map((goal) => (
              <option key={goal.id} value={`goal:${goal.id}`}>
                Goal — {goal.name}
              </option>
            ))}
            {debts.map((debt) => (
              <option key={debt.id} value={`debt:${debt.id}`}>
                Debt — {debt.name}
              </option>
            ))}
          </SelectField>
          {impact && (
            <Callout tone="success" icon="↗">
              {impact.message}
            </Callout>
          )}
        </Panel>
      )}

      <ProGate
        feature="saved_shift_scenarios"
        preview={
          <Panel title="Saved shift scenarios">
            <p>&nbsp;</p>
          </Panel>
        }
      >
        <Panel title="Saved shift scenarios">
          <Grid min={200}>
            <TextField
              label="Name this scenario"
              value={scenarioName}
              onChange={(event) => setScenarioName(event.target.value)}
              placeholder="Saturday overtime"
            />
          </Grid>
          <Button
            variant="primary"
            loading={saving}
            disabled={!result.valid}
            onClick={() => void saveScenario()}
          >
            Save this scenario
          </Button>

          <DataTable
            caption="Saved shift scenarios"
            columns={[
              { key: 'name', header: 'Name', render: (row: ShiftScenarioRow) => row.name },
              {
                key: 'date',
                header: 'Date',
                render: (row: ShiftScenarioRow) => formatIsoDate(row.shift_date),
              },
              {
                key: 'net',
                header: 'Net gain',
                align: 'right',
                render: (row: ShiftScenarioRow) => fmtMoney(row.net_gain),
              },
              {
                key: 'rate',
                header: 'Effective rate',
                align: 'right',
                render: (row: ShiftScenarioRow) => fmtRate(row.net_hourly_rate),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row: ShiftScenarioRow) => (
                  <ConfirmButton
                    variant="link"
                    onConfirm={async () => {
                      if (!user) return;
                      await deleteRow('shift_scenarios', row.id, user.id);
                      await refreshScenarios();
                    }}
                  >
                    Delete
                  </ConfirmButton>
                ),
              },
            ]}
            rows={scenarios}
            getKey={(row) => row.id}
            empty={
              <EmptyState title="No saved scenarios" icon="▦">
                Save a shift above to compare it against others later.
              </EmptyState>
            }
          />
        </Panel>
      </ProGate>

      <Callout tone="neutral">
        <Badge tone="neutral">Estimate</Badge> The withholding figure uses{' '}
        {effective.marginalDeductionPct.toFixed(1)}% from your pay profile. Overtime is often
        withheld at a higher rate than regular pay, so treat the net as a guide rather than a
        promise.
      </Callout>
    </>
  );
}
