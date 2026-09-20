/**
 * The one-time prompt offering to bring NetShift 1.x data across.
 *
 * Shown once, dismissible, and explicit about exactly what will be created
 * before anything is written. The old rows are left in place either way, so
 * the import is never a one-way door.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { Button, Callout, ErrorMessage, Panel, Spinner } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import {
  importLegacyData,
  loadLegacySummary,
  markLegacyImportSkipped,
  type ImportResult,
  type LegacySummary,
} from '@/services/legacyImport';

export function LegacyImportPrompt() {
  const { user } = useAuth();
  const { active, refresh: refreshProfile } = usePayProfile();
  const [status, setStatus] = useState<string | null>(null);
  const [summary, setSummary] = useState<LegacySummary[]>([]);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async () => {
    if (!user) return;
    try {
      const { data } = await supabase
        .from('profiles')
        .select('legacy_import_status')
        .eq('id', user.id)
        .maybeSingle<{ legacy_import_status: string }>();

      const current = data?.legacy_import_status ?? 'pending';
      setStatus(current);
      // Only look for legacy rows if the user has not already decided.
      if (current === 'pending') {
        setSummary(await loadLegacySummary(user.id));
      }
    } catch {
      // A missing legacy table is the normal case for a new project.
      setSummary([]);
    } finally {
      setChecking(false);
    }
  }, [user]);

  useEffect(() => {
    void check();
  }, [check]);

  if (checking || dismissed) return null;
  if (status !== 'pending') return null;

  const importable = summary.filter((entry) => entry.importable);
  if (importable.length === 0 && !result) return null;

  async function runImport() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await importLegacyData(user.id, { payProfileId: active?.id ?? null });
      setResult(outcome);
      await refreshProfile();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The import could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    if (!user) return;
    await markLegacyImportSkipped(user.id);
    setDismissed(true);
  }

  if (result) {
    const total = Object.values(result.imported).reduce((sum, count) => sum + count, 0);
    return (
      <Panel title="Your old NetShift data is in" tone="success">
        {total === 0 ? (
          <p>Nothing needed importing.</p>
        ) : (
          <>
            <p>Brought across:</p>
            <ul className="ns-legacy__list">
              {Object.entries(result.imported).map(([key, count]) => (
                <li key={key}>
                  <strong>{count}</strong>{' '}
                  {key === 'paycheck-stubs'
                    ? count === 1
                      ? 'pay stub'
                      : 'pay stubs'
                    : key === 'pay-ladder'
                      ? count === 1
                        ? 'wage step'
                        : 'wage steps'
                      : key === 'pay-premiums'
                        ? 'premium setting'
                        : key === 'invest-accounts'
                          ? count === 1
                            ? 'investment account'
                            : 'investment accounts'
                          : count === 1
                            ? 'market report'
                            : 'market reports'}
                </li>
              ))}
            </ul>
          </>
        )}

        {result.warnings.map((warning) => (
          <Callout key={warning} tone="warning" icon="!">
            {warning}
          </Callout>
        ))}
        {result.skipped.map((entry) => (
          <Callout key={entry.key} tone="danger" icon="!">
            {entry.reason}
          </Callout>
        ))}

        <Callout tone="neutral">
          Your old data has <strong>not</strong> been deleted. Check the imported figures, and when
          you are happy, you can remove the old copy from Settings.
        </Callout>

        <Button variant="primary" onClick={() => setDismissed(true)}>
          Got it
        </Button>
      </Panel>
    );
  }

  return (
    <Panel title="Bring your old NetShift data across?" tone="warning">
      <p>
        NetShift found data saved by the earlier version of the app. It can be imported into the new
        structure now.
      </p>

      <ul className="ns-legacy__list">
        {importable.map((entry) => (
          <li key={entry.key}>
            <strong>{entry.itemCount}</strong> {entry.label.toLowerCase()}
          </li>
        ))}
      </ul>

      <Callout tone="neutral">
        Figures are checked as they come across. Anything that does not add up — a net above its
        gross, a rate outside a plausible range — is skipped and reported rather than imported, and
        your old data is left untouched either way.
      </Callout>

      <ErrorMessage>{error}</ErrorMessage>

      <div className="ns-legacy__actions">
        <Button variant="primary" loading={busy} onClick={() => void runImport()}>
          {busy ? 'Importing…' : 'Import my data'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void skip()}>
          Not now
        </Button>
        {busy && <Spinner label="Importing" />}
      </div>
    </Panel>
  );
}
