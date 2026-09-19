/**
 * Money helpers.
 *
 * Every figure NetShift shows a user is rounded at the point it is displayed or
 * stored, never accumulated from pre-rounded parts — rounding inside a loop is
 * how amortisation schedules drift by whole dollars over 60 payments.
 */

/** Rounds to cents using half-away-from-zero, which is what payroll does. */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = value * 100;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / 100;
}

/** Rounds to `places` decimals; used for hours (2dp) and rates (4dp). */
export function roundTo(value: number, places: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  const scaled = value * factor;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / factor;
}

/**
 * Coerces user input (which arrives as `''`, `'12.5'`, `null`, …) to a number.
 * Returns `fallback` for anything that is not a finite number, so a blank field
 * never turns a total into `NaN`.
 */
export function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/** `num` but rejects negatives, which no hours/rate/amount field should accept. */
export function nonNegative(value: unknown, fallback = 0): number {
  return Math.max(0, num(value, fallback));
}

/** Clamps into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
