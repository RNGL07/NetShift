import { describe, expect, it } from 'vitest';
import { calculateBuffer, type PaycheckSample } from './buffer';

const check = (net: number, over: Partial<PaycheckSample> = {}): PaycheckSample => ({
  payDate: '2026-01-01',
  grossPay: net / 0.75,
  netPay: net,
  hoursWorked: 80,
  ...over,
});

describe('calculateBuffer — insufficient history', () => {
  it('falls back to a rule of thumb with no history at all, and says so', () => {
    const result = calculateBuffer({
      history: [],
      frequency: 'biweekly',
      monthlyEssentialExpenses: 3000,
    });
    expect(result.sampleSize).toBe(0);
    expect(result.sufficientHistory).toBe(false);
    expect(result.confidence).toBe('none');
    expect(result.recommendedBuffer).toBe(9000);
    expect(result.explanation.join(' ')).toContain('rule of thumb');
    expect(result.warnings.join(' ')).toContain('no paycheck history');
  });

  it('warns when only one or two paychecks exist', () => {
    const result = calculateBuffer({
      history: [check(2000), check(2200)],
      frequency: 'biweekly',
      monthlyEssentialExpenses: 3000,
    });
    expect(result.sufficientHistory).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.warnings.join(' ')).toContain('rough starting point');
  });

  it('reports better confidence as history grows', () => {
    const many = Array.from({ length: 14 }, (_, i) => check(2000 + i * 10));
    expect(
      calculateBuffer({ history: many, frequency: 'biweekly', monthlyEssentialExpenses: 3000 })
        .confidence,
    ).toBe('good');
    expect(
      calculateBuffer({
        history: many.slice(0, 7),
        frequency: 'biweekly',
        monthlyEssentialExpenses: 3000,
      }).confidence,
    ).toBe('moderate');
  });
});

describe('calculateBuffer — income statistics', () => {
  const history = [
    check(1800, { overtimeHours: 0 }),
    check(1850, { overtimeHours: 0 }),
    check(2400, { overtimeHours: 10 }),
    check(2600, { overtimeHours: 14 }),
    check(3000, { overtimeHours: 22 }),
    check(2500, { overtimeHours: 12 }),
  ];

  it('averages base-pay-only paychecks separately from all paychecks', () => {
    const result = calculateBuffer({
      history,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 4000,
    });
    expect(result.averageBasePayOnlyPaycheck).toBe(1825);
    expect(result.averagePaycheck).toBeGreaterThan(result.averageBasePayOnlyPaycheck!);
  });

  it('uses the 10th percentile rather than the outright minimum as "lowest normal"', () => {
    const withOutlier = [...history, check(300, { overtimeHours: 0 })];
    const result = calculateBuffer({
      history: withOutlier,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 4000,
    });
    expect(result.lowestNormalPaycheck!).toBeGreaterThan(300);
    expect(result.explanation.join(' ')).toContain('10th percentile');
  });

  it('measures income variability as a coefficient of variation', () => {
    const steady = Array.from({ length: 6 }, () => check(2000, { overtimeHours: 0 }));
    const swingy = [check(1000), check(3000), check(1200), check(2800), check(900), check(3200)];
    const steadyResult = calculateBuffer({
      history: steady,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 3000,
    });
    const swingyResult = calculateBuffer({
      history: swingy,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 3000,
    });
    expect(steadyResult.incomeVariabilityPct).toBe(0);
    expect(swingyResult.incomeVariabilityPct!).toBeGreaterThan(25);
    expect(swingyResult.warnings.join(' ')).toContain('swings');
  });

  it('reports the share of income coming from overtime', () => {
    const result = calculateBuffer({
      history,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 4000,
    });
    expect(result.overtimeShareOfIncomePct!).toBeGreaterThan(0);
  });

  it('approximates base-pay-only from the bottom quartile when no stub breaks out overtime', () => {
    const noOvertimeData = [check(1800), check(2000), check(2400), check(3000)];
    const result = calculateBuffer({
      history: noOvertimeData,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 3000,
    });
    expect(result.explanation.join(' ')).toContain('bottom quarter');
  });
});

describe('calculateBuffer — overtime dependency', () => {
  const history = [
    check(1800, { overtimeHours: 0 }),
    check(1800, { overtimeHours: 0 }),
    check(2800, { overtimeHours: 20 }),
    check(3000, { overtimeHours: 24 }),
  ];

  it('identifies obligations that base pay alone does not cover', () => {
    // Base pay ≈ 1800 × 26 / 12 = 3900/month.
    const result = calculateBuffer({
      history,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 3500,
      monthlyTotalObligations: 5000,
      baseRate: 40,
    });
    expect(result.monthlyIncomeFromBasePay).toBeCloseTo(3900, 0);
    expect(result.obligationsDependentOnOvertime).toBeCloseTo(1100, 0);
    expect(result.explanation.join(' ')).toContain('depends on overtime');
  });

  it('estimates the overtime hours needed to sustain those obligations', () => {
    const result = calculateBuffer({
      history,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 3500,
      monthlyTotalObligations: 5000,
      baseRate: 40,
      overtimeMultiplier: 1.5,
    });
    // ~1100 needed, net per OT hour = 40 × 1.5 × 0.75 = 45 → ~24 hrs.
    expect(result.overtimeHoursPerMonthToSustain).toBeCloseTo(24.4, 0);
  });

  it('reports zero dependency when base pay covers everything', () => {
    const result = calculateBuffer({
      history,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 2000,
      monthlyTotalObligations: 2500,
      baseRate: 40,
    });
    expect(result.obligationsDependentOnOvertime).toBe(0);
    expect(result.overtimeHoursPerMonthToSustain).toBe(0);
    expect(result.explanation.join(' ')).toContain('base pay alone covers');
  });
});

describe('calculateBuffer — recommendation', () => {
  it('reports the gap between the recommendation and what is saved', () => {
    const history = Array.from({ length: 6 }, () => check(2000, { overtimeHours: 0 }));
    const result = calculateBuffer({
      history,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 5000,
      currentBufferBalance: 2000,
    });
    expect(result.recommendedBuffer).toBeGreaterThan(0);
    expect(result.bufferGap).toBe(result.recommendedBuffer - 2000);
    expect(result.monthsOfCoverToday).toBe(0.4);
  });

  it('never recommends less than one month of essentials', () => {
    const history = Array.from({ length: 6 }, () => check(5000, { overtimeHours: 0 }));
    const result = calculateBuffer({
      history,
      frequency: 'biweekly',
      monthlyEssentialExpenses: 2000,
    });
    expect(result.recommendedBuffer).toBeGreaterThanOrEqual(2000);
  });

  it('asks for essential expenses when none are entered', () => {
    const result = calculateBuffer({
      history: [check(2000)],
      frequency: 'biweekly',
      monthlyEssentialExpenses: 0,
    });
    expect(result.warnings.join(' ')).toContain('essential monthly expenses');
  });
});
