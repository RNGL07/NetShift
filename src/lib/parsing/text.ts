/**
 * Shared primitives for reading numbers and labels out of payroll documents.
 *
 * Carried over from the prototype's local parser, which exists so that a PDF
 * exported from a payroll portal never has to be uploaded to an AI provider at
 * all — the cheapest, most private extraction is the one that happens in the
 * user's own browser.
 */

export function stripCodeFences(value: string): string {
  const backtick = String.fromCharCode(96);
  const triple = backtick.repeat(3);
  return value.split(`${triple}json`).join('').split(triple).join('').trim();
}

/** Pulls the first balanced JSON object out of a model response. */
export function extractJsonObject(text: string): unknown {
  const cleaned = stripCodeFences(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in the response.');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function toTextLines(text: string): string[] {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** `"$1,234.56"` / `"(1,234.56)"` / `"-1234.56"` → a plain number. */
export function parseLocalNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  let value = String(raw).trim();
  const negative = /^\(.*\)$/.test(value) || /^-|\$\s*-/.test(value);
  value = value.replace(/[()]/g, '').replace(/[$,\s-]/g, '');
  if (!value || !/^\d*\.?\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

export function firstNumberIn(segment: string): number | null {
  const match = String(segment).match(
    /\(?-?\$\s?-?\d[\d,]*(?:\.\d+)?\)?|\(?-?\d[\d,]*(?:\.\d+)?\)?/,
  );
  return match ? parseLocalNumber(match[0]) : null;
}

/**
 * Money is either `$`-prefixed or written with cents. Requiring one of those
 * keeps years, employee numbers, and check numbers from being read as amounts.
 */
export function moneyIn(segment: string): number | null {
  const match = String(segment).match(/\(?-?\$\s?-?\d[\d,]*(?:\.\d+)?\)?|\(?-?\d[\d,]*\.\d{2}\)?/);
  if (!match) return null;
  const parsed = parseLocalNumber(match[0]);
  return parsed === null ? null : Math.abs(parsed);
}

export function numberIn(segment: string): number | null {
  const parsed = firstNumberIn(segment);
  return parsed === null ? null : Math.abs(parsed);
}

/** Hourly premiums are small per-hour figures; anything larger is a false hit. */
export function premiumIn(segment: string): number | null {
  const parsed = firstNumberIn(segment);
  if (parsed === null) return null;
  const magnitude = Math.abs(parsed);
  return magnitude <= 50 ? magnitude : null;
}

export const LOCAL_DATE_RE = new RegExp(
  '\\d{4}-\\d{2}-\\d{2}' +
    '|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}' +
    '|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}',
  'i',
);

export function dateIn(segment: string): string | null {
  const match = String(segment).match(LOCAL_DATE_RE);
  return match ? match[0].trim() : null;
}

export function textIn(segment: string): string | null {
  const trimmed = String(segment)
    .replace(/^[\s:\-–—]+/, '')
    .trim();
  return trimmed && /[a-z]/i.test(trimmed) ? trimmed.slice(0, 80) : null;
}

/** Matches a label as a whole word, tolerating however the PDF spaced it out. */
export function localLabelPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
}

/**
 * Walks the synonym list most-specific first, and for each one scans every
 * line, pulling the value from the rest of that line or from the line below —
 * payroll PDFs put the amount in either place depending on the layout.
 */
export function findLabeledValue<T>(
  lines: readonly string[],
  labels: readonly string[],
  extract: (segment: string) => T | null,
  options: { allowNextLine?: boolean } = {},
): T | null {
  const allowNextLine = options.allowNextLine !== false;
  for (const label of labels) {
    const pattern = localLabelPattern(label);
    for (let i = 0; i < lines.length; i++) {
      const match = pattern.exec(lines[i]);
      if (!match) continue;
      const after = lines[i].slice(match.index + match[0].length);
      const here = extract(after);
      if (here !== null && here !== undefined) return here;
      if (allowNextLine && i + 1 < lines.length) {
        const below = extract(lines[i + 1]);
        if (below !== null && below !== undefined) return below;
      }
    }
  }
  return null;
}

/** Parses a loosely-formatted date string into `YYYY-MM-DD`, or `null`. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) return pad(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(trimmed);
  if (slash) {
    let year = Number(slash[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return pad(year, Number(slash[1]), Number(slash[2]));
  }

  const named = /^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(trimmed);
  if (named) {
    const months = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ];
    const index = months.indexOf(named[1].slice(0, 3).toLowerCase());
    if (index >= 0) return pad(Number(named[3]), index + 1, Number(named[2]));
  }

  return null;
}

function pad(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
