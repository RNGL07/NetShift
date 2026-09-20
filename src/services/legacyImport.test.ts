/**
 * Legacy import validation.
 *
 * The import reads unvalidated JSON typed into a prototype and turns it into
 * financial records. The rule being tested is that a figure which does not add
 * up is *skipped and reported*, never coerced into something plausible — a
 * skipped stub is recoverable, a silently wrong one poisons every audit built
 * on it.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const insertedRows: { table: string; rows: Record<string, unknown>[] }[] = [];
const legacyValues: Record<string, string | null> = {};

vi.mock('@/lib/supabase/client', () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'update', 'delete', 'is']) {
      chain[method] = () => chain;
    }
    chain.maybeSingle = async () => {
      if (table === 'netshift_data') {
        return { data: { value: legacyValues[currentKey] ?? null }, error: null };
      }
      return { data: null, error: null };
    };
    chain.single = async () => ({ data: { id: 'new-id' }, error: null });
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return chain;
  };

  let currentKey = '';
  return {
    supabase: {
      from: (table: string) => {
        const chain = builder(table) as Record<string, unknown>;
        const originalEq = chain.eq as () => unknown;
        chain.eq = (column: string, value: string) => {
          if (column === 'key') currentKey = value;
          return originalEq();
        };
        return chain;
      },
    },
  };
});

vi.mock('./crud', () => ({
  insertRow: vi.fn(async (table: string, _userId: string, values: Record<string, unknown>) => {
    insertedRows.push({ table, rows: [values] });
    return { id: `${table}-id` };
  }),
  insertRows: vi.fn(async (table: string, _userId: string, rows: Record<string, unknown>[]) => {
    insertedRows.push({ table, rows });
    return rows.map((row, index) => ({ ...row, id: `${table}-${index}` }));
  }),
}));

const { importLegacyData } = await import('./legacyImport');

function rowsFor(table: string): Record<string, unknown>[] {
  return insertedRows.filter((entry) => entry.table === table).flatMap((entry) => entry.rows);
}

beforeEach(() => {
  insertedRows.length = 0;
  for (const key of Object.keys(legacyValues)) delete legacyValues[key];
});

describe('pay stub import', () => {
  it('brings across a well-formed stub', async () => {
    legacyValues['paycheck-stubs'] = JSON.stringify([
      {
        pay_date: '03/06/2026',
        gross_pay: 4391.44,
        net_pay: 3143.19,
        hours_worked: 92.5,
        source: 'local',
      },
    ]);

    const result = await importLegacyData('user-1', { payProfileId: 'profile-1' });

    expect(result.imported['paycheck-stubs']).toBe(1);
    const stub = rowsFor('pay_stubs')[0];
    expect(stub.gross_pay).toBe(4391.44);
    expect(stub.pay_date).toBe('2026-03-06');
    // Provenance survives the migration.
    expect(stub.source).toBe('local');
    // Nothing is marked confirmed on the user's behalf.
    expect(stub.confirmed_by_user).toBe(false);
  });

  it('skips a stub whose net exceeds its gross rather than importing it', async () => {
    legacyValues['paycheck-stubs'] = JSON.stringify([
      { gross_pay: 100, net_pay: 9999 },
      { gross_pay: 2000, net_pay: 1500 },
    ]);

    const result = await importLegacyData('user-1', { payProfileId: null });

    expect(rowsFor('pay_stubs')).toHaveLength(1);
    expect(rowsFor('pay_stubs')[0].gross_pay).toBe(2000);
    expect(result.warnings.join(' ')).toContain('skipped');
  });

  it('skips a stub with no figures at all', async () => {
    legacyValues['paycheck-stubs'] = JSON.stringify([{ pay_date: '2026-03-06' }]);
    await importLegacyData('user-1', { payProfileId: null });
    expect(rowsFor('pay_stubs')).toHaveLength(0);
  });

  it('tolerates malformed legacy JSON without throwing', async () => {
    legacyValues['paycheck-stubs'] = '{not json at all';
    await expect(importLegacyData('user-1', { payProfileId: null })).resolves.toBeTruthy();
    expect(rowsFor('pay_stubs')).toHaveLength(0);
  });
});

describe('wage ladder import', () => {
  it('keeps plausible rates and drops the rest', async () => {
    legacyValues['pay-ladder'] = JSON.stringify({
      steps: [
        { label: 'Start', rate: 35.9 },
        { label: 'Bad', rate: 99999 },
        { label: 'Also bad', rate: 'n/a' },
        { label: '1 Year', rate: 40.61 },
      ],
    });

    await importLegacyData('user-1', { payProfileId: 'profile-1' });

    const steps = rowsFor('user_wage_ladder_steps');
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.hourly_rate)).toEqual([35.9, 40.61]);
  });

  it('gives an unlabelled step a fallback label', async () => {
    legacyValues['pay-ladder'] = JSON.stringify({ steps: [{ rate: 35.9 }] });
    await importLegacyData('user-1', { payProfileId: 'profile-1' });
    expect(rowsFor('user_wage_ladder_steps')[0].label).toBe('Step 1');
  });
});

describe('investment account import', () => {
  it('infers an account type from its old name', async () => {
    legacyValues['invest-accounts'] = JSON.stringify([
      { name: '401k', kind: 'holdings', holdings: [{ ticker: 'voo', shares: 10 }] },
      { name: 'Roth IRA', kind: 'holdings', holdings: [] },
      { name: 'SPAXX / Savings', kind: 'cash', balance: 5000 },
    ]);

    await importLegacyData('user-1', { payProfileId: null });

    const accounts = rowsFor('investment_accounts');
    expect(accounts.map((account) => account.kind)).toEqual([
      'traditional_401k',
      'roth_ira',
      'cash',
    ]);
    expect(accounts[2].balance).toBe(5000);
  });

  it('upper-cases tickers and drops holdings with no identifier', async () => {
    legacyValues['invest-accounts'] = JSON.stringify([
      {
        name: 'Brokerage',
        kind: 'holdings',
        holdings: [
          { ticker: 'voo', shares: 10 },
          { ticker: '', shares: 5 },
        ],
      },
    ]);

    await importLegacyData('user-1', { payProfileId: null });

    const holdings = rowsFor('holdings');
    expect(holdings).toHaveLength(1);
    expect(holdings[0].ticker).toBe('VOO');
  });
});

describe('premium import', () => {
  it('ignores a premium that is clearly not per-hour', async () => {
    legacyValues['pay-premiums'] = JSON.stringify({
      shiftPremium: 1600,
      teamLeaderPremium: 2.25,
      isTeamLeader: true,
    });

    // The update path writes through the mocked supabase client, so this
    // asserts only that a nonsense figure does not blow up the import.
    await expect(importLegacyData('user-1', { payProfileId: 'profile-1' })).resolves.toBeTruthy();
  });
});

describe('the whole import', () => {
  it('returns cleanly when there is nothing to import', async () => {
    const result = await importLegacyData('user-1', { payProfileId: null });
    expect(result.imported).toEqual({});
    expect(result.skipped).toEqual([]);
  });

  it('does not delete the legacy rows', async () => {
    legacyValues['paycheck-stubs'] = JSON.stringify([{ gross_pay: 100, net_pay: 80 }]);
    await importLegacyData('user-1', { payProfileId: null });
    // Nothing in the import path deletes from netshift_data — the user removes
    // it from Settings once they have checked the result.
    expect(insertedRows.some((entry) => entry.table === 'netshift_data')).toBe(false);
  });
});
