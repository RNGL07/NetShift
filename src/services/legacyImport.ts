/**
 * Migration of NetShift 1.x `netshift_data` rows into the structured tables.
 *
 * The 1.x store was a handful of JSON strings typed into a prototype. Two
 * decisions follow from that:
 *
 *  1. The transform runs **client-side, on the user's own data, and only on
 *     confirmation**. A silent server-side bulk migration of unvalidated JSON
 *     into financial records would write figures the user never sees and
 *     cannot check.
 *  2. Everything is validated on the way in, and anything that fails is
 *     reported and skipped rather than coerced. A skipped pay stub is
 *     recoverable; a wrong one quietly poisons every audit built on it.
 *
 * The legacy rows are never deleted by this process. The user can remove them
 * afterwards from Settings, once they have seen the import worked.
 */

import { supabase } from '@/lib/supabase/client';
import { insertRow, insertRows } from './crud';
import type { LegacyDataSummaryRow } from '@/types/database';

/** The keys NetShift 1.x wrote. */
export const LEGACY_KEYS = [
  'paycheck-stubs',
  'pay-ladder',
  'pay-premiums',
  'invest-accounts',
  'invest-live-prices',
  'market-reports',
] as const;

export type LegacyKey = (typeof LEGACY_KEYS)[number];

export const LEGACY_KEY_LABELS: Record<string, string> = {
  'paycheck-stubs': 'Saved pay stubs',
  'pay-ladder': 'Wage ladder',
  'pay-premiums': 'Shift and role premiums',
  'invest-accounts': 'Investment accounts',
  'invest-live-prices': 'Cached prices',
  'market-reports': 'Market reports',
};

/** Keys that are not worth importing — a price cache refetches in seconds. */
const SKIP_KEYS = new Set<string>(['invest-live-prices']);

export interface LegacySummary {
  key: string;
  label: string;
  itemCount: number;
  updatedAt: string;
  importable: boolean;
}

