import { describe, expect, it } from 'vitest';
import { planBonus, validateAllocations, type BonusAllocation } from './bonus';

const allocation = (over: Partial<BonusAllocation> = {}): BonusAllocation => ({
  id: 'a1',
  target: 'debt',
  label: 'Card',
  percent: 50,
  ...over,
});

const base = {
  name: 'Profit sharing',
  kind: 'profit_sharing' as const,
  expectedDate: '2026-06-15',
  conservativeGross: 4000,
  baseGross: 6000,
  optimisticGross: 8000,
  withholdingPct: 30,
  allocations: [] as BonusAllocation[],
};

describe('planBonus — scenarios', () => {
  it('builds three scenarios net of withholding', () => {
    const plan = planBonus(base);
    expect(plan.scenarios.conservative).toEqual({
      label: 'Conservative',
      gross: 4000,
      withholding: 1200,
      net: 2800,
    });
    expect(plan.scenarios.optimistic.net).toBe(5600);
  });

  it('allocates against the conservative estimate by default', () => {
    const plan = planBonus(base);
    expect(plan.allocatableNet).toBe(2800);
    expect(plan.allocatedAgainst).toBe('Conservative');
  });

  it('can allocate against the base or optimistic estimate instead', () => {
    expect(planBonus({ ...base, allocateAgainst: 'base' }).allocatableNet).toBe(4200);
    expect(planBonus({ ...base, allocateAgainst: 'optimistic' }).allocatableNet).toBe(5600);
  });

  it('warns when the estimates are not in ascending order', () => {
    const plan = planBonus({ ...base, conservativeGross: 9000 });
    expect(plan.warnings.join(' ')).toContain('ascending order');
  });

  it('warns when the withholding estimate looks optimistic', () => {
    const plan = planBonus({ ...base, withholdingPct: 10 });
    expect(plan.warnings.join(' ')).toContain('higher rate than regular pay');
  });
});

describe('planBonus — allocations', () => {
  it('resolves percentage allocations against the net', () => {
    const plan = planBonus({
      ...base,
      allocations: [
        allocation({ id: 'a', percent: 50, target: 'debt' }),
        allocation({ id: 'b', percent: 30, target: 'savings' }),
      ],
    });
    expect(plan.allocations.map((a) => a.amount)).toEqual([1400, 840]);
    expect(plan.unallocated).toBe(560);
  });

  it('resolves fixed-amount allocations', () => {
    const plan = planBonus({
      ...base,
      allocations: [allocation({ id: 'a', percent: null, amount: 1000 })],
    });
    expect(plan.allocations[0].amount).toBe(1000);
    expect(plan.allocations[0].percentOfNet).toBeCloseTo(35.71, 2);
  });

  it('never distributes more than the bonus nets', () => {
    const plan = planBonus({
      ...base,
      allocations: [
        allocation({ id: 'a', percent: null, amount: 2000 }),
        allocation({ id: 'b', percent: null, amount: 2000 }),
      ],
    });
    expect(plan.totalAllocated).toBe(2800);
    expect(plan.overAllocated).toBe(true);
    expect(plan.overAllocatedBy).toBe(1200);
    expect(plan.allocations[1].trimmed).toBe(true);
    expect(plan.allocations[1].amount).toBe(800);
  });

  it('groups allocations by target', () => {
    const plan = planBonus({
      ...base,
      allocations: [
        allocation({ id: 'a', target: 'debt', percent: 25 }),
        allocation({ id: 'b', target: 'debt', percent: 25 }),
        allocation({ id: 'c', target: 'savings', percent: 20 }),
      ],
    });
    const debt = plan.byTarget.find((t) => t.target === 'debt')!;
    expect(debt.amount).toBe(1400);
    expect(plan.byTarget[0].target).toBe('debt');
  });

  it('handles a zero-net bonus without dividing by zero', () => {
    const plan = planBonus({
      ...base,
      conservativeGross: 0,
      baseGross: 0,
      optimisticGross: 0,
      allocations: [allocation({ percent: 50 })],
    });
    expect(plan.allocatableNet).toBe(0);
    expect(plan.allocations[0].amount).toBe(0);
    expect(plan.allocations[0].percentOfNet).toBe(0);
  });
});

describe('planBonus — actual vs expected', () => {
  it('compares the actual bonus to the base estimate', () => {
    const plan = planBonus({ ...base, actualGross: 7000, actualNet: 4800 });
    expect(plan.actual).toEqual({ label: 'Actual', gross: 7000, withholding: 2200, net: 4800 });
    expect(plan.variance?.grossVsBase).toBe(1000);
    expect(plan.variance?.message).toContain('above your base estimate');
  });

  it('phrases a shortfall as a shortfall', () => {
    const plan = planBonus({ ...base, actualGross: 4500, actualNet: 3000 });
    expect(plan.variance?.message).toContain('below your base estimate');
  });

  it('flags a withholding estimate that missed badly', () => {
    const plan = planBonus({ ...base, actualGross: 6000, actualNet: 3300 });
    expect(plan.warnings.join(' ')).toContain('Actual withholding');
  });

  it('derives the actual net from the estimate when only gross is known', () => {
    const plan = planBonus({ ...base, actualGross: 6000 });
    expect(plan.actual?.net).toBe(4200);
  });
});

describe('validateAllocations', () => {
  it('accepts a valid set', () => {
    const result = validateAllocations([allocation({ percent: 40 }), allocation({ id: 'b', percent: 60 })], 2800);
    expect(result.valid).toBe(true);
  });

  it('rejects an allocation with both a percentage and an amount', () => {
    const result = validateAllocations([allocation({ percent: 50, amount: 100 })], 2800);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('not both');
  });

  it('rejects an allocation with neither', () => {
    const result = validateAllocations([allocation({ percent: null, amount: null })], 2800);
    expect(result.errors[0].message).toContain('Enter a percentage or a dollar amount');
  });

  it('rejects percentages outside 0–100', () => {
    expect(validateAllocations([allocation({ percent: 150 })], 2800).valid).toBe(false);
    expect(validateAllocations([allocation({ percent: -5 })], 2800).valid).toBe(false);
  });

  it('rejects a set whose percentages exceed 100', () => {
    const result = validateAllocations(
      [allocation({ id: 'a', percent: 60 }), allocation({ id: 'b', percent: 60 })],
      2800,
    );
    expect(result.errors.some((e) => e.id === '__total__')).toBe(true);
  });

  it('rejects fixed amounts that exceed the net', () => {
    const result = validateAllocations(
      [allocation({ id: 'a', percent: null, amount: 3000 })],
      2800,
    );
    expect(result.errors.some((e) => e.message.includes('more than the'))).toBe(true);
  });

  it('rejects a negative amount', () => {
    expect(validateAllocations([allocation({ percent: null, amount: -100 })], 2800).valid).toBe(false);
  });
});
