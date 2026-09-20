/**
 * Feature 7 — Rotation calendar automation.
 *
 * A six-week rotation (two weeks nights, two mids, two days, mandatory
 * Saturdays) is completely deterministic, so NetShift stores the *pattern* and
 * generates shifts on demand. Nothing is written to the database except the
 * pattern and the exceptions the user actually made — materialising three
 * years of rows would be tens of thousands of records that all become wrong
 * the moment the rotation changes.
 */

import { addDays, dayIndexMonFirst, daysBetween, isSunday, type IsoDate } from './dates';
import type { ShiftDesignation, SundayTreatment } from './hours';
import { nonNegative, roundTo } from './money';
import { shiftSpan } from './shiftHours';

export type ExceptionKind =
  'pto' | 'unpaid_leave' | 'call_in' | 'training' | 'holiday' | 'extra_shift' | 'edited';

export const EXCEPTION_LABELS: Record<ExceptionKind, string> = {
  pto: 'PTO',
  unpaid_leave: 'Unpaid leave',
  call_in: 'Called in',
  training: 'Training',
  holiday: 'Holiday',
  extra_shift: 'Extra shift',
  edited: 'Edited',
};

/** Whether hours for an exception kind are paid by default. */
export const EXCEPTION_PAID_BY_DEFAULT: Record<ExceptionKind, boolean> = {
  pto: true,
  unpaid_leave: false,
  call_in: false,
  training: true,
  holiday: true,
  extra_shift: true,
  edited: true,
};

export interface RotationDay {
  /** Position in the pattern, 0-based. */
  dayIndex: number;
  working: boolean;
  startTime?: string;
  endTime?: string;
  unpaidBreakMinutes?: number;
  paidBreakMinutes?: number;
  designation?: ShiftDesignation;
  /** Label shown on the calendar, e.g. "Nights" or "Off". */
  label?: string;
}

export interface RotationPattern {
  id: string;
  name: string;
  /** Number of days in one full cycle. */
  patternLength: number;
  days: RotationDay[];
  startDate: IsoDate;
  endDate?: IsoDate | null;
  /** How Sunday hours are paid under this pattern. */
  sundayTreatment?: SundayTreatment;
  /** Default clock times used for any day that does not override them. */
  defaultStartTime?: string;
  defaultEndTime?: string;
  defaultUnpaidBreakMinutes?: number;
  defaultDesignation?: ShiftDesignation;
}

export interface RotationException {
  id: string;
  date: IsoDate;
  kind: ExceptionKind;
  /** Overrides the generated hours. `0` means the day is not worked. */
  hours?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  designation?: ShiftDesignation | null;
  paid?: boolean | null;
  note?: string | null;
}

export interface GeneratedShift {
  date: IsoDate;
  working: boolean;
  paidHours: number;
  startTime: string | null;
  endTime: string | null;
  crossesMidnight: boolean;
  designation: ShiftDesignation;
  label: string;
  isSunday: boolean;
  /** Present when an exception changed this day. */
  exception: RotationException | null;
  /** `true` when the day's hours came from the pattern, untouched. */
  fromPattern: boolean;
}

export const MAX_GENERATED_DAYS = 400;

/**
 * Expands a rotation pattern into dated shifts for `[from, to]`.
 *
 * The cycle position is derived from the day offset since `startDate`, using a
 * modulo that stays correct for dates *before* the start (JS `%` yields a
 * negative remainder, which would silently read past the end of `days`).
 */
export function generateRotationShifts(
  pattern: RotationPattern,
  from: IsoDate,
  to: IsoDate,
  exceptions: readonly RotationException[] = [],
  options: { maxDays?: number } = {},
): GeneratedShift[] {
  const maxDays = options.maxDays ?? MAX_GENERATED_DAYS;
  const span = daysBetween(from, to);
  if (span < 0 || pattern.patternLength <= 0 || pattern.days.length === 0) return [];

  const exceptionsByDate = new Map<IsoDate, RotationException>();
  for (const exception of exceptions) exceptionsByDate.set(exception.date, exception);

  const dayByIndex = new Map<number, RotationDay>();
  for (const day of pattern.days) dayByIndex.set(day.dayIndex, day);

  const count = Math.min(span + 1, maxDays);
  const out: GeneratedShift[] = [];

  for (let i = 0; i < count; i++) {
    const date = addDays(from, i);

    if (daysBetween(pattern.startDate, date) < 0) continue;
    if (pattern.endDate && daysBetween(date, pattern.endDate) < 0) continue;

    const offset = daysBetween(pattern.startDate, date);
    const cycleIndex =
      ((offset % pattern.patternLength) + pattern.patternLength) % pattern.patternLength;
    const patternDay = dayByIndex.get(cycleIndex);

    const exception = exceptionsByDate.get(date) ?? null;
    const shift = resolveDay(pattern, patternDay, date, exception);
    out.push(shift);
  }

  return out;
}

