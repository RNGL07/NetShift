import { describe, expect, it } from 'vitest';
import { evaluateShiftValue, shiftImpact } from './shiftValue';

// 2026-03-14 is a Saturday; 2026-03-15 is a Sunday.
const SATURDAY = '2026-03-14';
const SUNDAY = '2026-03-15';

const base = {
  date: SATURDAY,
  hours: 8,
  baseRate: 40,
  designation: 'day' as const,
  priorWeekHours: [8, 8, 8, 8, 8, 0, 0],
  marginalDeductionPct: 30,
};

describe('evaluateShiftValue', () => {
  it('prices a Saturday after a full week entirely as overtime', () => {
    const result = evaluateShiftValue(base);
    expect(result.buckets).toEqual({ regular: 0, overtime: 8, doubleTime: 0 });
    expect(result.grossIncremental).toBe(480); // 8 × 60
  });

  it('prices the same shift as straight time on an empty week', () => {
    const result = evaluateShiftValue({ ...base, priorWeekHours: [0, 0, 0, 0, 0, 0, 0] });
    expect(result.buckets).toEqual({ regular: 8, overtime: 0, doubleTime: 0 });
    expect(result.grossIncremental).toBe(320);
  });

  it('subtracts withholding and costs to reach the net gain', () => {
    const result = evaluateShiftValue({
      ...base,
      commuteCost: 20,
      mealCost: 15,
      childcareCost: 60,
    });
    expect(result.estimatedWithholding).toBe(144); // 480 × 30%
    expect(result.totalCosts).toBe(95);
    expect(result.netGain).toBe(241); // 480 − 144 − 95
    expect(result.netHourlyRate).toBeCloseTo(30.13, 2);
  });

  it('shows the gap between the headline rate and what is actually kept', () => {
    const result = evaluateShiftValue({ ...base, childcareCost: 120 });
    expect(result.grossHourlyRate).toBe(60);
    expect(result.netHourlyRate).toBeLessThan(result.grossHourlyRate);
  });

  it('adds non-taxed per diem on top of the net', () => {
    const withPerDiem = evaluateShiftValue({ ...base, perDiem: 50 });
    const without = evaluateShiftValue(base);
    expect(withPerDiem.netGain - without.netGain).toBe(50);
  });

  it('prices a Sunday at double time when the profile says so', () => {
    const result = evaluateShiftValue({ ...base, date: SUNDAY, sundayTreatment: 'double' });
    expect(result.buckets).toEqual({ regular: 0, overtime: 0, doubleTime: 8 });
    expect(result.grossIncremental).toBe(640); // 8 × 80
    expect(result.notes.join(' ')).toContain('double time');
  });

  it('computes hours from a cross-midnight start and end', () => {
    const result = evaluateShiftValue({
      ...base,
      hours: undefined,
      startTime: '22:30',
      endTime: '07:00',
      unpaidBreakMinutes: 30,
    });
    expect(result.paidHours).toBe(8);
    expect(result.crossesMidnight).toBe(true);
    expect(result.notes.join(' ')).toContain('past midnight');
  });

  it('applies the shift differential to the effective rate', () => {
    const result = evaluateShiftValue({
      ...base,
      designation: 'night',
      premiums: { shiftPremium: 0.8, rolePremium: 0, hasRolePremium: false },
    });
    expect(result.effectiveRate).toBeCloseTo(40.8, 10);
    expect(result.grossIncremental).toBeCloseTo(489.6, 2);
  });

  it('prices a holiday at its multiplier instead of the overtime split', () => {
    const result = evaluateShiftValue({ ...base, holidayMultiplier: 2.5 });
    expect(result.grossIncremental).toBe(800); // 8 × 40 × 2.5
    expect(result.notes.join(' ')).toContain('holiday');
  });

  it('splits a shift that straddles the weekly threshold', () => {
    const result = evaluateShiftValue({
      ...base,
      hours: 8,
      priorWeekHours: [8, 8, 8, 8, 4, 0, 0], // 36 hours so far
    });
    expect(result.buckets.regular).toBe(4);
    expect(result.buckets.overtime).toBe(4);
    expect(result.notes.join(' ')).toContain('straight time');
  });

  it('rejects an unusable shift instead of returning zeros as if valid', () => {
    expect(evaluateShiftValue({ ...base, hours: 0 }).valid).toBe(false);
    expect(evaluateShiftValue({ ...base, baseRate: 0 }).valid).toBe(false);
  });

  it('shows its working as signed lines that reproduce the net gain', () => {
    const result = evaluateShiftValue({ ...base, commuteCost: 20, perDiem: 25 });
    const recomputed = result.workings.reduce((sum, w) => sum + w.sign * w.amount, 0);
    expect(recomputed).toBeCloseTo(result.netGain, 2);
  });

  it('includes arbitrary user-entered costs', () => {
    const result = evaluateShiftValue({
      ...base,
      otherCosts: [
        { id: '1', label: 'Dog sitter', amount: 40 },
        { id: '2', label: 'Tolls', amount: 6 },
      ],
    });
    expect(result.totalCosts).toBe(46);
    expect(result.costBreakdown.map((c) => c.label)).toContain('Dog sitter');
  });
});

describe('shiftImpact', () => {
  it('reports the share of a goal a shift covers', () => {
    const impact = shiftImpact(300, { kind: 'goal', name: 'Vacation', remaining: 1500 });
    expect(impact?.pctOfRemaining).toBe(20);
    expect(impact?.message).toContain('Vacation');
    expect(impact?.message).toContain('5 more shifts');
  });

  it('phrases a debt impact in terms of the balance', () => {
    const impact = shiftImpact(250, { kind: 'debt', name: 'Card', remaining: 1000 });
    expect(impact?.message).toContain('balance');
  });

  it('returns nothing when there is no target or no gain', () => {
    expect(shiftImpact(300, null)).toBeNull();
    expect(shiftImpact(0, { kind: 'goal', name: 'X', remaining: 100 })).toBeNull();
  });
});
