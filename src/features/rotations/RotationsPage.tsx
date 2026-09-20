/**
 * Feature 7 — Rotation calendar automation.
 *
 * The pattern and its exceptions are stored; the shifts themselves are
 * generated on demand. Materialising three years of rows would be tens of
 * thousands of records that all become wrong the moment the rotation changes,
 * so the calendar below is computed, not fetched.
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
  SelectField,
  Stat,
  TextField,
} from '@/components/ui';
import { ProGate } from '@/components/ProGate';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, insertRow, upsertRow } from '@/services/crud';
import type { RotationExceptionRow, RotationPatternRow } from '@/types/database';
import {
  EXCEPTION_LABELS,
  ROTATION_TEMPLATES,
  generateRotationShifts,
  shiftsToWeeks,
  type ExceptionKind,
  type GeneratedShift,
  type RotationDay,
  type RotationPattern,
} from '@/lib/calc/rotation';
import {
  addDays,
  formatIsoDate,
  formatIsoDateShort,
  startOfWeek,
  todayIso,
} from '@/lib/calc/dates';
import { bucketWeek } from '@/lib/calc/hours';
import { fmtHours, fmtMoney } from '@/lib/format';
import { effectiveRate, grossFromBuckets } from '@/lib/calc/hours';
import { num } from '@/lib/calc/money';
import './rotations.css';

const HORIZON_DAYS = 56; // eight weeks, which covers a six-week rotation plus context

export function RotationsPage() {
  const { user } = useAuth();
  const { effective } = usePayProfile();
  const {
    items: patterns,
    loading,
    refresh,
  } = useCollection<RotationPatternRow>('rotation_patterns', {
    orderBy: 'created_at',
    ascending: false,
  });
  const { items: exceptionRows, refresh: refreshExceptions } = useCollection<RotationExceptionRow>(
    'rotation_exceptions',
    {
      orderBy: 'exception_date',
      ascending: true,
    },
  );

  const [rangeStart, setRangeStart] = useState(() => startOfWeek(todayIso()));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [templateKey, setTemplateKey] = useState<string>(ROTATION_TEMPLATES[0].key);
  const [startDate, setStartDate] = useState(todayIso());
  const [saving, setSaving] = useState(false);

  const activePattern = patterns.find((pattern) => pattern.is_active) ?? patterns[0] ?? null;

  const pattern: RotationPattern | null = useMemo(() => {
    if (!activePattern) return null;
    return {
      id: activePattern.id,
      name: activePattern.name,
      patternLength: activePattern.pattern_length,
      days: (activePattern.days as RotationDay[]) ?? [],
      startDate: activePattern.start_date,
      endDate: activePattern.end_date,
      sundayTreatment: activePattern.sunday_treatment,
      defaultStartTime: activePattern.default_start_time ?? undefined,
      defaultEndTime: activePattern.default_end_time ?? undefined,
      defaultUnpaidBreakMinutes: activePattern.default_unpaid_break_minutes,
      defaultDesignation: activePattern.default_designation,
    };
  }, [activePattern]);

  const exceptions = useMemo(
    () =>
      exceptionRows
        .filter((row) => !activePattern || row.rotation_pattern_id === activePattern.id)
        .map((row) => ({
          id: row.id,
          date: row.exception_date,
          kind: row.kind,
          hours: row.hours,
          startTime: row.start_time,
          endTime: row.end_time,
          designation: row.designation,
          paid: row.paid,
          note: row.note,
        })),
    [exceptionRows, activePattern],
  );

  const rangeEnd = addDays(rangeStart, HORIZON_DAYS - 1);

  const shifts = useMemo(
    () => (pattern ? generateRotationShifts(pattern, rangeStart, rangeEnd, exceptions) : []),
    [pattern, rangeStart, rangeEnd, exceptions],
  );

  const weeks = useMemo(() => shiftsToWeeks(shifts), [shifts]);

  /** Forecast gross from the generated schedule, priced week by week. */
  const forecast = useMemo(() => {
    if (!pattern || effective.baseRate <= 0) return null;
    let gross = 0;
    let hours = 0;
    for (const week of weeks) {
      const buckets = bucketWeek(week.days, {
        ...effective.rules,
        sundayTreatment: pattern.sundayTreatment ?? effective.rules.sundayTreatment,
      });
      // Priced at the designation the week is actually worked on.
      const designation =
        week.designations.find((value) => value !== null) ?? effective.defaultDesignation;
      const rate = effectiveRate(effective.baseRate, designation, effective.premiums);
      gross += grossFromBuckets(buckets, rate, effective.rules);
      hours += week.days.reduce((sum, value) => sum + value, 0);
    }
    return { gross, hours, weeks: weeks.length };
  }, [weeks, pattern, effective]);

  async function createFromTemplate() {
    if (!user) return;
    const template = ROTATION_TEMPLATES.find((entry) => entry.key === templateKey);
    if (!template) return;

    setSaving(true);
    setError(null);
    try {
      const built = template.build(startDate);
      await insertRow('rotation_patterns', user.id, {
        name: built.name,
        pattern_length: built.patternLength,
        days: built.days,
        start_date: built.startDate,
        sunday_treatment: built.sundayTreatment ?? 'regular',
        default_unpaid_break_minutes: built.defaultUnpaidBreakMinutes ?? 0,
        default_designation: built.defaultDesignation ?? 'day',
        is_active: true,
      });
      setCreating(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that rotation.');
    } finally {
      setSaving(false);
    }
  }

  async function saveException(date: string, kind: ExceptionKind, hours: number | null) {
    if (!user || !activePattern) return;
    setError(null);
    try {
      await upsertRow(
        'rotation_exceptions',
        {
          user_id: user.id,
          rotation_pattern_id: activePattern.id,
          exception_date: date,
          kind,
          hours,
        },
        'rotation_pattern_id,exception_date',
      );
      await refreshExceptions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that change.');
    }
  }

  if (loading) return <LoadingState label="Loading your rotation…" />;

  return (
    <>
      <PageHeader
        title="Rotation calendar"
        feature="rotation_automation"
        description="Define your rotation once and NetShift fills in the schedule — and feeds it into your forecast, your plan, and your goals."
      />

      <ErrorMessage>{error}</ErrorMessage>

      <ProGate
        feature="rotation_automation"
        preview={
          <Panel title="Your rotation">
            <div className="ns-rot__grid">
              {Array.from({ length: 14 }, (_, index) => (
                <div key={index} className="ns-rot__day">
                  <span className="ns-rot__date">Day {index + 1}</span>
                  <span className="ns-rot__label">Nights</span>
                  <span className="ns-rot__hours">8.00</span>
                </div>
              ))}
            </div>
          </Panel>
        }
      >
        {!pattern ? (
          <Panel title="Set up your rotation">
            {!creating ? (
              <EmptyState
                title="No rotation yet"
                icon="◷"
                action={
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Start from a template
                  </Button>
                }
              >
                A six-week rotation with mandatory Saturdays is completely predictable — NetShift
                can fill in your calendar from it and stop you entering the same hours every week.
              </EmptyState>
            ) : (
              <>
                <Grid min={200}>
                  <SelectField
                    label="Pattern"
                    value={templateKey}
                    onChange={(event) => setTemplateKey(event.target.value)}
                  >
                    {ROTATION_TEMPLATES.map((template) => (
                      <option key={template.key} value={template.key}>
                        {template.label}
                      </option>
                    ))}
                  </SelectField>
                  <TextField
                    label="First day of the cycle"
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    hint="The day your rotation's first block started."
                  />
                </Grid>
                <Callout tone="neutral">
                  Templates are a starting point — every day, time, and break is editable once it is
                  created, and exceptions handle the days that differ.
                </Callout>
                <div className="ns-review__actions">
                  <Button
                    variant="primary"
                    loading={saving}
                    onClick={() => void createFromTemplate()}
                  >
                    Create this rotation
                  </Button>
                  <Button variant="ghost" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </Panel>
        ) : (
          <>
            <Panel
              title={pattern.name}
              description={`A ${pattern.patternLength}-day cycle that started ${formatIsoDate(pattern.startDate)}.`}
              actions={
                <ConfirmButton
                  variant="link"
                  onConfirm={async () => {
                    if (!user || !activePattern) return;
                    await deleteRow('rotation_patterns', activePattern.id, user.id);
                    await refresh();
                  }}
                >
                  Delete rotation
                </ConfirmButton>
              }
            >
              {forecast && (
                <Grid min={165}>
                  <Stat
                    label={`Scheduled hours (${forecast.weeks} weeks)`}
                    value={fmtHours(forecast.hours)}
                  />
                  <Stat
                    label="Forecast gross"
                    value={fmtMoney(forecast.gross)}
                    estimated
                    sub="Priced week by week, with your overtime rules"
                  />
                  <Stat
                    label="Average per week"
                    value={fmtHours(forecast.hours / Math.max(1, forecast.weeks))}
                  />
                </Grid>
              )}

              <div className="ns-rot__nav">
                <Button variant="ghost" onClick={() => setRangeStart(addDays(rangeStart, -28))}>
                  ← Earlier
                </Button>
                <span className="ns-rot__range">
                  {formatIsoDateShort(rangeStart)} – {formatIsoDateShort(rangeEnd)}
                </span>
                <Button variant="ghost" onClick={() => setRangeStart(addDays(rangeStart, 28))}>
                  Later →
                </Button>
              </div>

              <RotationCalendar
                shifts={shifts}
                onSetException={(date, kind, hours) => void saveException(date, kind, hours)}
              />

              <Callout tone="neutral">
                These days are generated from the pattern, not stored one by one — so changing the
                rotation updates every future day at once. Only the exceptions you set are saved.
              </Callout>
            </Panel>

            <Panel title="Exceptions">
              <DataTable
                caption="Rotation exceptions"
                columns={[
                  {
                    key: 'date',
                    header: 'Date',
                    render: (row: RotationExceptionRow) => formatIsoDate(row.exception_date),
                  },
                  {
                    key: 'kind',
                    header: 'What happened',
                    render: (row: RotationExceptionRow) => EXCEPTION_LABELS[row.kind],
                  },
                  {
                    key: 'hours',
                    header: 'Hours',
                    align: 'right',
                    render: (row: RotationExceptionRow) =>
                      row.hours === null ? '—' : fmtHours(row.hours),
                  },
                  {
                    key: 'actions',
                    header: '',
                    align: 'right',
                    render: (row: RotationExceptionRow) => (
                      <ConfirmButton
                        variant="link"
                        onConfirm={async () => {
                          if (!user) return;
                          await deleteRow('rotation_exceptions', row.id, user.id);
                          await refreshExceptions();
                        }}
                      >
                        Remove
                      </ConfirmButton>
                    ),
                  },
                ]}
                rows={exceptionRows.filter(
                  (row) => !activePattern || row.rotation_pattern_id === activePattern.id,
                )}
                getKey={(row) => row.id}
                empty={
                  <EmptyState title="No exceptions" icon="✓">
                    Tap any day in the calendar to mark PTO, a call-in, training, or an extra shift.
                  </EmptyState>
                }
              />
            </Panel>
          </>
        )}
      </ProGate>
    </>
  );
}

function RotationCalendar({
  shifts,
  onSetException,
}: {
  shifts: GeneratedShift[];
  onSetException: (date: string, kind: ExceptionKind, hours: number | null) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [kind, setKind] = useState<ExceptionKind>('pto');
  const [hours, setHours] = useState('8');
  const today = todayIso();

  return (
    <>
      <div className="ns-rot__grid">
        {shifts.map((shift) => (
          <button
            key={shift.date}
            type="button"
            className={[
              'ns-rot__day',
              shift.working ? 'ns-rot__day--working' : 'ns-rot__day--off',
              shift.exception ? 'ns-rot__day--exception' : '',
              shift.date === today ? 'ns-rot__day--today' : '',
              shift.isSunday ? 'ns-rot__day--sunday' : '',
            ].join(' ')}
            onClick={() => {
              setEditing(shift.date);
              setHours(String(shift.paidHours || 8));
            }}
            aria-label={`${formatIsoDate(shift.date)}: ${shift.label}, ${shift.paidHours} hours. Tap to change.`}
          >
            <span className="ns-rot__date">{formatIsoDateShort(shift.date)}</span>
            <span className="ns-rot__label">{shift.label}</span>
            <span className="ns-rot__hours tabular">
              {shift.paidHours > 0 ? shift.paidHours.toFixed(2) : '—'}
            </span>
            {shift.crossesMidnight && (
              <span className="ns-rot__flag" title="Runs past midnight">
                +1
              </span>
            )}
          </button>
        ))}
      </div>

      {editing && (
        <Panel title={`Change ${formatIsoDate(editing)}`} tone="warning">
          <Grid min={170}>
            <SelectField
              label="What happened"
              value={kind}
              onChange={(event) => setKind(event.target.value as ExceptionKind)}
            >
              {(Object.keys(EXCEPTION_LABELS) as ExceptionKind[]).map((value) => (
                <option key={value} value={value}>
                  {EXCEPTION_LABELS[value]}
                </option>
              ))}
            </SelectField>
            <NumberField
              label="Paid hours"
              step="0.25"
              min="0"
              max="24"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              hint="Leave 0 for a day not worked and not paid."
            />
          </Grid>
          <div className="ns-review__actions">
            <Button
              variant="primary"
              onClick={() => {
                onSetException(editing, kind, num(hours));
                setEditing(null);
              }}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
      )}
    </>
  );
}
