import { describe, expect, it } from 'vitest';
import { toCsv } from './export';

describe('toCsv', () => {
  it('writes a header row and the data rows', () => {
    expect(toCsv(['Date', 'Amount'], [['2026-03-06', 1200]])).toBe('Date,Amount\r\n2026-03-06,1200');
  });

  it('quotes cells containing commas, quotes, or newlines', () => {
    expect(toCsv(['Note'], [['Rent, utilities']])).toContain('"Rent, utilities"');
    expect(toCsv(['Note'], [['He said "hi"']])).toContain('"He said ""hi"""');
    expect(toCsv(['Note'], [['line one\nline two']])).toContain('"line one\nline two"');
  });

  it('renders null and undefined as empty cells rather than the words', () => {
    expect(toCsv(['A', 'B'], [[null, undefined]])).toBe('A,B\r\n,');
  });

  it('neutralises a cell a spreadsheet would treat as a formula', () => {
    // Without this, opening the export in Excel can execute the cell.
    expect(toCsv(['Name'], [['=1+1']])).toContain("'=1+1");
    expect(toCsv(['Name'], [['+SUM(A1)']])).toContain("'+SUM(A1)");
    expect(toCsv(['Name'], [['-2+3']])).toContain("'-2+3");
    expect(toCsv(['Name'], [['@import']])).toContain("'@import");
  });

  it('leaves a real negative number as a number, not a text cell', () => {
    // Quoting this would break every sum in the exported spreadsheet, and
    // NetShift's exports are full of negative differences.
    expect(toCsv(['Delta'], [[-250.5]])).toBe('Delta\r\n-250.5');
  });

  it('still guards a negative value that arrived as a string', () => {
    expect(toCsv(['Delta'], [['-250.5']])).toContain("'-250.5");
  });

  it('writes a non-finite number as an empty cell', () => {
    expect(toCsv(['A'], [[Number.NaN]])).toBe('A\r\n');
  });

  it('handles an empty row set', () => {
    expect(toCsv(['A'], [])).toBe('A');
  });
});
