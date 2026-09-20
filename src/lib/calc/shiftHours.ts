/**
 * Clock times → paid hours.
 *
 * Shift workers on a rotation enter "18:00 to 06:30, 30 minute unpaid lunch",
 * not a decimal. A night shift's end time is *earlier* than its start time, so
 * naive subtraction produces a negative span — every consumer of this module
 * (rotation generation, shift logging, "is this shift worth it?") would then
 * silently under-count a night worker's entire year.
 */

import { roundTo } from './money';

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Parses `HH:MM` into minutes past midnight, or `null` if malformed. */
export function parseClockTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClockTime(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface ShiftSpanInput {
  start: string;
  end: string;
  /** Unpaid break minutes (lunch). Subtracted from paid time. */
  unpaidBreakMinutes?: number;
  /** Paid break minutes. Recorded for transparency; already inside the span. */
  paidBreakMinutes?: number;
}

export interface ShiftSpan {
  startMinutes: number;
  endMinutes: number;
  /** Total clock time between start and end, in hours. */
  spanHours: number;
  /** `spanHours` less unpaid breaks — what actually gets paid. */
  paidHours: number;
  paidBreakHours: number;
  unpaidBreakHours: number;
  /** True when the shift runs past midnight into the next calendar day. */
  crossesMidnight: boolean;
}

/**
 * Computes the paid length of one shift.
 *
 * A shift whose end time is at or before its start time is treated as running
 * into the next day (a 22:00–06:00 night shift is 8 hours, not −16). An exactly
 * equal start and end is read as a full 24 hours rather than zero, because a
 * zero-length shift is never what someone meant to enter.
 */
export function shiftSpan(input: ShiftSpanInput): ShiftSpan | null {
  const startMinutes = parseClockTime(input.start);
  const endMinutes = parseClockTime(input.end);
  if (startMinutes === null || endMinutes === null) return null;

  const crossesMidnight = endMinutes <= startMinutes;
  const spanMinutes = crossesMidnight
    ? 1440 - startMinutes + endMinutes
    : endMinutes - startMinutes;

  const unpaid = Math.max(0, input.unpaidBreakMinutes ?? 0);
  const paidBreak = Math.max(0, input.paidBreakMinutes ?? 0);
  const paidMinutes = Math.max(0, spanMinutes - unpaid);

  return {
    startMinutes,
    endMinutes,
    spanHours: roundTo(spanMinutes / 60, 2),
    paidHours: roundTo(paidMinutes / 60, 2),
    paidBreakHours: roundTo(paidBreak / 60, 2),
    unpaidBreakHours: roundTo(unpaid / 60, 2),
    crossesMidnight,
  };
}

/**
 * Which calendar day a cross-midnight shift's hours belong to.
 *
 * Employers differ: some pay a night shift against the day it *started*, some
 * split it at midnight. NetShift attributes the whole shift to its start date
 * (the common manufacturing convention) and says so in the UI, rather than
 * guessing a split the user cannot verify.
 */
export const SHIFT_DAY_ATTRIBUTION = 'start-date' as const;

/** Adds a shift's paid hours to the right slot of a Mon-first week array. */
export function applyShiftToWeek(
  week: readonly number[],
  dayIndexMonFirst: number,
  paidHours: number,
): number[] {
  const next = Array.from({ length: 7 }, (_, i) => week[i] ?? 0);
  if (dayIndexMonFirst >= 0 && dayIndexMonFirst < 7) {
    next[dayIndexMonFirst] += paidHours;
  }
  return next;
}
