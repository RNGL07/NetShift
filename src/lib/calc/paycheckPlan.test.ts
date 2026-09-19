import { describe, expect, it } from 'vitest';
import { billOccurrencesInWindow, buildPaycheckPlan, buildPlanSeries, type Bill } from './paycheckPlan';

const bill = (over: Partial<Bill> = {}): Bill => ({
  id: 'b1',
  name: 'Rent',
  amount: 1200,
  dueDate: '2026-03-01',
  cadence: 'monthly',
  essential: true,
  ...over,
});

describe('billOccurrencesInWindow', () => {
  it('includes a bill due on the payday itself', () => {
    const found = billOccurrencesInWindow(bill({ cadence: 'once', dueDate: '2026-03-06' }), '2026-03-06', '2026-03-20');
    expect(found).toHaveLength(1);
  });

  it('excludes a bill due exactly on the next payday, so it lands in the next plan', () => {
    const found = billOccurrencesInWindow(bill({ cadence: 'once', dueDate: '2026-03-20' }), '2026-03-06', '2026-03-20');
    expect(found).toHaveLength(0);
  });

  it('expands a weekly bill across the window', () => {
    const found = billOccurrencesInWindow(
      bill({ cadence: 'weekly', dueDate: '2026-03-02', amount: 50 }),
      '2026-03-06',
      '2026-03-20',
    );
    expect(found.map((o) => o.dueDate)).toEqual(['2026-03-09', '2026-03-16']);
  });

  it('places a monthly bill in exactly one of two consecutive windows', () => {
    const rent = bill({ cadence: 'monthly', dueDate: '2026-03-01' });
    const first = billOccurrencesInWindow(rent, '2026-02-20', '2026-03-06');
    const second = billOccurrencesInWindow(rent, '2026-03-06', '2026-03-20');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('handles a bill window that straddles a calendar month boundary', () => {
    const found = billOccurrencesInWindow(
      bill({ cadence: 'monthly', dueDate: '2026-04-01' }),
      '2026-03-27',
      '2026-04-10',
    );
    expect(found.map((o) => o.dueDate)).toEqual(['2026-04-01']);
  });

  it('stops recurring after the end date', () => {
    const found = billOccurrencesInWindow(
      bill({ cadence: 'weekly', dueDate: '2026-03-02', endDate: '2026-03-10' }),
      '2026-03-06',
      '2026-03-27',
    );
    expect(found.map((o) => o.dueDate)).toEqual(['2026-03-09']);
  });

  it('ignores a zero-amount bill', () => {
    expect(billOccurrencesInWindow(bill({ amount: 0 }), '2026-02-20', '2026-03-06')).toHaveLength(0);
  });

  it('expands quarterly and annual cadences', () => {
    const quarterly = billOccurrencesInWindow(
      bill({ cadence: 'quarterly', dueDate: '2026-01-15', amount: 300 }),
      '2026-04-01',
      '2026-04-30',
    );
    expect(quarterly.map((o) => o.dueDate)).toEqual(['2026-04-15']);

    const annual = billOccurrencesInWindow(
      bill({ cadence: 'annual', dueDate: '2025-06-01', amount: 900 }),
      '2026-05-20',
      '2026-06-20',
    );
    expect(annual.map((o) => o.dueDate)).toEqual(['2026-06-01']);
  });
});

describe('buildPaycheckPlan', () => {
  const base = {
    payPeriodStart: '2026-02-16',
    payPeriodEnd: '2026-03-01',
    payday: '2026-03-06',
    frequency: 'biweekly' as const,
    expectedGross: 3200,
    deductionPct: 25,
    startingAvailableBalance: 500,
    plannedSavings: 200,
    plannedDebtPayments: 300,
    safetyBuffer: 250,
    bills: [] as Bill[],
  };

  it('computes safe-to-spend from the documented formula', () => {
    const plan = buildPaycheckPlan({
      ...base,
      bills: [bill({ cadence: 'once', dueDate: '2026-03-10', amount: 1200 })],
    });
    // 500 + 2400 − 1200 − 200 − 300 − 250
    expect(plan.expectedTakeHome).toBe(2400);
    expect(plan.billsDue).toBe(1200);
    expect(plan.safeToSpend).toBe(950);
  });

  it('prefers an explicit deduction amount over the percentage', () => {
    const plan = buildPaycheckPlan({ ...base, expectedDeductions: 900 });
    expect(plan.expectedTakeHome).toBe(2300);
    expect(plan.confidence.level).toBe('confirmed');
  });

  it('adds non-taxed per diem to take-home without taxing it', () => {
    const plan = buildPaycheckPlan({ ...base, perDiem: 400 });
    expect(plan.expectedTakeHome).toBe(2800);
  });

  it('never counts the same bill occurrence twice', () => {
    const rent = bill({ id: 'rent', cadence: 'monthly', dueDate: '2026-03-10', amount: 1200 });
    const plan = buildPaycheckPlan({ ...base, bills: [rent, { ...rent }] });
    // The same id + due date is deduplicated even if the list repeats it.
    expect(plan.bills).toHaveLength(1);
    expect(plan.billsDue).toBe(1200);
  });

  it('drops bills the caller has excluded', () => {
    const plan = buildPaycheckPlan({
      ...base,
      bills: [bill({ id: 'rent', cadence: 'once', dueDate: '2026-03-10', amount: 1200 })],
      excludedBillIds: ['rent'],
    });
    expect(plan.billsDue).toBe(0);
  });

  it('drops bills already marked paid', () => {
    const plan = buildPaycheckPlan({
      ...base,
      bills: [bill({ id: 'rent', cadence: 'once', dueDate: '2026-03-10', amount: 1200, paid: true })],
    });
    expect(plan.billsDue).toBe(0);
  });

  it('separates essential from total bills', () => {
    const plan = buildPaycheckPlan({
      ...base,
      bills: [
        bill({ id: 'rent', cadence: 'once', dueDate: '2026-03-10', amount: 1200, essential: true }),
        bill({ id: 'gym', cadence: 'once', dueDate: '2026-03-12', amount: 60, essential: false }),
      ],
    });
    expect(plan.billsDue).toBe(1260);
    expect(plan.essentialBillsDue).toBe(1200);
  });

  it('warns when the plan comes out negative', () => {
    const plan = buildPaycheckPlan({
      ...base,
      bills: [bill({ id: 'rent', cadence: 'once', dueDate: '2026-03-10', amount: 3000 })],
    });
    expect(plan.safeToSpend).toBeLessThan(0);
    expect(plan.warnings.join(' ')).toContain('short by');
  });

  it('shows its working as an ordered list that reproduces the answer', () => {
    const plan = buildPaycheckPlan({
      ...base,
      bills: [bill({ id: 'rent', cadence: 'once', dueDate: '2026-03-10', amount: 1200 })],
    });
    const recomputed = plan.workings.reduce((sum, w) => sum + w.sign * w.amount, 0);
    expect(recomputed).toBeCloseTo(plan.safeToSpend, 2);
  });

  it('derives the next payday from the frequency', () => {
    const plan = buildPaycheckPlan(base);
    expect(plan.nextPayday).toBe('2026-03-20');
    expect(plan.daysCovered).toBe(14);
  });

  it('honours an explicit next payday override', () => {
    const plan = buildPaycheckPlan({ ...base, nextPaydayOverride: '2026-03-27' });
    expect(plan.nextPayday).toBe('2026-03-27');
    expect(plan.daysCovered).toBe(21);
  });

  it('gives a confidence range only when take-home is estimated', () => {
    const estimated = buildPaycheckPlan(base);
    expect(estimated.confidence.level).toBe('estimated');
    expect(estimated.confidence.highTakeHome).toBeGreaterThan(estimated.confidence.lowTakeHome);
  });
});

describe('buildPlanSeries', () => {
  it('carries each plan’s projected ending balance into the next', () => {
    const plans = buildPlanSeries(
      {
        frequency: 'biweekly',
        expectedGross: 3200,
        deductionPct: 25,
        startingAvailableBalance: 0,
        bills: [],
        plannedSavings: 0,
        plannedDebtPayments: 0,
        safetyBuffer: 0,
      },
      '2026-03-06',
      3,
      (payday) => ({ start: payday, end: payday }),
    );

    expect(plans).toHaveLength(3);
    expect(plans[0].startingAvailableBalance).toBe(0);
    expect(plans[1].startingAvailableBalance).toBe(plans[0].projectedEndingBalance);
    expect(plans[2].startingAvailableBalance).toBe(plans[1].projectedEndingBalance);
    expect(plans[2].safeToSpend).toBe(7200);
  });

  it('never repeats a monthly bill across two consecutive windows', () => {
    const plans = buildPlanSeries(
      {
        frequency: 'biweekly',
        expectedGross: 3200,
        deductionPct: 25,
        startingAvailableBalance: 0,
        bills: [bill({ id: 'rent', cadence: 'monthly', dueDate: '2026-03-01', amount: 1200 })],
        plannedSavings: 0,
        plannedDebtPayments: 0,
        safetyBuffer: 0,
      },
      '2026-03-06',
      2,
      (payday) => ({ start: payday, end: payday }),
    );
    const total = plans.reduce((sum, p) => sum + p.billsDue, 0);
    // Only one rent falls inside 2026-03-06 → 2026-04-03.
    expect(total).toBe(1200);
  });
});
