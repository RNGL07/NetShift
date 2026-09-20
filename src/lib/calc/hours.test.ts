import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERTIME_RULES,
  bucketWeek,
  effectiveRate,
  grossFromBuckets,
  marginalWeekBuckets,
  paychecksPerYear,
  regularHoursThreshold,
  weeksInPeriod,
  type OvertimeRules,
} from './hours';

const rules = DEFAULT_OVERTIME_RULES;

describe('bucketWeek — daily overtime', () => {
  it('pays the first 8 hours of a day at straight time and the rest as overtime', () => {
    const result = bucketWeek([10, 0, 0, 0, 0, 0, 0], rules);
    expect(result).toEqual({ regular: 8, overtime: 2, doubleTime: 0 });
  });

  it('treats an exactly-8-hour day as entirely regular', () => {
    const result = bucketWeek([8, 8, 8, 8, 8, 0, 0], rules);
    expect(result).toEqual({ regular: 40, overtime: 0, doubleTime: 0 });
  });

  it('accumulates daily overtime across several long days', () => {
    const result = bucketWeek([10, 10, 10, 0, 0, 0, 0], rules);
    expect(result).toEqual({ regular: 24, overtime: 6, doubleTime: 0 });
  });
});

describe('bucketWeek — weekly overtime', () => {
  it('pays hours past 40 as overtime when no single day exceeds 8', () => {
    // Six 7-hour days = 42 hours, none of them over the daily threshold.
    const result = bucketWeek([7, 7, 7, 7, 7, 7, 0], rules);
    expect(result).toEqual({ regular: 40, overtime: 2, doubleTime: 0 });
  });

  it('does not count an hour as both daily and weekly overtime', () => {
    // Five 10-hour days: 50 hours total.
    // Daily OT removes 2/day = 10 hrs, leaving a 40-hour regular pool, which is
    // exactly the weekly threshold — so weekly OT must be zero, not another 10.
    const result = bucketWeek([10, 10, 10, 10, 10, 0, 0], rules);
    expect(result).toEqual({ regular: 40, overtime: 10, doubleTime: 0 });
    expect(result.regular + result.overtime).toBe(50);
  });

  it('applies both rules when the regular pool still exceeds 40', () => {
    // Six 10-hour days: 60 hours. Daily OT = 12, pool = 48, weekly OT = 8.
    const result = bucketWeek([10, 10, 10, 10, 10, 10, 0], rules);
    expect(result).toEqual({ regular: 40, overtime: 20, doubleTime: 0 });
    expect(result.regular + result.overtime).toBe(60);
  });
});

describe('bucketWeek — Sunday treatment', () => {
  const week = [8, 8, 8, 8, 8, 0, 8] as const;

  it('adds Sunday to regular hours when configured as regular', () => {
    expect(bucketWeek(week, { ...rules, sundayTreatment: 'regular' })).toEqual({
      regular: 48,
      overtime: 0,
      doubleTime: 0,
    });
  });

  it('adds Sunday to overtime when configured as overtime', () => {
    expect(bucketWeek(week, { ...rules, sundayTreatment: 'ot' })).toEqual({
      regular: 40,
      overtime: 8,
      doubleTime: 0,
    });
  });

  it('adds Sunday to double time when configured as double time', () => {
    expect(bucketWeek(week, { ...rules, sundayTreatment: 'double' })).toEqual({
      regular: 40,
      overtime: 0,
      doubleTime: 8,
    });
  });

  it('keeps Sunday hours out of the weekly 40-hour threshold', () => {
    // 40 hours Mon–Fri plus 12 on Sunday. Sunday must not push Mon–Fri into OT.
    const result = bucketWeek([8, 8, 8, 8, 8, 0, 12], { ...rules, sundayTreatment: 'double' });
    expect(result).toEqual({ regular: 40, overtime: 0, doubleTime: 12 });
  });

  it('does not apply the daily threshold to a long Sunday', () => {
    const result = bucketWeek([0, 0, 0, 0, 0, 0, 12], { ...rules, sundayTreatment: 'regular' });
    expect(result).toEqual({ regular: 12, overtime: 0, doubleTime: 0 });
  });
});

describe('bucketWeek — configurable rules', () => {
  it('honours a 12-hour daily threshold', () => {
    const twelveHourRules: OvertimeRules = { ...rules, dailyThreshold: 12, weeklyThreshold: null };
    expect(bucketWeek([12, 12, 14, 0, 0, 0, 0], twelveHourRules)).toEqual({
      regular: 36,
      overtime: 2,
      doubleTime: 0,
    });
  });

  it('disables daily overtime when the threshold is null', () => {
    const weeklyOnly: OvertimeRules = { ...rules, dailyThreshold: null };
    expect(bucketWeek([12, 12, 12, 12, 0, 0, 0], weeklyOnly)).toEqual({
      regular: 40,
      overtime: 8,
      doubleTime: 0,
    });
  });

  it('ignores blank and negative entries rather than producing NaN', () => {
    const result = bucketWeek(['', null, undefined, -5, '8', 0, 0], rules);
    expect(result).toEqual({ regular: 8, overtime: 0, doubleTime: 0 });
  });
});

