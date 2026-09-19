import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dayIndexMonFirst,
  daysBetween,
  formatIsoDate,
  isSunday,
  nextPayday,
  parseIsoDate,
  paydaySeries,
  startOfWeek,
  toIsoDate,
} from './dates';

describe('parseIsoDate', () => {
  it('parses to local midnight, not UTC', () => {
    const parsed = parseIsoDate('2026-03-01');
    // The whole point: the day must survive a negative UTC offset intact.
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(2);
    expect(parsed?.getDate()).toBe(1);
  });

  it('rejects impossible dates rather than rolling them over', () => {
    expect(parseIsoDate('2026-02-31')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('not-a-date')).toBeNull();
  });

  it('round-trips through toIsoDate', () => {
    expect(toIsoDate(parseIsoDate('2026-07-04')!)).toBe('2026-07-04');
  });
});

describe('addDays / daysBetween', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('counts days between dates, signed', () => {
    expect(daysBetween('2026-03-01', '2026-03-15')).toBe(14);
    expect(daysBetween('2026-03-15', '2026-03-01')).toBe(-14);
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(0);
  });

  it('counts across a DST transition as whole days', () => {
    // US DST springs forward on 2026-03-08. The gap must still be 7 days.
    expect(daysBetween('2026-03-05', '2026-03-12')).toBe(7);
  });
});

describe('addMonths', () => {
  it('clamps to the last day of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('keeps the day of month where it exists', () => {
    expect(addMonths('2026-03-15', 3)).toBe('2026-06-15');
  });
});

describe('weekday helpers', () => {
  it('indexes Monday as 0 and Sunday as 6', () => {
    expect(dayIndexMonFirst('2026-03-02')).toBe(0); // a Monday
    expect(dayIndexMonFirst('2026-03-08')).toBe(6); // a Sunday
  });

  it('identifies Sundays', () => {
    expect(isSunday('2026-03-08')).toBe(true);
    expect(isSunday('2026-03-09')).toBe(false);
  });

  it('finds the Monday of a week', () => {
    expect(startOfWeek('2026-03-08')).toBe('2026-03-02');
    expect(startOfWeek('2026-03-02')).toBe('2026-03-02');
  });
});

describe('nextPayday', () => {
  it('advances weekly and biweekly by fixed days', () => {
    expect(nextPayday('2026-03-06', 'weekly')).toBe('2026-03-13');
    expect(nextPayday('2026-03-06', 'biweekly')).toBe('2026-03-20');
  });

  it('advances monthly keeping the day of month', () => {
    expect(nextPayday('2026-03-15', 'monthly')).toBe('2026-04-15');
  });

  it('models semi-monthly as the 15th and the last day of the month', () => {
    expect(nextPayday('2026-03-01', 'semimonthly')).toBe('2026-03-15');
    expect(nextPayday('2026-03-15', 'semimonthly')).toBe('2026-03-31');
    expect(nextPayday('2026-03-31', 'semimonthly')).toBe('2026-04-15');
    expect(nextPayday('2026-02-28', 'semimonthly')).toBe('2026-03-15');
  });
});

describe('paydaySeries', () => {
  it('generates consecutive paydays including the first', () => {
    expect(paydaySeries('2026-03-06', 'biweekly', 3)).toEqual([
      '2026-03-06',
      '2026-03-20',
      '2026-04-03',
    ]);
  });

  it('returns nothing for a non-positive count', () => {
    expect(paydaySeries('2026-03-06', 'biweekly', 0)).toEqual([]);
  });
});

describe('formatIsoDate', () => {
  it('formats readable dates and falls back gracefully', () => {
    expect(formatIsoDate('2026-03-09')).toBe('Mar 9, 2026');
    expect(formatIsoDate(null)).toBe('—');
    expect(formatIsoDate('garbage')).toBe('garbage');
  });
});