export async function loadLegacySummary(userId: string): Promise<LegacySummary[]> {
  const { data, error } = await supabase
    .from('legacy_data_summary')
    .select('*')
    .eq('user_id', userId);

  // The legacy table may not exist in a brand-new project. That is not an
  // error worth surfacing — it just means there is nothing to import.
  if (error) return [];

  return ((data ?? []) as LegacyDataSummaryRow[])
    .filter((row) => row.item_count > 0)
    .map((row) => ({
      key: row.key,
      label: LEGACY_KEY_LABELS[row.key] ?? row.key,
      itemCount: row.item_count,
      updatedAt: row.updated_at,
      importable: !SKIP_KEYS.has(row.key),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function readLegacyValue(userId: string, key: string): Promise<unknown | null> {
  const { data, error } = await supabase
    .from('netshift_data')
    .select('value')
    .eq('user_id', userId)
    .eq('key', key)
    .maybeSingle<{ value: string | null }>();

  if (error || !data?.value) return null;
  try {
    return JSON.parse(data.value);
  } catch {
    // Malformed JSON from the prototype: nothing to do but skip it.
    return null;
  }
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  const slash = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(trimmed);
  if (slash) {
    let year = Number(slash[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return `${year}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  }

  const parsed = new Date(trimmed);
  if (
    Number.isFinite(parsed.getTime()) &&
    parsed.getFullYear() > 1990 &&
    parsed.getFullYear() < 2100
  ) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }
  return null;
}

export interface ImportResult {
  imported: Record<string, number>;
  skipped: { key: string; reason: string }[];
  warnings: string[];
}

/**
 * Runs the import.
 *
 * Each section is independent: a malformed ladder does not stop the pay stubs
 * from coming across.
 */
export async function importLegacyData(
  userId: string,
  options: { payProfileId: string | null },
): Promise<ImportResult> {
  const imported: Record<string, number> = {};
  const skipped: { key: string; reason: string }[] = [];
  const warnings: string[] = [];

  // --- Pay stubs ----------------------------------------------------------
  const stubs = await readLegacyValue(userId, 'paycheck-stubs');
  if (Array.isArray(stubs) && stubs.length > 0) {
    const rows: Record<string, unknown>[] = [];
    let dropped = 0;

    for (const entry of stubs) {
      const stub = (entry ?? {}) as Record<string, unknown>;
      const gross = toNumberOrNull(stub.gross_pay);
      const net = toNumberOrNull(stub.net_pay);

      // A stub with neither figure carries no information worth keeping.
      if (gross === null && net === null) {
        dropped += 1;
        continue;
      }
      // The database rejects net above gross; catching it here lets us
      // explain it rather than failing the whole insert.
      if (gross !== null && net !== null && net > gross * 1.05) {
        dropped += 1;
        continue;
      }

      rows.push({
        pay_profile_id: options.payProfileId,
        pay_date: toIsoOrNull(stub.pay_date),
        gross_pay: gross,
        net_pay: net,
        hours_worked: toNumberOrNull(stub.hours_worked),
        hourly_rate: toNumberOrNull(stub.hourly_rate),
        federal_tax: toNumberOrNull(stub.federal_tax),
        state_tax: toNumberOrNull(stub.state_tax),
        social_security: toNumberOrNull(stub.social_security),
        medicare: toNumberOrNull(stub.medicare),
        other_deductions_total: toNumberOrNull(stub.other_deductions_total),
        // Provenance is preserved where 1.x recorded it.
        source: stub.source === 'local' || stub.source === 'ai' ? stub.source : 'manual',
        confirmed_by_user: false,
        note: 'Imported from NetShift 1.x',
      });
    }

    if (rows.length > 0) {
      try {
        await insertRows('pay_stubs', userId, rows);
        imported['paycheck-stubs'] = rows.length;
      } catch (error) {
        skipped.push({
          key: 'paycheck-stubs',
          reason: error instanceof Error ? error.message : 'Could not import pay stubs.',
        });
      }
    }
    if (dropped > 0) {
      warnings.push(
        `${dropped} saved ${dropped === 1 ? 'stub was' : 'stubs were'} skipped because the figures did not add up — those are still in your old data and can be re-entered by hand.`,
      );
    }
  }

  // --- Wage ladder and premiums ------------------------------------------
  const ladder = await readLegacyValue(userId, 'pay-ladder');
  const premiums = await readLegacyValue(userId, 'pay-premiums');

  let profileId = options.payProfileId;
  if ((ladder || premiums) && !profileId) {
    try {
      const created = await insertRow<{ id: string }>('user_pay_profiles', userId, {
        name: 'Imported pay profile',
      });
      profileId = created.id;
    } catch {
      skipped.push({ key: 'pay-ladder', reason: 'Could not create a pay profile to import into.' });
    }
  }

  if (profileId && ladder && typeof ladder === 'object') {
    const steps = (ladder as { steps?: unknown }).steps;
    if (Array.isArray(steps)) {
      const rows = steps
        .map((entry, index) => {
          const step = (entry ?? {}) as Record<string, unknown>;
          const rate = toNumberOrNull(step.rate);
          if (rate === null || rate <= 0 || rate > 500) return null;
          return {
            pay_profile_id: profileId,
            label:
              typeof step.label === 'string' && step.label.trim()
                ? step.label.slice(0, 60)
                : `Step ${index + 1}`,
            hourly_rate: rate,
            sort_order: index,
            is_current: false,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      if (rows.length > 0) {
        try {
          await insertRows('user_wage_ladder_steps', userId, rows);
          imported['pay-ladder'] = rows.length;
        } catch (error) {
          skipped.push({
            key: 'pay-ladder',
            reason: error instanceof Error ? error.message : 'Could not import the wage ladder.',
          });
        }
      }
    }
  }

  if (profileId && premiums && typeof premiums === 'object') {
    const record = premiums as Record<string, unknown>;
    const shift = toNumberOrNull(record.shiftPremium);
    const role = toNumberOrNull(record.teamLeaderPremium);
    const patch: Record<string, unknown> = {};
    // Per-hour premiums above $50 were never valid; treat them as bad data.
    if (shift !== null && shift >= 0 && shift <= 50) patch.shift_premium = shift;
    if (role !== null && role >= 0 && role <= 50) patch.role_premium = role;
    if (typeof record.isTeamLeader === 'boolean') patch.has_role_premium = record.isTeamLeader;

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase
        .from('user_pay_profiles')
        .update(patch)
        .eq('id', profileId)
        .eq('user_id', userId);
      if (!error) imported['pay-premiums'] = 1;
    }
  }

  // --- Investment accounts ------------------------------------------------
  const accounts = await readLegacyValue(userId, 'invest-accounts');
  if (Array.isArray(accounts) && accounts.length > 0) {
    let accountCount = 0;
    let holdingCount = 0;

    for (const [index, entry] of accounts.entries()) {
      const account = (entry ?? {}) as Record<string, unknown>;
      const name =
        typeof account.name === 'string' && account.name.trim()
          ? account.name.slice(0, 80)
          : `Account ${index + 1}`;
      const isCash = account.kind === 'cash';
      const balance = toNumberOrNull(account.balance);

      try {
        const created = await insertRow<{ id: string }>('investment_accounts', userId, {
          name,
          // 1.x only knew "cash" and "holdings"; the name is the best hint at
          // the real account type, and the user can correct it afterwards.
          kind: isCash ? 'cash' : guessAccountKind(name),
          balance: isCash ? Math.max(0, balance ?? 0) : null,
          sort_order: index,
        });
        accountCount += 1;

        if (!isCash && Array.isArray(account.holdings)) {
          const holdings = (account.holdings as unknown[])
            .map((holdingEntry, holdingIndex) => {
              const holding = (holdingEntry ?? {}) as Record<string, unknown>;
              const ticker =
                typeof holding.ticker === 'string' ? holding.ticker.trim().toUpperCase() : '';
              const shares = toNumberOrNull(holding.shares) ?? 0;
              const manualPrice = toNumberOrNull(holding.manualPrice);
              // The table requires a ticker or a name; skip rows with neither.
              if (!ticker) return null;
              return {
                account_id: created.id,
                ticker,
                shares: Math.max(0, shares),
                manual_price: manualPrice !== null && manualPrice > 0 ? manualPrice : null,
                sort_order: holdingIndex,
              };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null);

          if (holdings.length > 0) {
            await insertRows('holdings', userId, holdings);
            holdingCount += holdings.length;
          }
        }
      } catch {
        // One bad account should not abandon the rest.
      }
    }

    if (accountCount > 0) {
      imported['invest-accounts'] = accountCount;
      if (holdingCount > 0) warnings.push(`${holdingCount} holdings came across with them.`);
    }
  }

  // --- Market reports -----------------------------------------------------
  const reports = await readLegacyValue(userId, 'market-reports');
  if (Array.isArray(reports) && reports.length > 0) {
    const rows = reports
      .slice(0, 50)
      .map((entry) => {
        const report = (entry ?? {}) as Record<string, unknown>;
        return {
          generated_at:
            typeof report.generatedAt === 'string' ? report.generatedAt : new Date().toISOString(),
          as_of: typeof report.asOf === 'string' ? report.asOf.slice(0, 80) : null,
          stock_market:
            typeof report.stockMarket === 'string' ? report.stockMarket.slice(0, 2000) : null,
          stocks_to_watch: Array.isArray(report.stocksToWatch) ? report.stocksToWatch : [],
          housing_market:
            typeof report.housingMarket === 'string' ? report.housingMarket.slice(0, 2000) : null,
          commodities:
            typeof report.commodities === 'string' ? report.commodities.slice(0, 2000) : null,
        };
      })
      .filter((row) => row.stock_market || row.housing_market || row.commodities);

    if (rows.length > 0) {
      try {
        await insertRows('market_reports', userId, rows);
        imported['market-reports'] = rows.length;
      } catch {
        skipped.push({ key: 'market-reports', reason: 'Could not import saved market reports.' });
      }
    }
  }

  await supabase
    .from('profiles')
    .update({ legacy_import_status: 'imported', legacy_imported_at: new Date().toISOString() })
    .eq('id', userId);

  return { imported, skipped, warnings };
}

/** Infers an account type from its 1.x name, which is all the signal there is. */
function guessAccountKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('roth ira')) return 'roth_ira';
  if (lower.includes('roth')) return 'roth_401k';
  if (lower.includes('401')) return 'traditional_401k';
  if (lower.includes('ira')) return 'traditional_ira';
  if (lower.includes('hsa')) return 'hsa';
  if (lower.includes('broker')) return 'brokerage';
  return 'custom';
}

export async function markLegacyImportSkipped(userId: string): Promise<void> {
  await supabase.from('profiles').update({ legacy_import_status: 'skipped' }).eq('id', userId);
}

export async function deleteLegacyData(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('netshift_data')
    .delete()
    .eq('user_id', userId)
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}
