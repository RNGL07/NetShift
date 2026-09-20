/**
 * Hours logging.
 *
 * Hours are entered per calendar day because that is what the overtime rules
 * operate on. The week view shows the running bucket split as hours are typed,
 * so the effect of a long day on overtime is visible immediately rather than
 * only once a paycheck arrives.
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
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, upsertRow } from '@/services/crud';
import type { LoggedShiftRow } from '@/types/database';
import {
  addDays,
  dayIndexMonFirst,
  formatIsoDateShort,
  startOfWeek,
  todayIso,
} from '@/lib/calc/dates';
import { bucketWeek, grossFromBuckets, effectiveRate, DAY_LABELS } from '@/lib/calc/hours';
import type { ShiftDesignation } from '@/lib/calc/hours';
import { shiftSpan } from '@/lib/calc/shiftHours';
import { fmtHours, fmtMoney } from '@/lib/format';
import { num } from '@/lib/calc/money';
import './hours.css';

export function HoursPage() {
  const { user } = useAuth();
  const { effective } = usePayProfile();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayIso()));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const weekEnd = addDays(weekStart, 6);
  const { items, loading, refresh } = useCollection<LoggedShiftRow>('logged_shifts', {
    orderBy: 'work_date',
    ascending: true,
  });

  const weekShifts = useMemo(
    () => items.filter((shift) => shift.work_date >= weekStart && shift.work_date <= weekEnd),
    [items, weekStart, weekEnd],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, LoggedShiftRow>();
    for (const shift of weekShifts) map.set(shift.work_date, shift);
    return map;
  }, [weekShifts]);

  const weekHours = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const date = addDays(weekStart, index);
        return byDay.get(date)?.paid_hours ?? 0;
      }),
    [byDay, weekStart],
  );

  const buckets = useMemo(
    () => bucketWeek(weekHours, effective.rules),
    [weekHours, effective.rules],
  );

  const estimatedGross = useMemo(() => {
    const rate = effectiveRate(effective.baseRate, effective.defaultDesignation, effective.premiums);
    return grossFromBuckets(buckets, rate, effective.rules);
  }, [buckets, effective]);

  async function saveDay(date: string, patch: Partial<LoggedShiftRow>) {
    if (!user) return;
    setSaving(date);
    setError(null);
    try {
      const existing = byDay.get(date);
      await upsertRow(
        'logged_shifts',
        {
          ...(existing ? { id: existing.id } : {}),
          user_id: user.id,
          work_date: date,
          paid_hours: patch.paid_hours ?? existing?.paid_hours ?? 0,
          start_time: patch.start_time ?? existing?.start_time ?? null,
          end_time: patch.end_time ?? existing?.end_time ?? null,
          unpaid_break_minutes: patch.unpaid_break_minutes ?? existing?.unpaid_break_minutes ?? 0,
          designation: patch.designation ?? existing?.designation ?? effective.defaultDesignation,
          crosses_midnight: patch.crosses_midnight ?? existing?.crosses_midnight ?? false,
          is_holiday: patch.is_holiday ?? existing?.is_holiday ?? false,
          source: 'manual',
        },
        'user_id,work_date',
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save those hours.');
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <LoadingState label="Loading your hours…" />;

  const totalHours = weekHours.reduce((sum, hours) => sum + hours, 0);

  return (
    <>
      <PageHeader
        title="Hours"
        feature="hours_logging"
        description="Log what you actually worked. These hours feed your paycheck forecast, your audit, and every scenario NetShift runs."
      />

      <ErrorMessage>{error}</ErrorMessage>

      <Panel
        title={`Week of ${formatIsoDateShort(weekStart)}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setWeekStart(addDays(weekStart, -7))}>
              ← Previous
            </Button>
            <Button variant="ghost" onClick={() => setWeekStart(startOfWeek(todayIso()))}>
              This week
            </Button>
            <Button variant="ghost" onClick={() => setWeekStart(addDays(weekStart, 7))}>
              Next →
            </Button>
          </>
        }
      >
        <Grid min={150}>
          <Stat label="Total hours" value={fmtHours(totalHours)} />
          <Stat label="Regular" value={fmtHours(buckets.regular)} />
          <Stat
            label="Overtime"
            value={fmtHours(buckets.overtime)}
            tone={buckets.overtime > 0 ? 'warning' : 'default'}
          />
          {buckets.doubleTime > 0 && (
            <Stat label="Double time" value={fmtHours(buckets.doubleTime)} tone="positive" />
          )}
          {effective.baseRate > 0 && (
            <Stat label="Estimated gross" value={fmtMoney(estimatedGross)} estimated />
          )}
        </Grid>

        <div className="ns-hours__week">
          {Array.from({ length: 7 }, (_, index) => {
            const date = addDays(weekStart, index);
            const shift = byDay.get(date);
            const isToday = date === todayIso();
            const overDaily =
              effective.rules.dailyThreshold !== null &&
              (shift?.paid_hours ?? 0) > effective.rules.dailyThreshold;

            return (
              <DayCard
                key={date}
                date={date}
                dayLabel={DAY_LABELS[dayIndexMonFirst(date)]}
                shift={shift}
                isToday={isToday}
                overDaily={overDaily}
                saving={saving === date}
                defaultDesignation={effective.defaultDesignation}
                onSave={(patch) => void saveDay(date, patch)}
                onClear={async () => {
                  if (!shift || !user) return;
                  await deleteRow('logged_shifts', shift.id, user.id);
                  await refresh();
                }}
              />
            );
          })}
        </div>

        {buckets.overtime > 0 && (
          <Callout tone="neutral">
            {fmtHours(buckets.overtime)} of this week&rsquo;s hours are overtime under your rules
            {effective.rules.dailyThreshold !== null && ` (over ${effective.rules.dailyThreshold} in a day`}
            {effective.rules.dailyThreshold !== null && effective.rules.weeklyThreshold !== null && ' or '}
            {effective.rules.weeklyThreshold !== null && `${effective.rules.dailyThreshold === null ? '(' : ''}over ${effective.rules.weeklyThreshold} in the week`}
            {(effective.rules.dailyThreshold !== null || effective.rules.weeklyThreshold !== null) && ')'}
            . No hour is counted twice.
          </Callout>
        )}
      </Panel>

      <RecentHours shifts={items} />
    </>
  );
}

function DayCard({
  date,
  dayLabel,
  shift,
  isToday,
  overDaily,
  saving,
  defaultDesignation,
  onSave,
  onClear,
}: {
  date: string;
  dayLabel: string;
  shift: LoggedShiftRow | undefined;
  isToday: boolean;
  overDaily: boolean;
  saving: boolean;
  defaultDesignation: ShiftDesignation;
  onSave: (patch: Partial<LoggedShiftRow>) => void;
  onClear: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hours, setHours] = useState(shift ? String(shift.paid_hours) : '');
  const [start, setStart] = useState(shift?.start_time?.slice(0, 5) ?? '');
  const [end, setEnd] = useState(shift?.end_time?.slice(0, 5) ?? '');
  const [breakMinutes, setBreakMinutes] = useState(String(shift?.unpaid_break_minutes ?? 30));
  const [designation, setDesignation] = useState<ShiftDesignation>(
    shift?.designation ?? defaultDesignation,
  );

  // Clock times win over a typed total when both are present, and the computed
  // span handles a shift running past midnight.
  const computed = start && end ? shiftSpan({ start, end, unpaidBreakMinutes: num(breakMinutes) }) : null;

  return (
    <div
      className={`ns-hours__day ${isToday ? 'ns-hours__day--today' : ''} ${
        overDaily ? 'ns-hours__day--over' : ''
      }`}
    >
      <div className="ns-hours__day-head">
        <span className="ns-hours__day-name">
          {dayLabel} {formatIsoDateShort(date).split(' ').slice(1).join(' ')}
        </span>
        {shift?.crosses_midnight && (
          <Badge tone="blue" title="This shift runs past midnight and counts against the day it starts">
            +1 day
          </Badge>
        )}
        {overDaily && <Badge tone="amber">OT</Badge>}
      </div>

      <NumberField
        label={`Hours on ${dayLabel}`}
        hideLabel
        step="0.25"
        min="0"
        max="24"
        placeholder="0"
        value={computed ? String(computed.paidHours) : hours}
        disabled={Boolean(computed) || saving}
        onChange={(event) => setHours(event.target.value)}
        onBlur={() => {
          if (computed) return;
          const value = num(hours);
          if (value !== (shift?.paid_hours ?? 0)) onSave({ paid_hours: value });
        }}
      />

      <button
        type="button"
        className="ns-hours__toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? 'Hide times' : 'Clock times'}
      </button>

      {expanded && (
        <div className="ns-hours__times">
          <TextField
            label="Start"
            type="time"
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
          <TextField
            label="End"
            type="time"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
          <NumberField
            label="Unpaid break (min)"
            step="5"
            min="0"
            value={breakMinutes}
            onChange={(event) => setBreakMinutes(event.target.value)}
          />
          <SelectField
            label="Shift"
            value={designation}
            onChange={(event) => setDesignation(event.target.value as ShiftDesignation)}
          >
            <option value="day">Day</option>
            <option value="evening">Mids</option>
            <option value="night">Night</option>
          </SelectField>

          {computed && (
            <p className="ns-hours__computed">
              {fmtHours(computed.paidHours)} paid hours
              {computed.crossesMidnight && ' — runs past midnight, counted on this day'}
            </p>
          )}

          <div className="ns-hours__day-actions">
            <Button
              variant="primary"
              loading={saving}
              onClick={() =>
                onSave({
                  paid_hours: computed?.paidHours ?? num(hours),
                  start_time: start || null,
                  end_time: end || null,
                  unpaid_break_minutes: num(breakMinutes),
                  designation,
                  crosses_midnight: computed?.crossesMidnight ?? false,
                })
              }
            >
              Save
            </Button>
            {shift && (
              <ConfirmButton variant="ghost" onConfirm={() => void onClear()}>
                Clear
              </ConfirmButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RecentHours({ shifts }: { shifts: LoggedShiftRow[] }) {
  const recent = [...shifts].sort((a, b) => b.work_date.localeCompare(a.work_date)).slice(0, 30);

  return (
    <Panel title="Recently logged">
      <DataTable
        caption="Recently logged hours"
        columns={[
          {
            key: 'date',
            header: 'Date',
            render: (shift: LoggedShiftRow) => formatIsoDateShort(shift.work_date),
          },
          {
            key: 'hours',
            header: 'Hours',
            align: 'right',
            render: (shift: LoggedShiftRow) => fmtHours(shift.paid_hours),
          },
          {
            key: 'shift',
            header: 'Shift',
            render: (shift: LoggedShiftRow) =>
              shift.designation === 'day' ? 'Day' : shift.designation === 'night' ? 'Night' : 'Mids',
          },
          {
            key: 'times',
            header: 'Times',
            render: (shift: LoggedShiftRow) =>
              shift.start_time && shift.end_time
                ? `${shift.start_time.slice(0, 5)}–${shift.end_time.slice(0, 5)}${shift.crosses_midnight ? ' (+1)' : ''}`
                : '—',
          },
        ]}
        rows={recent}
        getKey={(shift) => shift.id}
        empty={
          <EmptyState title="Nothing logged yet" icon="◷">
            Add hours above and they will show up here.
          </EmptyState>
        }
      />
    </Panel>
  );
}
