import { describe, expect, it } from 'vitest';
import {
  fourOnFourOffTemplate,
  generateRotationShifts,
  scheduledHoursBetween,
  shiftsToWeeks,
  sixWeekRotationTemplate,
  weekdayDayShiftTemplate,
  type RotationException,
} from './rotation';

// 2026-03-02 is a Monday.
const MONDAY = '2026-03-02';

describe('generateRotationShifts — pattern expansion', () => {
  it('repeats a 7-day pattern across several weeks', () => {
    const pattern = weekdayDayShiftTemplate(MONDAY);
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-15');
    expect(shifts).toHaveLength(14);
    expect(shifts.filter((s) => s.working)).toHaveLength(10);
    expect(shifts[0].paidHours).toBe(8); // 07:00–15:30 less a 30-minute lunch
    expect(shifts[5].working).toBe(false); // Saturday
  });

  it('cycles a 42-day rotation through all three shift designations', () => {
    const pattern = sixWeekRotationTemplate(MONDAY);
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-04-12'); // 42 days
    expect(shifts).toHaveLength(42);
    const designations = new Set(shifts.filter((s) => s.working).map((s) => s.designation));
    expect([...designations].sort()).toEqual(['day', 'evening', 'night']);
  });

  it('wraps back to the start of the cycle after one full pattern length', () => {
    const pattern = fourOnFourOffTemplate(MONDAY);
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-17');
    expect(shifts[0].working).toBe(true);
    expect(shifts[4].working).toBe(false);
    expect(shifts[8].working).toBe(true); // day 8 = start of the next cycle
    expect(shifts[8].paidHours).toBe(shifts[0].paidHours);
  });

  it('computes cross-midnight night-shift hours correctly', () => {
    const pattern = sixWeekRotationTemplate(MONDAY);
    const shifts = generateRotationShifts(pattern, MONDAY, MONDAY);
    expect(shifts[0].designation).toBe('night');
    expect(shifts[0].crossesMidnight).toBe(true);
    expect(shifts[0].paidHours).toBe(8); // 22:30–07:00 less 30 minutes
  });

  it('does not generate days before the pattern starts', () => {
    const pattern = weekdayDayShiftTemplate('2026-03-09');
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-15');
    expect(shifts[0].date).toBe('2026-03-09');
  });

  it('stops at the pattern end date', () => {
    const pattern = { ...weekdayDayShiftTemplate(MONDAY), endDate: '2026-03-06' };
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-15');
    expect(shifts[shifts.length - 1].date).toBe('2026-03-06');
  });

  it('caps generation rather than materialising unbounded days', () => {
    const pattern = weekdayDayShiftTemplate(MONDAY);
    const shifts = generateRotationShifts(pattern, MONDAY, '2030-01-01', [], { maxDays: 30 });
    expect(shifts).toHaveLength(30);
  });

  it('returns nothing for an inverted range', () => {
    expect(generateRotationShifts(weekdayDayShiftTemplate(MONDAY), '2026-03-15', MONDAY)).toEqual(
      [],
    );
  });

  it('flags Sundays so Sunday pay rules can be applied downstream', () => {
    const shifts = generateRotationShifts(sixWeekRotationTemplate(MONDAY), MONDAY, '2026-03-08');
    expect(shifts[6].isSunday).toBe(true);
  });
});

describe('generateRotationShifts — exceptions', () => {
  const pattern = weekdayDayShiftTemplate(MONDAY);
  const exception = (over: Partial<RotationException>): RotationException => ({
    id: 'e1',
    date: '2026-03-04',
    kind: 'pto',
    ...over,
  });

  it('keeps PTO hours paid', () => {
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-06', [
      exception({ kind: 'pto', hours: 8 }),
    ]);
    const day = shifts.find((s) => s.date === '2026-03-04')!;
    expect(day.paidHours).toBe(8);
    expect(day.label).toBe('PTO');
    expect(day.fromPattern).toBe(false);
  });

  it('zeroes out unpaid leave', () => {
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-06', [
      exception({ kind: 'unpaid_leave' }),
    ]);
    const day = shifts.find((s) => s.date === '2026-03-04')!;
    expect(day.paidHours).toBe(0);
    expect(day.working).toBe(false);
  });

  it('zeroes out a call-in', () => {
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-06', [
      exception({ kind: 'call_in' }),
    ]);
    expect(shifts.find((s) => s.date === '2026-03-04')!.paidHours).toBe(0);
  });

  it('adds an extra shift on a scheduled day off', () => {
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-08', [
      exception({ date: '2026-03-07', kind: 'extra_shift', hours: 10 }),
    ]);
    const saturday = shifts.find((s) => s.date === '2026-03-07')!;
    expect(saturday.working).toBe(true);
    expect(saturday.paidHours).toBe(10);
  });

  it('lets an exception override the clock times', () => {
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-06', [
      exception({ kind: 'edited', startTime: '06:00', endTime: '18:00' }),
    ]);
    const day = shifts.find((s) => s.date === '2026-03-04')!;
    expect(day.paidHours).toBe(11.5); // 12 hours less the 30-minute lunch
  });

  it('honours an explicit unpaid flag on a normally-paid kind', () => {
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-06', [
      exception({ kind: 'training', paid: false }),
    ]);
    expect(shifts.find((s) => s.date === '2026-03-04')!.paidHours).toBe(0);
  });

  it('leaves untouched days marked as coming from the pattern', () => {
    const shifts = generateRotationShifts(pattern, MONDAY, '2026-03-06', [exception({ hours: 8 })]);
    expect(shifts.find((s) => s.date === '2026-03-03')!.fromPattern).toBe(true);
  });
});

describe('shiftsToWeeks', () => {
  it('folds generated shifts into Monday-first week arrays', () => {
    const shifts = generateRotationShifts(weekdayDayShiftTemplate(MONDAY), MONDAY, '2026-03-15');
    const weeks = shiftsToWeeks(shifts);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].weekStart).toBe(MONDAY);
    expect(weeks[0].days).toEqual([8, 8, 8, 8, 8, 0, 0]);
  });

  it('starts a new week on the correct Monday even mid-pattern', () => {
    const shifts = generateRotationShifts(
      weekdayDayShiftTemplate(MONDAY),
      '2026-03-05',
      '2026-03-11',
    );
    const weeks = shiftsToWeeks(shifts);
    expect(weeks.map((w) => w.weekStart)).toEqual([MONDAY, '2026-03-09']);
    expect(weeks[0].days).toEqual([0, 0, 0, 8, 8, 0, 0]);
  });

  it('attributes a night shift’s hours to the day it starts', () => {
    const shifts = generateRotationShifts(sixWeekRotationTemplate(MONDAY), MONDAY, '2026-03-08');
    const weeks = shiftsToWeeks(shifts);
    // Monday's 22:30 start belongs to Monday, not Tuesday.
    expect(weeks[0].days[0]).toBe(8);
  });
});

describe('scheduledHoursBetween', () => {
  it('sums paid hours inside an inclusive range', () => {
    const shifts = generateRotationShifts(weekdayDayShiftTemplate(MONDAY), MONDAY, '2026-03-15');
    expect(scheduledHoursBetween(shifts, MONDAY, '2026-03-08')).toBe(40);
    expect(scheduledHoursBetween(shifts, MONDAY, '2026-03-15')).toBe(80);
  });
});
