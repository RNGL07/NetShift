import { describe, expect, it } from 'vitest';
import { averageDeductionPct, hoursToPay, targetToHours } from './pay';
import { DEFAULT_OVERTIME_RULES } from './hours';

const premiums = { shiftPremium: 0.8, rolePremium: 2.25, hasRolePremium: false };

describe('hoursToPay', () => {
  it('prices a straight 40-hour week', () => {
    const result = hoursToPay({
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      weeks: [{ days: [8, 8, 8, 8, 8, 0, 0], sundayTreatment: 'regular', designation: 'day' }],
    });
    expect(result.gross).toBe(1600);
    expect(result.estimatedTakeHome).toBe(1200);
    expect(result.buckets).toEqual({ regular: 40, overtime: 0, doubleTime: 0 });
  });

  it('applies overtime across two weeks separately, never pooled', () => {
    const result = hoursToPay({
      baseRate: 40,
      payPeriod: 'biweekly',
      deductionPct: 0,
      weeks: [
        { days: [8, 8, 8, 8, 8, 8, 0], sundayTreatment: 'regular', designation: 'day' },
        { days: [8, 8, 8, 8, 0, 0, 0], sundayTreatment: 'regular', designation: 'day' },
      ],
    });
    // Week 1: 48 hrs → 40 reg + 8 OT. Week 2: 32 reg. Pooling would have
    // produced 80 reg with no overtime at all.
    expect(result.buckets).toEqual({ regular: 72, overtime: 8, doubleTime: 0 });
    expect(result.gross).toBe(72 * 40 + 8 * 60);
  });

  it('adds per diem after withholding, never before', () => {
    const result = hoursToPay({
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      perDiemRate: 50,
      perDiemDaysPerWeek: 5,
      weeks: [{ days: [8, 8, 8, 8, 8, 0, 0], sundayTreatment: 'regular', designation: 'day' }],
    });
    expect(result.perDiemTotal).toBe(250);
    expect(result.estimatedTakeHomeBeforePerDiem).toBe(1200);
    // 1200 + 250, not (1600 + 250) * 0.75.
    expect(result.estimatedTakeHome).toBe(1450);
  });

  it('doubles per diem for a biweekly period', () => {
    const result = hoursToPay({
      baseRate: 40,
      payPeriod: 'biweekly',
      deductionPct: 0,
      perDiemRate: 50,
      perDiemDaysPerWeek: 5,
      weeks: [
        { days: [8, 8, 8, 8, 8, 0, 0], sundayTreatment: 'regular', designation: 'day' },
        { days: [8, 8, 8, 8, 8, 0, 0], sundayTreatment: 'regular', designation: 'day' },
      ],
    });
    expect(result.perDiemTotal).toBe(500);
  });

  it('prices each week at its own shift differential', () => {
    const result = hoursToPay({
      baseRate: 40,
      payPeriod: 'biweekly',
      deductionPct: 0,
      premiums,
      weeks: [
        { days: [8, 8, 8, 8, 8, 0, 0], sundayTreatment: 'regular', designation: 'night' },
        { days: [8, 8, 8, 8, 8, 0, 0], sundayTreatment: 'regular', designation: 'day' },
      ],
    });
    expect(result.gross).toBe(40 * 40.8 + 40 * 40);
    expect(result.effectiveRates).toEqual([
      { label: 'Week 1', rate: 40.8 },
      { label: 'Week 2', rate: 40 },
    ]);
  });

  it('prices Sunday at double time when the profile says so', () => {
    const result = hoursToPay({
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 0,
      weeks: [{ days: [8, 8, 8, 8, 8, 0, 8], sundayTreatment: 'double', designation: 'day' }],
    });
    expect(result.buckets).toEqual({ regular: 40, overtime: 0, doubleTime: 8 });
    expect(result.gross).toBe(40 * 40 + 8 * 80);
  });

  it('accepts hours entered as period totals without applying an overtime rule', () => {
    const result = hoursToPay({
      baseRate: 40,
      payPeriod: 'biweekly',
      deductionPct: 20,
      totals: { regularHours: 80, overtimeHours: 12, doubleTimeHours: 0, designation: 'day' },
    });
    expect(result.gross).toBe(80 * 40 + 12 * 60);
    expect(result.note).toContain('period totals');
  });

  it('returns an empty result rather than NaN when nothing is entered', () => {
    const result = hoursToPay({ baseRate: 0, payPeriod: 'weekly', deductionPct: 25 });
    expect(result.gross).toBe(0);
    expect(result.totalHours).toBe(0);
    expect(result.note).toBe('No hours entered.');
  });

  it('emits a line item per bucket so the UI can show its working', () => {
    const result = hoursToPay({
      baseRate: 30,
      payPeriod: 'weekly',
      deductionPct: 0,
      weeks: [{ days: [10, 10, 10, 10, 10, 0, 8], sundayTreatment: 'double', designation: 'day' }],
    });
    expect(result.lines.map((l) => l.label)).toEqual(['regular', 'overtime', 'double time']);
    expect(result.lines.reduce((sum, l) => sum + l.amount, 0)).toBeCloseTo(result.gross, 2);
  });
});

