import { describe, expect, it } from 'vitest';
import {
  MAX_AMORTIZATION_MONTHS,
  amortizeDebt,
  buildPayoffPlan,
  compareStrategies,
  monthlyInterestCost,
  orderDebts,
  scenarioDelta,
  shiftsToMonthlyExtra,
  totalMinimums,
  type Debt,
} from './debt';

const debt = (over: Partial<Debt> = {}): Debt => ({
  id: 'd1',
  name: 'Card',
  kind: 'credit_card',
  balance: 5000,
  apr: 24,
  minimumPayment: 150,
  ...over,
});

describe('amortizeDebt', () => {
  it('pays off a zero-interest balance in exactly the expected months', () => {
    const result = amortizeDebt(debt({ balance: 1200, apr: 0 }), 100, { startDate: '2026-01-01' });
    expect(result.amortizes).toBe(true);
    expect(result.monthsToPayoff).toBe(12);
    expect(result.totalInterest).toBe(0);
    expect(result.totalPaid).toBe(1200);
  });

  it('charges interest on the declining balance', () => {
    const result = amortizeDebt(debt({ balance: 1000, apr: 12 }), 500, { startDate: '2026-01-01' });
    // Month 1: interest = 1000 * 0.01 = 10.
    expect(result.schedule[0].interest).toBe(10);
    expect(result.schedule[0].principal).toBe(490);
    expect(result.schedule[0].endingBalance).toBe(510);
  });

  it('never overpays on the final instalment', () => {
    const result = amortizeDebt(debt({ balance: 1000, apr: 0 }), 300, { startDate: '2026-01-01' });
    const last = result.schedule[result.schedule.length - 1];
    expect(last.payment).toBe(100);
    expect(last.endingBalance).toBe(0);
    expect(result.totalPaid).toBe(1000);
  });

  it('reports a payment that does not cover interest instead of looping forever', () => {
    // $10,000 at 24% accrues $200/month; a $150 payment never amortises.
    const result = amortizeDebt(debt({ balance: 10_000, apr: 24 }), 150, { startDate: '2026-01-01' });
    expect(result.amortizes).toBe(false);
    expect(result.monthsToPayoff).toBeNull();
    expect(result.schedule).toHaveLength(0);
    expect(result.warnings[0]).toContain('does not cover');
  });

  it('treats a payment exactly equal to the interest as non-amortising', () => {
    const result = amortizeDebt(debt({ balance: 10_000, apr: 24 }), 200, { startDate: '2026-01-01' });
    expect(result.amortizes).toBe(false);
  });

  it('applies a one-time extra payment in the first month', () => {
    const withExtra = amortizeDebt(debt({ balance: 5000, apr: 0 }), 500, {
      startDate: '2026-01-01',
      extraOneTime: 2000,
    });
    // Month 0 pays 500 + 2000, leaving 2500 → five more months.
    expect(withExtra.monthsToPayoff).toBe(6);
  });

  it('honours a promotional rate until it expires', () => {
    const promo = amortizeDebt(
      debt({ balance: 3000, apr: 24, promoApr: 0, promoEndDate: '2026-06-30' }),
      300,
      { startDate: '2026-01-01' },
    );
    // Six months at 0% costs nothing in interest.
    expect(promo.schedule.slice(0, 6).every((m) => m.interest === 0)).toBe(true);
    expect(promo.schedule[6].interest).toBeGreaterThan(0);
  });

  it('returns immediately for a zero balance', () => {
    const result = amortizeDebt(debt({ balance: 0 }), 100, { startDate: '2026-01-01' });
    expect(result.monthsToPayoff).toBe(0);
    expect(result.schedule).toHaveLength(0);
  });

  it('gives up with a warning rather than iterating past the cap', () => {
    const result = amortizeDebt(debt({ balance: 500_000, apr: 6 }), 2600, {
      startDate: '2026-01-01',
      maxMonths: 24,
    });
    expect(result.amortizes).toBe(false);
    expect(result.warnings.join(' ')).toContain('24 months');
  });

  it('caps at 600 months by default', () => {
    expect(MAX_AMORTIZATION_MONTHS).toBe(600);
  });
});

