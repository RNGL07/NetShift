import { describe, expect, it } from 'vitest';
import { allocateToGoals, calculateGoalFunding, totalContributed } from './goals';

const base = {
  targetAmount: 5000,
  currentAmount: 1000,
  frequency: 'biweekly' as const,
  baseRate: 40,
  marginalDeductionPct: 30,
  today: '2026-01-01',
};

describe('calculateGoalFunding', () => {
  it('computes remaining and progress', () => {
    const result = calculateGoalFunding(base);
    expect(result.remaining).toBe(4000);
    expect(result.progressPct).toBe(20);
    expect(result.complete).toBe(false);
  });

  it('marks a funded goal complete', () => {
    const result = calculateGoalFunding({ ...base, currentAmount: 5000 });
    expect(result.complete).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.notes[0]).toContain('funded');
  });

  it('splits the remainder across the paychecks until the target date', () => {
    // 2026-01-01 → 2026-07-01 is 181 days = 12 biweekly paychecks.
    const result = calculateGoalFunding({ ...base, targetDate: '2026-07-01' });
    expect(result.paychecksUntilTarget).toBe(12);
    expect(result.requiredPerPaycheck).toBeCloseTo(4000 / 12, 2);
  });

  it('grosses up the required contribution for withholding', () => {
    const result = calculateGoalFunding({ ...base, targetDate: '2026-07-01' });
    // Net 333.33 at 70% kept → 476.19 gross.
    expect(result.grossNeededPerPaycheck).toBeCloseTo(476.19, 2);
  });

  it('converts the gross into regular, overtime, and double-time hours', () => {
    const result = calculateGoalFunding({ ...base, targetDate: '2026-07-01' });
    const gross = result.grossNeededPerPaycheck!;
    expect(result.hoursNeeded.regular).toBeCloseTo(gross / 40, 2);
    expect(result.hoursNeeded.overtime).toBeCloseTo(gross / 60, 2);
    expect(result.hoursNeeded.doubleTime).toBeCloseTo(gross / 80, 2);
    // Fewer hours are needed the higher the multiplier.
    expect(result.hoursNeeded.doubleTime!).toBeLessThan(result.hoursNeeded.overtime!);
    expect(result.hoursNeeded.overtime!).toBeLessThan(result.hoursNeeded.regular!);
  });

  it('uses the effective rate when premiums apply', () => {
    const result = calculateGoalFunding({ ...base, targetDate: '2026-07-01', effectiveRate: 42.25 });
    expect(result.hoursNeeded.regular).toBeCloseTo(result.grossNeededPerPaycheck! / 42.25, 2);
  });

  it('projects a completion date from the planned contribution', () => {
    const result = calculateGoalFunding({ ...base, perPaycheckContribution: 500 });
    expect(result.paychecksAtCurrentRate).toBe(8);
    expect(result.projectedCompletionDate).toBe('2026-04-23'); // 8 × 14 = 112 days
  });

  it('flags a target date that no realistic schedule can meet', () => {
    const result = calculateGoalFunding({
      ...base,
      targetAmount: 60_000,
      currentAmount: 0,
      targetDate: '2026-03-01',
    });
    expect(result.targetDateUnreachable).toBe(true);
    expect(result.notes.join(' ')).toContain('beyond what a normal schedule allows');
  });

  it('says so when the target date has already passed', () => {
    const result = calculateGoalFunding({ ...base, targetDate: '2025-12-01' });
    expect(result.notes.join(' ')).toContain('target date has passed');
    expect(result.requiredPerPaycheck).toBeNull();
  });

  it('never presents the withholding estimate as a guaranteed rate', () => {
    const result = calculateGoalFunding({ ...base, targetDate: '2026-07-01' });
    expect(result.notes.join(' ')).toContain('not a guaranteed tax rate');
  });

  it('estimates what one extra overtime shift is worth', () => {
    const result = calculateGoalFunding({ ...base, perPaycheckContribution: 200 });
    // 8 hrs × $60 × 70% kept = $336.
    expect(result.extraShiftEffect?.netPerShift).toBe(336);
    expect(result.extraShiftEffect?.completionWithOneShiftPerWeek).toBeTruthy();
  });

  it('handles a zero target without dividing by zero', () => {
    const result = calculateGoalFunding({ ...base, targetAmount: 0, currentAmount: 0 });
    expect(result.progressPct).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

describe('totalContributed', () => {
  it('sums logged contributions', () => {
    expect(
      totalContributed([
        { amount: 100, contributedOn: '2026-01-01' },
        { amount: 250.5, contributedOn: '2026-01-15' },
      ]),
    ).toBe(350.5);
  });

  it('returns zero for no contributions', () => {
    expect(totalContributed([])).toBe(0);
  });
});

describe('allocateToGoals', () => {
  it('fills goals in priority order until the money runs out', () => {
    const result = allocateToGoals(1000, [
      { id: 'a', name: 'Emergency', remaining: 600 },
      { id: 'b', name: 'Vacation', remaining: 900 },
      { id: 'c', name: 'Truck', remaining: 500 },
    ]);
    expect(result).toEqual([
      { goalId: 'a', name: 'Emergency', amount: 600 },
      { goalId: 'b', name: 'Vacation', amount: 400 },
    ]);
  });

  it('never allocates more than the amount available', () => {
    const result = allocateToGoals(100, [{ id: 'a', name: 'A', remaining: 5000 }]);
    expect(result[0].amount).toBe(100);
  });

  it('skips goals that need nothing', () => {
    const result = allocateToGoals(500, [
      { id: 'done', name: 'Done', remaining: 0 },
      { id: 'a', name: 'A', remaining: 300 },
    ]);
    expect(result.map((r) => r.goalId)).toEqual(['a']);
  });
});