function resolveDay(
  pattern: RotationPattern,
  patternDay: RotationDay | undefined,
  date: IsoDate,
  exception: RotationException | null,
): GeneratedShift {
  const designationDefault = pattern.defaultDesignation ?? 'day';
  const baseWorking = patternDay?.working ?? false;

  let startTime = patternDay?.startTime ?? pattern.defaultStartTime ?? null;
  let endTime = patternDay?.endTime ?? pattern.defaultEndTime ?? null;
  const unpaidBreak = patternDay?.unpaidBreakMinutes ?? pattern.defaultUnpaidBreakMinutes ?? 0;
  let designation: ShiftDesignation = patternDay?.designation ?? designationDefault;
  let label = patternDay?.label ?? (baseWorking ? designationLabel(designation) : 'Off');

  let working = baseWorking;
  let paidHours = 0;

  if (baseWorking && startTime && endTime) {
    const span = shiftSpan({ start: startTime, end: endTime, unpaidBreakMinutes: unpaidBreak });
    paidHours = span?.paidHours ?? 0;
  }

  let crossesMidnight = false;
  if (startTime && endTime) {
    crossesMidnight = shiftSpan({ start: startTime, end: endTime })?.crossesMidnight ?? false;
  }

  if (exception) {
    label = EXCEPTION_LABELS[exception.kind];
    if (exception.designation) designation = exception.designation;
    if (exception.startTime !== undefined && exception.startTime !== null)
      startTime = exception.startTime;
    if (exception.endTime !== undefined && exception.endTime !== null) endTime = exception.endTime;

    if (exception.startTime && exception.endTime) {
      const span = shiftSpan({
        start: exception.startTime,
        end: exception.endTime,
        unpaidBreakMinutes: unpaidBreak,
      });
      paidHours = span?.paidHours ?? paidHours;
      crossesMidnight = span?.crossesMidnight ?? crossesMidnight;
      working = true;
    }

    if (exception.hours !== undefined && exception.hours !== null) {
      paidHours = nonNegative(exception.hours);
      working = paidHours > 0;
    } else if (exception.kind === 'unpaid_leave' || exception.kind === 'call_in') {
      // Not worked and not paid unless the user says otherwise.
      paidHours = 0;
      working = false;
    }

    const paid = exception.paid ?? EXCEPTION_PAID_BY_DEFAULT[exception.kind];
    if (!paid) paidHours = 0;
    if (exception.kind === 'extra_shift' && paidHours > 0) working = true;
  }

  return {
    date,
    working,
    paidHours: roundTo(paidHours, 2),
    startTime: working ? startTime : null,
    endTime: working ? endTime : null,
    crossesMidnight: working ? crossesMidnight : false,
    designation,
    label,
    isSunday: isSunday(date),
    exception,
    fromPattern: exception === null,
  };
}

function designationLabel(designation: ShiftDesignation): string {
  return designation === 'night' ? 'Nights' : designation === 'evening' ? 'Mids' : 'Days';
}

/**
 * Folds generated shifts into Monday-first week arrays, which is the shape
 * every downstream calculator consumes.
 */
export function shiftsToWeeks(shifts: readonly GeneratedShift[]): {
  weekStart: IsoDate;
  days: number[];
  designations: (ShiftDesignation | null)[];
}[] {
  const weeks = new Map<IsoDate, { days: number[]; designations: (ShiftDesignation | null)[] }>();

  for (const shift of shifts) {
    const weekStart = addDays(shift.date, -dayIndexMonFirst(shift.date));
    if (!weeks.has(weekStart)) {
      weeks.set(weekStart, {
        days: [0, 0, 0, 0, 0, 0, 0],
        designations: [null, null, null, null, null, null, null],
      });
    }
    const week = weeks.get(weekStart)!;
    const index = dayIndexMonFirst(shift.date);
    week.days[index] += shift.paidHours;
    if (shift.paidHours > 0) week.designations[index] = shift.designation;
  }

  return [...weeks.entries()]
    .sort((a, b) => daysBetween(b[0], a[0]))
    .map(([weekStart, value]) => ({
      weekStart,
      days: value.days,
      designations: value.designations,
    }));
}

