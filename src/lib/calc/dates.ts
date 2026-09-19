/**
 * Date helpers.
 *
 * Everything in NetShift that has a date works in **local calendar days**
 * expressed as `YYYY-MM-DD` strings. Constructing `new Date('2026-03-01')`
 * parses as UTC midnight, which in any negative-offset timezone is the
 * *previous* day — that off-by-one would shift pay periods and paydays for
 * every user west of Greenwich, which is the entire initial market.
 */

export type IsoDate = string; // YYYY-MM-DD

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === 'string' && ISO_DATE_RE.test(value);
}

/** Parses `YYYY-MM-DD` into a local-midnight Date, or `null`. */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = ISO_DATE_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  // Rejects impossible dates that JS would otherwise roll over (2026-02-31).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function toIsoDate(date: Date): IsoDate {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayIso(now: Date = new Date()): IsoDate {
  return toIsoDate(now);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  parsed.setDate(parsed.getDate() + days);
  return toIsoDate(parsed);
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  const targetDay = parsed.getDate();
  parsed.setDate(1);
  parsed.setMonth(parsed.getMonth() + months);
  // Clamp to the last day of the target month (Jan 31 + 1 month → Feb 28/29).
  const lastDay = new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0).getDate();
  parsed.setDate(Math.min(targetDay, lastDay));
  return toIsoDate(parsed);
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const start = parseIsoDate(a);
  const end = parseIsoDate(b);
  if (!start || !end) return 0;
  // Normalising to UTC noon sidesteps DST transitions, which otherwise make
  // some "24 hour" gaps 23 or 25 hours long and round to the wrong day count.
  const utcStart = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate(), 12);
  const utcEnd = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate(), 12);
  return Math.round((utcEnd - utcStart) / 86_400_000);
}

/** 0 = Monday … 6 = Sunday, matching the week arrays used throughout. */
export function dayIndexMonFirst(date: IsoDate): number {
  const parsed = parseIsoDate(date);
  if (!parsed) return 0;
  return (parsed.getDay() + 6) % 7;
}

export function isSunday(date: IsoDate): boolean {
  return dayIndexMonFirst(date) === 6;
}

/** The Monday of the week containing `date`. */
export function startOfWeek(date: IsoDate): IsoDate {
  return addDays(date, -dayIndexMonFirst(date));
}

/** Inclusive list of dates from `start` to `end`, capped at `maxDays`. */
export function datesBetween(start: IsoDate, end: IsoDate, maxDays = 800): IsoDate[] {
  const span = daysBetween(start, end);
  if (span < 0) return [];
  const count = Math.min(span, maxDays - 1);
  return Array.from({ length: count + 1 }, (_, i) => addDays(start, i));
}

export function isWithin(date: IsoDate, start: IsoDate, end: IsoDate): boolean {
  return daysBetween(start, date) >= 0 && daysBetween(date, end) >= 0;
}

export function minIso(a: IsoDate, b: IsoDate): IsoDate {
  return daysBetween(a, b) >= 0 ? a : b;
}

export function maxIso(a: IsoDate, b: IsoDate): IsoDate {
  return daysBetween(a, b) >= 0 ? b : a;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `2026-03-09` → `Mar 9, 2026`. Falls back to the raw string when unparsable. */
export function formatIsoDate(value: string | null | undefined): string {
  const parsed = parseIsoDate(value);
  if (!parsed) return value ?? '—';
  return `${MONTHS[parsed.getMonth()]} ${parsed.getDate()}, ${parsed.getFullYear()}`;
}

/** `2026-03-09` → `Mon Mar 9`. */
export function formatIsoDateShort(value: string | null | undefined): string {
  const parsed = parseIsoDate(value);
  if (!parsed) return value ?? '—';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parsed.getDay()];
  return `${weekday} ${MONTHS[parsed.getMonth()]} ${parsed.getDate()}`;
}

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

/** Days between consecutive paydays. Semi-monthly/monthly are averages. */
export function daysPerPayPeriod(frequency: PayFrequency): number {
  switch (frequency) {
    case 'weekly':
      return 7;
    case 'biweekly':
      return 14;
    case 'semimonthly':
      return 15;
    case 'monthly':
      return 30;
  }
}

/**
 * The payday following `payday` for a given frequency.
 *
 * Semi-monthly is modelled as the 15th and the last day of the month, which is
 * the near-universal convention; monthly keeps the day of month.
 */
export function nextPayday(payday: IsoDate, frequency: PayFrequency): IsoDate {
  const parsed = parseIsoDate(payday);
  if (!parsed) return payday;
  switch (frequency) {
    case 'weekly':
      return addDays(payday, 7);
    case 'biweekly':
      return addDays(payday, 14);
    case 'monthly':
      return addMonths(payday, 1);
    case 'semimonthly': {
      const day = parsed.getDate();
      const lastDay = new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0).getDate();
      if (day < 15) {
        return toIsoDate(new Date(parsed.getFullYear(), parsed.getMonth(), 15));
      }
      if (day < lastDay) {
        return toIsoDate(new Date(parsed.getFullYear(), parsed.getMonth(), lastDay));
      }
      return toIsoDate(new Date(parsed.getFullYear(), parsed.getMonth() + 1, 15));
    }
  }
}

/** Generates `count` paydays starting at (and including) `first`. */
export function paydaySeries(first: IsoDate, frequency: PayFrequency, count: number): IsoDate[] {
  const out: IsoDate[] = [];
  let cursor = first;
  for (let i = 0; i < Math.max(0, count); i++) {
    out.push(cursor);
    cursor = nextPayday(cursor, frequency);
  }
  return out;
}
