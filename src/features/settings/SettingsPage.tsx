/**
 * Settings: profile, data export, legacy cleanup, and account deletion.
 *
 * Deletion is the part that matters. It requires the email retyped, says
 * exactly what goes, and is honest that it cannot be undone — no soft-delete
 * pretending to be a delete.
 */

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  Button,
  Callout,
  ErrorMessage,
  Grid,
  LoadingState,
  Panel,
  TextField,
} from '@/components/ui';
import { ProGate } from '@/components/ProGate';
import { useAuth } from '@/features/auth/AuthContext';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import { supabase } from '@/lib/supabase/client';
import { apiRequest, ApiClientError } from '@/lib/api/client';
import { deleteLegacyData, loadLegacySummary, type LegacySummary } from '@/services/legacyImport';
import { downloadJson } from '@/lib/export';
import type { ProfileRow } from '@/types/database';

export function SettingsPage() {
  const { user, signOut } = useAuth();
  const { subscription } = useEntitlement();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [employer, setEmployer] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<LegacySummary[]>([]);
  const [exporting, setExporting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle<ProfileRow>();
      if (data) {
        setProfile(data);
        setDisplayName(data.display_name ?? '');
        setEmployer(data.employer_name ?? '');
      }
      setLegacy(await loadLegacySummary(user.id));
      setLoading(false);
    })();
  }, [user]);

  async function saveProfile() {
    if (!user) return;
    setSaving(true);
    setError(null);
    try {
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ display_name: displayName || null, employer_name: employer || null })
        .eq('id', user.id);
      if (updateError) throw updateError;
      setNotice('Saved.');
      window.setTimeout(() => setNotice(null), 3000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  /** Pulls every user-owned table and writes one JSON file. */
  async function exportEverything() {
    if (!user) return;
    setExporting(true);
    setError(null);
    try {
      const tables = [
        'profiles',
        'user_pay_profiles',
        'user_wage_ladder_steps',
        'pay_periods',
        'logged_shifts',
        'pay_stubs',
        'paycheck_audits',
        'bills',
        'paycheck_plans',
        'goals',
        'goal_contributions',
        'debts',
        'debt_payments',
        'buffer_settings',
        'shift_scenarios',
        'rotation_patterns',
        'rotation_exceptions',
        'bonuses',
        'bonus_allocations',
        'investment_accounts',
        'holdings',
        'market_reports',
      ];

      const bundle: Record<string, unknown> = {
        exportedAt: new Date().toISOString(),
        note: 'NetShift data export. Figures are your own entries and estimates, not authoritative payroll records.',
      };

      for (const table of tables) {
        // Row-level security scopes each of these to the caller, so no
        // additional filter is needed — but one is applied anyway where the
        // table has a user_id, so an RLS misconfiguration cannot widen this.
        const query =
          table === 'profiles'
            ? supabase.from(table).select('*').eq('id', user.id)
            : supabase.from(table).select('*').eq('user_id', user.id);
        const { data } = await query;
        bundle[table] = data ?? [];
      }

      downloadJson(`netshift-export-${new Date().toISOString().slice(0, 10)}.json`, bundle);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not build the export.');
    } finally {
      setExporting(false);
    }
  }

  async function deleteAccount() {
    if (!user) return;
    setDeleting(true);
    setError(null);
    try {
      await apiRequest('/api/account/delete', { body: { confirmEmail } });
      await signOut();
      window.location.assign('/');
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : 'Your account could not be deleted.',
      );
      setDeleting(false);
    }
  }

  if (loading) return <LoadingState label="Loading settings…" />;

  const legacyTotal = legacy.reduce((sum, entry) => sum + entry.itemCount, 0);

  return (
    <>
      <PageHeader title="Settings" description="Your details, your data, and your account." />

      <ErrorMessage>{error}</ErrorMessage>
      {notice && (
        <Callout tone="success" icon="✓">
          {notice}
        </Callout>
      )}

      <Panel title="About you">
        <Grid min={200}>
          <TextField label="Email" value={user?.email ?? ''} disabled readOnly />
          <TextField
            label="Name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <TextField
            label="Employer"
            value={employer}
            onChange={(event) => setEmployer(event.target.value)}
            hint="Only used to suggest relevant wage profiles. Never shared."
          />
        </Grid>
        <Button variant="primary" loading={saving} onClick={() => void saveProfile()}>
          Save
        </Button>
      </Panel>

      <Panel title="Your data">
        <p>
          Everything NetShift holds about you is yours. The export is a single JSON file containing
          every record in your account.
        </p>
        <ProGate feature="data_export" compact>
          <Button loading={exporting} onClick={() => void exportEverything()}>
            Export everything as JSON
          </Button>
        </ProGate>
      </Panel>

      {legacyTotal > 0 && (
        <Panel title="Data from the old version of NetShift">
          <p>
            You still have {legacyTotal} records saved by NetShift 1.x
            {profile?.legacy_import_status === 'imported'
              ? ', which have already been imported into the new structure.'
              : '. These are not used by the current app.'}
          </p>
          <Callout tone="warning" icon="!">
            Deleting this removes the old copy permanently. If you imported it, check the figures
            came across correctly first — this cannot be undone.
          </Callout>
          <Button
            variant="danger"
            onClick={async () => {
              if (!user) return;
              const removed = await deleteLegacyData(user.id);
              setLegacy([]);
              setNotice(`Removed ${removed} old records.`);
            }}
          >
            Delete the old data
          </Button>
        </Panel>
      )}

      <Panel title="Close your account" tone="danger">
        <p>
          Deleting your account removes your pay stubs, hours, plans, goals, debts, investments, and
          every other record, along with any documents still stored. It cannot be undone.
        </p>
        {subscription.tier === 'pro' && (
          <Callout tone="warning" icon="!">
            Your subscription will be cancelled as part of this, so you will not be billed again.
          </Callout>
        )}
        <Grid min={240}>
          <TextField
            label="Type your email address to confirm"
            value={confirmEmail}
            onChange={(event) => setConfirmEmail(event.target.value)}
            placeholder={user?.email ?? ''}
            autoComplete="off"
          />
        </Grid>
        <Button
          variant="danger"
          loading={deleting}
          disabled={confirmEmail.trim().toLowerCase() !== (user?.email ?? '').toLowerCase()}
          onClick={() => void deleteAccount()}
        >
          Permanently delete my account
        </Button>
      </Panel>
    </>
  );
}
