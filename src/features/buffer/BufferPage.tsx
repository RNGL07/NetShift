/**
 * Feature 5 — Variable-Income Buffer.
 *
 * The question this answers is not "do I have three months of expenses?" but
 * "how much of what I have committed to only works if the overtime keeps
 * coming?" — which is the thing that actually bites a shift worker in a slow
 * quarter.
 */

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  Button,
  Callout,
  ErrorMessage,
  Grid,
  LoadingState,
  NumberField,
  Panel,
  Progress,
  Stat,
} from '@/components/ui';
import { ProGate } from '@/components/ProGate';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useCollection } from '@/hooks/useCollection';
import { upsertRow } from '@/services/crud';
import { supabase } from '@/lib/supabase/client';
import type { BufferSettingsRow, PayStubRow } from '@/types/database';
import { calculateBuffer } from '@/lib/calc/buffer';
import { fmtHours, fmtMoney, fmtPct } from '@/lib/format';
import { num } from '@/lib/calc/money';
import './buffer.css';

export function BufferPage() {
  const { user } = useAuth();
  const { effective } = usePayProfile();
  const { items: stubs, loading } = useCollection<PayStubRow>('pay_stubs', {
    orderBy: 'pay_date',
    ascending: false,
  });

  const [settings, setSettings] = useState({
    essential: '',
    total: '',
    months: '3',
    saved: '',
  });
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const { data } = await supabase
        .from('buffer_settings')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle<BufferSettingsRow>();
      if (data) {
        setSettings({
          essential: String(data.monthly_essential_expenses || ''),
          total: String(data.monthly_total_obligations || ''),
          months: String(data.target_months_of_cover || 3),
          saved: String(data.current_buffer_balance || ''),
        });
      }
      setLoadingSettings(false);
    })();
  }, [user]);

  const result = useMemo(
    () =>
      calculateBuffer({
        history: stubs.map((stub) => ({
          payDate: stub.pay_date,
          grossPay: stub.gross_pay,
          netPay: stub.net_pay,
          hoursWorked: stub.hours_worked,
          overtimeHours: stub.overtime_hours,
        })),
        frequency: effective.payFrequency,
        monthlyEssentialExpenses: num(settings.essential),
        monthlyTotalObligations: num(settings.total) || num(settings.essential),
        targetMonthsOfCover: num(settings.months, 3),
        baseRate: effective.baseRate,
        overtimeMultiplier: effective.rules.overtimeMultiplier,
        currentBufferBalance: num(settings.saved),
      }),
    [stubs, effective, settings],
  );

  async function save() {
    if (!user) return;
    setSaving(true);
    setError(null);
    try {
      await upsertRow(
        'buffer_settings',
        {
          user_id: user.id,
          monthly_essential_expenses: num(settings.essential),
          monthly_total_obligations: num(settings.total) || num(settings.essential),
          target_months_of_cover: num(settings.months, 3),
          current_buffer_balance: num(settings.saved),
        },
        'user_id',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save those settings.');
    } finally {
      setSaving(false);
    }
  }

  if (loading || loadingSettings) return <LoadingState label="Loading…" />;

  return (
    <>
      <PageHeader
        title="Income buffer"
        feature="buffer_recommendations"
        description="How much cash you need behind you when your income moves with the overtime — and how much of what you have committed to depends on that overtime continuing."
      />

      <ErrorMessage>{error}</ErrorMessage>

      <Panel title="What you spend">
        <Grid min={180}>
          <NumberField
            label="Essential monthly expenses"
            prefix="$"
            step="10"
            min="0"
            value={settings.essential}
            onChange={(event) => setSettings({ ...settings, essential: event.target.value })}
            hint="Rent or mortgage, food, utilities, transport, insurance."
          />
          <NumberField
            label="All monthly obligations"
            prefix="$"
            step="10"
            min="0"
            value={settings.total}
            onChange={(event) => setSettings({ ...settings, total: event.target.value })}
            hint="Everything that comes out each month, including the non-essential."
          />
          <NumberField
            label="Months of cover you want"
            step="0.5"
            min="0.5"
            max="24"
            value={settings.months}
            onChange={(event) => setSettings({ ...settings, months: event.target.value })}
          />
          <NumberField
            label="Set aside already"
            prefix="$"
            step="10"
            min="0"
            value={settings.saved}
            onChange={(event) => setSettings({ ...settings, saved: event.target.value })}
          />
        </Grid>
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </Panel>

      <Panel title="What NetShift suggests" tone={result.bufferGap > 0 ? 'warning' : 'success'}>
        <Grid min={170}>
          <Stat
            label="Buffer to aim for"
            value={fmtMoney(result.recommendedBuffer)}
            size="large"
            estimated
            tone="warning"
          />
          <Stat
            label="Still to save"
            value={fmtMoney(result.bufferGap)}
            tone={result.bufferGap > 0 ? 'negative' : 'positive'}
            sub={
              result.monthsOfCoverToday !== null
                ? `You have about ${result.monthsOfCoverToday.toFixed(1)} months of essentials covered`
                : undefined
            }
          />
          {result.lowestNormalPaycheck !== null && (
            <Stat
              label="A lean paycheck"
              value={fmtMoney(result.lowestNormalPaycheck)}
              sub="The 10th percentile of your history, not your single worst check"
            />
          )}
        </Grid>

        {result.currentBufferBalance > 0 && result.recommendedBuffer > 0 && (
          <Progress
            value={result.currentBufferBalance}
            max={result.recommendedBuffer}
            label="Buffer progress"
            tone={result.bufferGap > 0 ? 'amber' : 'green'}
          />
        )}

        {result.warnings.map((warning) => (
          <Callout key={warning} tone="warning" icon="!">
            {warning}
          </Callout>
        ))}
      </Panel>

      <Panel title="What your paychecks look like">
        <Grid min={160}>
          <Stat
            label="Paychecks used"
            value={String(result.sampleSize)}
            sub={`Confidence: ${result.confidence}`}
          />
          {result.averagePaycheck !== null && (
            <Stat label="Average take-home" value={fmtMoney(result.averagePaycheck)} />
          )}
          {result.averageBasePayOnlyPaycheck !== null && (
            <Stat
              label="Base pay only"
              value={fmtMoney(result.averageBasePayOnlyPaycheck)}
              sub="What a paycheck looks like with no overtime"
            />
          )}
          {result.incomeVariabilityPct !== null && (
            <Stat
              label="How much it swings"
              value={fmtPct(result.incomeVariabilityPct, 0)}
              tone={result.incomeVariabilityPct > 25 ? 'warning' : 'default'}
            />
          )}
        </Grid>

        <div className="ns-buffer__explain">
          {result.explanation.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </Panel>

      <ProGate
        feature="overtime_dependency"
        preview={
          <Panel title="How much depends on overtime">
            <p>&nbsp;</p>
          </Panel>
        }
      >
        <Panel
          title="How much depends on overtime"
          tone={
            result.obligationsDependentOnOvertime && result.obligationsDependentOnOvertime > 0
              ? 'warning'
              : 'success'
          }
        >
          <Grid min={175}>
            <Stat
              label="Monthly income from base pay"
              value={fmtMoney(result.monthlyIncomeFromBasePay)}
              estimated
            />
            <Stat
              label="Commitments above base pay"
              value={fmtMoney(result.obligationsDependentOnOvertime)}
              tone={
                result.obligationsDependentOnOvertime && result.obligationsDependentOnOvertime > 0
                  ? 'negative'
                  : 'positive'
              }
              sub="What only works if the overtime keeps coming"
            />
            {result.overtimeHoursPerMonthToSustain !== null && (
              <Stat
                label="Overtime hours needed"
                value={fmtHours(result.overtimeHoursPerMonthToSustain)}
                sub="Per month, to cover that gap"
                estimated
                tone={result.overtimeHoursPerMonthToSustain > 40 ? 'warning' : 'default'}
              />
            )}
          </Grid>

          {result.overtimeHoursPerMonthToSustain !== null &&
            result.overtimeHoursPerMonthToSustain > 40 && (
              <Callout tone="warning" icon="!">
                That is more than a full extra week of work every month, just to stand still. Worth
                knowing before the next slow quarter.
              </Callout>
            )}

          {result.monthlyGapWithoutOvertime !== null && result.monthlyGapWithoutOvertime > 0 && (
            <Callout tone="danger" icon="!">
              If overtime stopped entirely, base pay would fall about{' '}
              <strong>{fmtMoney(result.monthlyGapWithoutOvertime)}</strong> short of your essential
              expenses each month. That gap, over {settings.months} months, is what this buffer is
              sized to cover.
            </Callout>
          )}
        </Panel>
      </ProGate>

      <Callout tone="neutral">
        These figures come from your own saved paychecks. The more you save, the better they get —
        and they are estimates for planning, not a guarantee about future income.
      </Callout>
    </>
  );
}