/** Total scheduled paid hours over a date range. */
export function scheduledHoursBetween(
  shifts: readonly GeneratedShift[],
  from: IsoDate,
  to: IsoDate,
): number {
  return roundTo(
    shifts
      .filter((s) => daysBetween(from, s.date) >= 0 && daysBetween(s.date, to) >= 0)
      .reduce((sum, s) => sum + s.paidHours, 0),
    2,
  );
}

/**
 * A six-week Toyota-style rotation, offered as a starting point users can edit.
 * Weeks 1–2 nights, 3–4 mids, 5–6 days, with a mandatory Saturday each week.
 * Not affiliated with, endorsed by, or sourced from any employer.
 */
export function sixWeekRotationTemplate(startDate: IsoDate): RotationPattern {
  const blocks: { designation: ShiftDesignation; start: string; end: string; label: string }[] = [
    { designation: 'night', start: '22:30', end: '07:00', label: 'Nights' },
    { designation: 'night', start: '22:30', end: '07:00', label: 'Nights' },
    { designation: 'evening', start: '14:30', end: '23:00', label: 'Mids' },
    { designation: 'evening', start: '14:30', end: '23:00', label: 'Mids' },
    { designation: 'day', start: '06:00', end: '14:30', label: 'Days' },
    { designation: 'day', start: '06:00', end: '14:30', label: 'Days' },
  ];

  const days: RotationDay[] = [];
  for (let week = 0; week < 6; week++) {
    const block = blocks[week];
    for (let dow = 0; dow < 7; dow++) {
      const dayIndex = week * 7 + dow;
      const isSaturday = dow === 5;
      const isSundayOff = dow === 6;
      const working = !isSundayOff;
      days.push({
        dayIndex,
        working,
        startTime: working ? block.start : undefined,
        endTime: working ? block.end : undefined,
        unpaidBreakMinutes: 30,
        paidBreakMinutes: 20,
        designation: block.designation,
        label: working ? (isSaturday ? `${block.label} (Sat)` : block.label) : 'Off',
      });
    }
  }

  return {
    id: 'template-six-week',
    name: '6-week rotation (2 nights / 2 mids / 2 days)',
    patternLength: 42,
    days,
    startDate,
    sundayTreatment: 'regular',
    defaultUnpaidBreakMinutes: 30,
    defaultDesignation: 'day',
  };
}

/** A plain Monday–Friday day-shift pattern. */
export function weekdayDayShiftTemplate(startDate: IsoDate): RotationPattern {
  const days: RotationDay[] = Array.from({ length: 7 }, (_, dayIndex) => {
    const working = dayIndex < 5;
    return {
      dayIndex,
      working,
      startTime: working ? '07:00' : undefined,
      endTime: working ? '15:30' : undefined,
      unpaidBreakMinutes: 30,
      designation: 'day' as ShiftDesignation,
      label: working ? 'Days' : 'Off',
    };
  });

  return {
    id: 'template-weekday',
    name: 'Monday–Friday days',
    patternLength: 7,
    days,
    startDate,
    sundayTreatment: 'regular',
    defaultUnpaidBreakMinutes: 30,
    defaultDesignation: 'day',
  };
}

/** A 4-on / 4-off 12-hour rotation, common in oil-field and process work. */
export function fourOnFourOffTemplate(startDate: IsoDate): RotationPattern {
  const days: RotationDay[] = Array.from({ length: 8 }, (_, dayIndex) => {
    const working = dayIndex < 4;
    return {
      dayIndex,
      working,
      startTime: working ? '06:00' : undefined,
      endTime: working ? '18:00' : undefined,
      unpaidBreakMinutes: 30,
      designation: 'day' as ShiftDesignation,
      label: working ? 'On (12 hr)' : 'Off',
    };
  });

  return {
    id: 'template-4on4off',
    name: '4 on / 4 off (12-hour days)',
    patternLength: 8,
    days,
    startDate,
    sundayTreatment: 'regular',
    defaultUnpaidBreakMinutes: 30,
    defaultDesignation: 'day',
  };
}

export const ROTATION_TEMPLATES = [
  {
    key: 'six-week',
    label: '6-week rotation (nights / mids / days)',
    build: sixWeekRotationTemplate,
  },
  { key: 'weekday', label: 'Monday–Friday days', build: weekdayDayShiftTemplate },
  { key: 'four-on-four-off', label: '4 on / 4 off (12-hour)', build: fourOnFourOffTemplate },
] as const;