describe('orderDebts', () => {
  const debts = [
    debt({ id: 'a', name: 'Card A', balance: 8000, apr: 22 }),
    debt({ id: 'b', name: 'Card B', balance: 1500, apr: 9 }),
    debt({ id: 'c', name: 'Auto', balance: 4000, apr: 14 }),
  ];

  it('orders snowball by smallest balance first', () => {
    expect(orderDebts(debts, 'snowball').map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders avalanche by highest rate first', () => {
    expect(orderDebts(debts, 'avalanche').map((d) => d.id)).toEqual(['a', 'c', 'b']);
  });

  it('preserves entry order when asked to', () => {
    expect(orderDebts(debts, 'as_entered').map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops debts with no balance', () => {
    expect(orderDebts([...debts, debt({ id: 'z', balance: 0 })], 'snowball')).toHaveLength(3);
  });

  it('ignores a promotional rate when ordering by rate', () => {
    const withPromo = [
      debt({ id: 'promo', balance: 5000, apr: 26, promoApr: 0, promoEndDate: '2027-01-01' }),
      debt({ id: 'plain', balance: 5000, apr: 20 }),
    ];
    // The promo is temporary; the 26% card is still the expensive one.
    expect(orderDebts(withPromo, 'avalanche')[0].id).toBe('promo');
  });
});

describe('buildPayoffPlan', () => {
  const debts = [
    debt({ id: 'small', name: 'Small', balance: 1000, apr: 0, minimumPayment: 50 }),
    debt({ id: 'big', name: 'Big', balance: 3000, apr: 0, minimumPayment: 100 }),
  ];

  it('rolls a cleared debt’s minimum into the next one', () => {
    const plan = buildPayoffPlan({ debts, strategy: 'snowball', startDate: '2026-01-01' });
    expect(plan.amortizes).toBe(true);
    // Total 4000 at 150/month with no interest = 27 months (last one partial).
    expect(plan.monthsToDebtFree).toBe(27);
    expect(plan.totalPaid).toBe(4000);
  });

  it('directs all extra money at the first debt in the strategy order', () => {
    const plan = buildPayoffPlan({
      debts,
      strategy: 'snowball',
      extraMonthlyPayment: 350,
      startDate: '2026-01-01',
    });
    expect(plan.monthlyPayment).toBe(500);
    expect(plan.monthsToDebtFree).toBe(8);
    const small = plan.perDebt.find((d) => d.debtId === 'small')!;
    expect(small.monthsToPayoff).toBe(3);
  });

  it('reports a stall rather than an impossible schedule', () => {
    const plan = buildPayoffPlan({
      debts: [debt({ balance: 20_000, apr: 26, minimumPayment: 100 })],
      strategy: 'avalanche',
      startDate: '2026-01-01',
    });
    expect(plan.amortizes).toBe(false);
    expect(plan.warnings.join(' ')).toContain('do not cover the interest');
  });

  it('handles an empty debt list', () => {
    const plan = buildPayoffPlan({ debts: [], strategy: 'snowball' });
    expect(plan.monthsToDebtFree).toBe(0);
    expect(plan.warnings).toHaveLength(1);
  });

  it('applies a one-time lump sum in month zero', () => {
    const baseline = buildPayoffPlan({ debts, strategy: 'snowball', startDate: '2026-01-01' });
    const lump = buildPayoffPlan({
      debts,
      strategy: 'snowball',
      oneTimeExtraPayment: 1000,
      startDate: '2026-01-01',
    });
    expect(lump.monthsToDebtFree!).toBeLessThan(baseline.monthsToDebtFree!);
  });

  it('adds extra-shift earnings to the monthly payment', () => {
    const plan = buildPayoffPlan({
      debts,
      strategy: 'snowball',
      extraFromShiftsMonthly: 600,
      startDate: '2026-01-01',
    });
    expect(plan.monthlyPayment).toBe(750);
  });
});

describe('compareStrategies', () => {
  it('shows avalanche saving interest when the big balance is the expensive one', () => {
    const comparison = compareStrategies({
      debts: [
        debt({ id: 'a', name: 'High rate', balance: 6000, apr: 26, minimumPayment: 150 }),
        debt({ id: 'b', name: 'Low rate', balance: 2000, apr: 5, minimumPayment: 60 }),
      ],
      extraMonthlyPayment: 400,
      startDate: '2026-01-01',
    });
    expect(comparison.avalanche.totalInterest).toBeLessThan(comparison.snowball.totalInterest);
    expect(comparison.interestSavedByAvalanche).toBeGreaterThan(0);
    expect(comparison.recommendation).toContain('Avalanche');
  });

  it('runs both orderings against the same money', () => {
    const comparison = compareStrategies({
      debts: [
        debt({ id: 'a', balance: 4000, apr: 18, minimumPayment: 100 }),
        debt({ id: 'b', balance: 4000, apr: 12, minimumPayment: 100 }),
      ],
      extraMonthlyPayment: 200,
      startDate: '2026-01-01',
    });
    expect(comparison.snowball.monthlyPayment).toBe(comparison.avalanche.monthlyPayment);
  });

  it('says so when neither ordering clears the balances', () => {
    const comparison = compareStrategies({
      debts: [debt({ balance: 30_000, apr: 26, minimumPayment: 100 })],
      startDate: '2026-01-01',
    });
    expect(comparison.recommendation).toContain('Neither ordering');
  });
});

describe('scenarioDelta', () => {
  it('reports months and interest saved by an extra payment', () => {
    const debts = [debt({ balance: 6000, apr: 18, minimumPayment: 150 })];
    const baseline = buildPayoffPlan({ debts, strategy: 'avalanche', startDate: '2026-01-01' });
    const scenario = buildPayoffPlan({
      debts,
      strategy: 'avalanche',
      extraMonthlyPayment: 300,
      startDate: '2026-01-01',
    });
    const delta = scenarioDelta(baseline, scenario);
    expect(delta.monthsSaved).toBeGreaterThan(0);
    expect(delta.interestSaved).toBeGreaterThan(0);
    expect(delta.description).toContain('sooner');
  });
});

describe('helpers', () => {
  it('sums minimum payments', () => {
    expect(totalMinimums([debt({ minimumPayment: 150 }), debt({ minimumPayment: 60 })])).toBe(210);
  });

  it('converts shifts into a monthly extra payment', () => {
    expect(shiftsToMonthlyExtra(320.5, 2)).toBe(641);
  });

  it('reports what a month of waiting costs', () => {
    expect(monthlyInterestCost([debt({ balance: 6000, apr: 24 })])).toBe(120);
  });
});