describe('marginalWeekBuckets', () => {
  it('prices an added shift on an empty week as regular time', () => {
    const result = marginalWeekBuckets([0, 0, 0, 0, 0, 0, 0], [8, 0, 0, 0, 0, 0, 0], rules);
    expect(result).toEqual({ regular: 8, overtime: 0, doubleTime: 0 });
  });

  it('prices a Saturday after a full 40-hour week entirely as overtime', () => {
    const result = marginalWeekBuckets([8, 8, 8, 8, 8, 0, 0], [0, 0, 0, 0, 0, 8, 0], rules);
    expect(result).toEqual({ regular: 0, overtime: 8, doubleTime: 0 });
  });

  it('splits an added shift that straddles the weekly threshold', () => {
    // 36 hours already worked; an 8-hour Saturday takes the week to 44.
    const result = marginalWeekBuckets([9, 9, 9, 9, 0, 0, 0], [0, 0, 0, 0, 0, 8, 0], rules);
    // Prior: daily OT 4, pool 32, no weekly OT.
    // After: daily OT 4, pool 40, no weekly OT → 8 extra regular hours.
    expect(result).toEqual({ regular: 8, overtime: 0, doubleTime: 0 });
  });

  it('accounts for daily overtime on the day being extended', () => {
    // Already worked 6 hours today; adding 4 more takes the day to 10.
    const result = marginalWeekBuckets([6, 0, 0, 0, 0, 0, 0], [4, 0, 0, 0, 0, 0, 0], rules);
    expect(result).toEqual({ regular: 2, overtime: 2, doubleTime: 0 });
  });

  it('prices an added Sunday under the Sunday rule, not the weekly one', () => {
    const result = marginalWeekBuckets([8, 8, 8, 8, 8, 0, 0], [0, 0, 0, 0, 0, 0, 8], {
      ...rules,
      sundayTreatment: 'double',
    });
    expect(result).toEqual({ regular: 0, overtime: 0, doubleTime: 8 });
  });
});

describe('effectiveRate', () => {
  const premiums = { shiftPremium: 0.8, rolePremium: 2.25, hasRolePremium: false };

  it('leaves a day-shift rate alone', () => {
    expect(effectiveRate(40, 'day', premiums)).toBe(40);
  });

  it('adds the shift premium on evenings and nights', () => {
    expect(effectiveRate(40, 'evening', premiums)).toBeCloseTo(40.8, 10);
    expect(effectiveRate(40, 'night', premiums)).toBeCloseTo(40.8, 10);
  });

  it('adds the role premium when it applies, on any shift', () => {
    expect(effectiveRate(40, 'day', { ...premiums, hasRolePremium: true })).toBeCloseTo(42.25, 10);
    expect(effectiveRate(40, 'night', { ...premiums, hasRolePremium: true })).toBeCloseTo(
      43.05,
      10,
    );
  });
});

describe('grossFromBuckets', () => {
  it('applies the overtime and double-time multipliers', () => {
    const gross = grossFromBuckets({ regular: 40, overtime: 10, doubleTime: 8 }, 30, rules);
    // 40*30 + 10*45 + 8*60 = 1200 + 450 + 480
    expect(gross).toBe(2130);
  });

  it('prices premiums into overtime because they load onto the base rate first', () => {
    const withPremium = grossFromBuckets({ regular: 0, overtime: 10, doubleTime: 0 }, 30.8, rules);
    expect(withPremium).toBeCloseTo(462, 10);
  });
});

describe('period helpers', () => {
  it('reports weeks per period', () => {
    expect(weeksInPeriod('weekly')).toBe(1);
    expect(weeksInPeriod('biweekly')).toBe(2);
    expect(weeksInPeriod('monthly')).toBeCloseTo(52 / 12, 10);
  });

  it('reports paychecks per year', () => {
    expect(paychecksPerYear('biweekly')).toBe(26);
    expect(paychecksPerYear('semimonthly')).toBe(24);
  });

  it('scales the straight-time threshold with the period', () => {
    expect(regularHoursThreshold('weekly', rules)).toBe(40);
    expect(regularHoursThreshold('biweekly', rules)).toBe(80);
  });
});