describe('targetToHours', () => {
  it('solves straight time with no overtime assumption', () => {
    const result = targetToHours({
      targetTakeHome: 1200,
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      assumeOvertime: false,
    });
    expect(result.grossNeeded).toBe(1600);
    expect(result.hours).toBe(40);
  });

  it('splits into straight time then overtime past the threshold', () => {
    const result = targetToHours({
      targetTakeHome: 1800,
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      assumeOvertime: true,
    });
    // Gross needed 2400. 40 hrs straight = 1600, remaining 800 at $60 = 13.33 OT hrs.
    expect(result.grossNeeded).toBe(2400);
    expect(result.hours).toBeCloseTo(53.33, 2);
    expect(result.buckets.regular).toBe(40);
    expect(result.buckets.overtime).toBeCloseTo(13.33, 2);
  });

  it('stays on straight time when the target is below the threshold', () => {
    const result = targetToHours({
      targetTakeHome: 600,
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      assumeOvertime: true,
    });
    expect(result.hours).toBe(20);
    expect(result.buckets.overtime).toBe(0);
  });

  it('solves the 7-day week with Sunday at double time', () => {
    const result = targetToHours({
      targetTakeHome: 1500,
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      assumeOvertime: false,
      daysPerWeek: 7,
      sundayDoubleTime: true,
    });
    // Gross 2000. Per-day hours x: 6 days at 1x + 1 day at 2x = 8x hours' worth
    // of pay → 8 * x * 40 = 2000 → x = 6.25, total 7x = 43.75.
    expect(result.grossNeeded).toBe(2000);
    expect(result.hours).toBeCloseTo(43.75, 2);
  });

  it('solves the 7-day Sunday-double case when the rest tips into overtime', () => {
    const result = targetToHours({
      targetTakeHome: 3000,
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      assumeOvertime: true,
      daysPerWeek: 7,
      sundayDoubleTime: true,
    });
    // The solved answer must reproduce the target gross when priced back.
    // `hours` is rounded to 2dp for display, so reconstructing x from it
    // carries a few cents of error at this scale — compare to the dollar.
    const x = result.hours / 7;
    const nonSunday = 6 * x;
    const gross = 40 * 40 + (nonSunday - 40) * 60 + x * 80;
    expect(gross).toBeCloseTo(result.grossNeeded, 0);
    expect(result.buckets.overtime).toBeGreaterThan(0);
  });

  it('subtracts non-taxed per diem from the target before solving', () => {
    const withPerDiem = targetToHours({
      targetTakeHome: 1200,
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      assumeOvertime: false,
      perDiemTotal: 300,
    });
    // Only $900 has to come from wages → $1200 gross → 30 hours.
    expect(withPerDiem.grossNeeded).toBe(1200);
    expect(withPerDiem.hours).toBe(30);
  });

  it('adds the shift differential to the effective rate', () => {
    const result = targetToHours({
      targetTakeHome: 1200,
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      assumeOvertime: false,
      designation: 'night',
      premiums,
    });
    expect(result.effectiveRate).toBeCloseTo(40.8, 10);
    expect(result.hours).toBeCloseTo(1600 / 40.8, 2);
  });

  it('reports unsolvable inputs rather than dividing by zero', () => {
    expect(targetToHours({ targetTakeHome: 0, baseRate: 40, payPeriod: 'weekly', deductionPct: 25, assumeOvertime: false }).solvable).toBe(false);
    expect(targetToHours({ targetTakeHome: 1000, baseRate: 0, payPeriod: 'weekly', deductionPct: 25, assumeOvertime: false }).solvable).toBe(false);
    expect(targetToHours({ targetTakeHome: 1000, baseRate: 40, payPeriod: 'weekly', deductionPct: 100, assumeOvertime: false }).solvable).toBe(false);
  });

  it('breaks the answer down per day for a two-week period', () => {
    const result = targetToHours({
      targetTakeHome: 2400,
      baseRate: 40,
      payPeriod: 'biweekly',
      deductionPct: 25,
      assumeOvertime: false,
      daysPerWeek: 5,
    });
    expect(result.breakdown).toMatchObject({ kind: 'grid', weeks: 2, daysPerWeek: 5 });
    expect(result.breakdown?.hoursPerDay).toBeCloseTo(result.hours / 10, 2);
  });

  it('uses the configured multipliers rather than hard-coded 1.5', () => {
    const result = targetToHours({
      targetTakeHome: 1800,
      baseRate: 40,
      payPeriod: 'weekly',
      deductionPct: 25,
      assumeOvertime: true,
      rules: { ...DEFAULT_OVERTIME_RULES, overtimeMultiplier: 2 },
    });
    // Gross 2400; 40 straight = 1600; 800 at $80 = 10 OT hours.
    expect(result.hours).toBe(50);
  });
});

describe('averageDeductionPct', () => {
  it('averages the withheld share across stubs', () => {
    const pct = averageDeductionPct([
      { grossPay: 1000, netPay: 750 },
      { grossPay: 2000, netPay: 1400 },
    ]);
    expect(pct).toBe(27.5);
  });

  it('ignores stubs missing either figure', () => {
    expect(averageDeductionPct([{ grossPay: 1000, netPay: null }, { grossPay: null, netPay: 500 }])).toBeNull();
  });

  it('returns null with no usable history', () => {
    expect(averageDeductionPct([])).toBeNull();
  });
});
