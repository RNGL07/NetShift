import { describe, expect, it } from 'vitest';
import { applyShiftToWeek, formatClockTime, parseClockTime, shiftSpan } from './shiftHours';

describe('parseClockTime', () => {
  it('parses valid 24-hour times', () => {
    expect(parseClockTime('00:00')).toBe(0);
    expect(parseClockTime('06:30')).toBe(390);
    expect(parseClockTime('23:59')).toBe(1439);
    expect(parseClockTime('6:00')).toBe(360);
  });

  it('rejects malformed and out-of-range values', () => {
    expect(parseClockTime('24:00')).toBeNull();
    expect(parseClockTime('12:60')).toBeNull();
    expect(parseClockTime('noon')).toBeNull();
    expect(parseClockTime('')).toBeNull();
    expect(parseClockTime(null)).toBeNull();
  });
});

describe('shiftSpan — cross-midnight shifts', () => {
  it('measures a normal day shift', () => {
    const span = shiftSpan({ start: '06:00', end: '14:30' });
    expect(span?.spanHours).toBe(8.5);
    expect(span?.crossesMidnight).toBe(false);
  });

  it('measures a night shift that runs into the next day', () => {
    const span = shiftSpan({ start: '22:00', end: '06:00' });
    expect(span?.spanHours).toBe(8);
    expect(span?.paidHours).toBe(8);
    expect(span?.crossesMidnight).toBe(true);
  });

  it('measures the classic 22:30 to 07:00 night shift with an unpaid lunch', () => {
    const span = shiftSpan({ start: '22:30', end: '07:00', unpaidBreakMinutes: 30 });
    expect(span?.spanHours).toBe(8.5);
    expect(span?.paidHours).toBe(8);
    expect(span?.crossesMidnight).toBe(true);
  });

  it('never returns a negative span for a shift ending before it starts', () => {
    const span = shiftSpan({ start: '18:00', end: '02:00' });
    expect(span?.spanHours).toBeGreaterThan(0);
    expect(span?.spanHours).toBe(8);
  });

  it('reads an identical start and end as a full 24 hours, not zero', () => {
    const span = shiftSpan({ start: '08:00', end: '08:00' });
    expect(span?.spanHours).toBe(24);
    expect(span?.crossesMidnight).toBe(true);
  });

  it('subtracts unpaid breaks but not paid ones', () => {
    const span = shiftSpan({
      start: '06:00',
      end: '18:00',
      unpaidBreakMinutes: 60,
      paidBreakMinutes: 20,
    });
    expect(span?.spanHours).toBe(12);
    expect(span?.paidHours).toBe(11);
    expect(span?.paidBreakHours).toBeCloseTo(0.33, 2);
  });

  it('never returns negative paid hours when the break exceeds the shift', () => {
    const span = shiftSpan({ start: '06:00', end: '07:00', unpaidBreakMinutes: 120 });
    expect(span?.paidHours).toBe(0);
  });

  it('returns null for unparsable times', () => {
    expect(shiftSpan({ start: 'x', end: '06:00' })).toBeNull();
  });
});

describe('formatClockTime', () => {
  it('round-trips through parseClockTime', () => {
    expect(formatClockTime(390)).toBe('06:30');
    expect(formatClockTime(0)).toBe('00:00');
    expect(formatClockTime(1439)).toBe('23:59');
  });

  it('wraps past midnight', () => {
    expect(formatClockTime(1500)).toBe('01:00');
  });
});

describe('applyShiftToWeek', () => {
  it('adds hours to the right Monday-first slot', () => {
    expect(applyShiftToWeek([0, 0, 0, 0, 0, 0, 0], 5, 8)).toEqual([0, 0, 0, 0, 0, 8, 0]);
  });

  it('accumulates onto hours already on that day', () => {
    expect(applyShiftToWeek([4, 0, 0, 0, 0, 0, 0], 0, 6)).toEqual([10, 0, 0, 0, 0, 0, 0]);
  });

  it('ignores an out-of-range index rather than growing the array', () => {
    expect(applyShiftToWeek([0, 0, 0, 0, 0, 0, 0], 9, 8)).toHaveLength(7);
  });
});
