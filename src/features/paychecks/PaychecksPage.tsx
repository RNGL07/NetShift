/**
 * Paycheck history and stub upload.
 *
 * Uploaded figures always land in a review form before they are saved. The
 * local parser and the AI both misread things, and a wrong gross saved without
 * a glance silently corrupts every audit and buffer calculation built on it.
 */

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  Badge,
  Button,
  Callout,
  ConfirmButton,
  DataTable,
  EmptyState,
  ErrorMessage,
  Grid,
  LoadingState,
  NumberField,
  Panel,
  Stat,
  TextField,
} from '@/components/ui';
import { ProAction } from '@/components/ProGate';
import { DocumentUpload, RetryWithAi } from '@/components/DocumentUpload';
import { useAuth } from '@/features/auth/AuthContext';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, insertRow } from '@/services/crud';
import { apiRequest, ApiClientError } from '@/lib/api/client';
import type { PayStubRow } from '@/types/database';
import {
  parsePayStubText,
  PAY_STUB_FIELDS,
  type ParsedPayStub,
} from '@/lib/parsing/paystub';
import { averageDeductionPct } from '@/lib/calc/pay';
import { formatIsoDate } from '@/lib/calc/dates';
import { fmtHours, fmtMoney, fmtPct, fmtRate } from '@/lib/format';
import { num } from '@/lib/calc/money';
import { PLAN_LIMITS } from '@/config/plans';
import '@/features/hours/hours.css';

type StubDraft = Record<string, string>;

function draftFromParsed(parsed: Partial<ParsedPayStub>): StubDraft {
  const draft: StubDraft = {};
  for (const field of PAY_STUB_FIELDS) {
    const value = parsed[field.key];
    draft[field.key] = value === null || value === undefined ? '' : String(value);
  }
  return draft;
}

export function PaychecksPage() {
  const { user } = useAuth();
  const { effective, save } = usePayProfile();
  const { isPro } = useEntitlement();
  const { items, loading, refresh } = useCollection<PayStubRow>('pay_stubs', {
    orderBy: 'pay_date',
    ascending: false,
  });

  const [draft, setDraft] = useState<StubDraft | null>(null);
  const [draftSource, setDraftSource] = useState<'local' | 'ai' | 'manual'>('manual');
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explaining, setExplaining] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<{ id: string; body: string } | null>(null);

  const historyLimit = PLAN_LIMITS[isPro ? 'pro' : 'free'].paycheckHistory;
  const visible = useMemo(
    () => (Number.isFinite(historyLimit) ? items.slice(0, historyLimit) : items),
    [items, historyLimit],
  );

  const learnedDeductionPct = useMemo(
    () =>
      averageDeductionPct(
        items.map((stub) => ({ grossPay: stub.gross_pay, netPay: stub.net_pay })),
      ),
    [items],
  );

  async function saveDraft() {
    if (!draft || !user) return;
    setSaving(true);
    setError(null);
    try {
      const values: Record<string, unknown> = {
        pay_profile_id: effective.id,
        source: draftSource,
        confirmed_by_user: true,
      };
      const COLUMN: Record<string, string> = {
        payDate: 'pay_date',
        periodStart: 'period_start',
        periodEnd: 'period_end',
        grossPay: 'gross_pay',
        netPay: 'net_pay',
        hoursWorked: 'hours_worked',
        regularHours: 'regular_hours',
        overtimeHours: 'overtime_hours',
        hourlyRate: 'hourly_rate',
        federalTax: 'federal_tax',
        stateTax: 'state_tax',
        socialSecurity: 'social_security',
        medicare: 'medicare',
        otherDeductionsTotal: 'other_deductions_total',
      };

      for (const field of PAY_STUB_FIELDS) {
        const column = COLUMN[field.key];
        if (!column) continue;
        const raw = (draft[field.key] ?? '').trim();
        values[column] = raw === '' ? null : field.type === 'number' ? num(raw) : raw;
      }

      const gross = values.gross_pay as number | null;
      const net = values.net_pay as number | null;
      if (gross !== null && net !== null && net > gross * 1.05) {
        setError(
          'Net pay is higher than gross pay. One of those was misread — check both before saving.',
        );
        return;
      }

      await insertRow('pay_stubs', user.id, values);
      setDraft(null);
      setDraftFile(null);
      setIssues([]);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that paycheck.');
    } finally {
      setSaving(false);
    }
  }

  async function explain(stubId: string) {
    setExplaining(stubId);
    setError(null);
    try {
      const response = await apiRequest<{ explanation: string }>('/api/ai/explain-paycheck', {
        body: { payStubId: stubId },
      });
      setExplanation({ id: stubId, body: response.explanation });
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Could not explain that paycheck.');
    } finally {
      setExplaining(null);
    }
  }

  if (loading) return <LoadingState label="Loading your paychecks…" />;

  return (
    <>
      <PageHeader
        title="Paychecks"
        description="Save each paycheck as it arrives. The history is what makes the audit, the buffer recommendation, and your deduction estimate accurate."
      />

      <ErrorMessage>{error}</ErrorMessage>

      {!draft && (
        <Panel title="Add a paycheck">
          <DocumentUpload
            kind="paystub"
            label="Upload a pay stub"
            description="A PDF from your payroll portal, or a photo of a printed stub."
            parseLocally={(text) => {
              const result = parsePayStubText(text);
              return { data: result.data, confident: result.confidence.confident };
            }}
            onParsed={(outcome) => {
              setDraft(draftFromParsed(outcome.data as ParsedPayStub));
              setDraftSource(outcome.source);
              setDraftFile(outcome.file);
              setIssues(outcome.issues);
            }}
          />
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(draftFromParsed({}));
              setDraftSource('manual');
              setDraftFile(null);
              setIssues([]);
            }}
          >
            Enter the figures by hand instead
          </Button>
        </Panel>
      )}

      {draft && (
        <Panel title="Check these figures before saving" tone="warning">
          <div className="ns-review__source">
            <Badge tone={draftSource === 'local' ? 'green' : draftSource === 'ai' ? 'blue' : 'neutral'}>
              {draftSource === 'local'
                ? 'read in your browser'
                : draftSource === 'ai'
                  ? 'transcribed by AI'
                  : 'entered by hand'}
            </Badge>
            <span className="ns-muted">Nothing is saved until you confirm.</span>
          </div>

          {issues.length > 0 && (
            <Callout tone="warning" icon="!">
              <strong>Some values needed attention:</strong>
              <ul>
                {issues.map((issue) => (
                  <li key={`${issue.field}-${issue.message}`}>
                    {issue.field} {issue.message}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          <Grid min={180}>
            {PAY_STUB_FIELDS.map((field) =>
              field.type === 'number' ? (
                <NumberField
                  key={field.key}
                  label={field.label}
                  prefix={field.key.toLowerCase().includes('hour') ? undefined : '$'}
                  step="0.01"
                  value={draft[field.key] ?? ''}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              ) : (
                <TextField
                  key={field.key}
                  label={field.label}
                  type="date"
                  value={draft[field.key] ?? ''}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              ),
            )}
          </Grid>

          <div className="ns-review__actions">
            <Button variant="primary" loading={saving} onClick={() => void saveDraft()}>
              Save this paycheck
            </Button>
            {draftFile && draftSource === 'local' && (
              <RetryWithAi
                file={draftFile}
                kind="paystub"
                disabled={saving}
                onParsed={(outcome) => {
                  setDraft(draftFromParsed(outcome.data as ParsedPayStub));
                  setDraftSource('ai');
                  setIssues(outcome.issues);
                }}
              />
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setDraftFile(null);
                setIssues([]);
              }}
            >
              Discard
            </Button>
          </div>
        </Panel>
      )}

      {learnedDeductionPct !== null && (
        <Panel title="What your history says">
          <Grid min={170}>
            <Stat
              label="Average deductions"
              value={fmtPct(learnedDeductionPct)}
              sub={`Across ${items.filter((s) => s.gross_pay && s.net_pay).length} paychecks`}
            />
            <Stat label="Paychecks saved" value={String(items.length)} />
          </Grid>
          {Math.abs(learnedDeductionPct - effective.deductionPct) > 1 && (
            <Callout tone="info" icon="i">
              Your pay profile uses {fmtPct(effective.deductionPct)}, but your saved stubs average{' '}
              {fmtPct(learnedDeductionPct)}.{' '}
              <Button
                variant="link"
                onClick={() => void save({ deductionPct: learnedDeductionPct })}
              >
                Use {fmtPct(learnedDeductionPct)} instead
              </Button>
            </Callout>
          )}
        </Panel>
      )}

      <Panel title="Your paychecks">
        <DataTable
          caption="Saved paychecks"
          columns={[
            {
              key: 'date',
              header: 'Pay date',
              render: (stub: PayStubRow) => formatIsoDate(stub.pay_date),
            },
            {
              key: 'gross',
              header: 'Gross',
              align: 'right',
              render: (stub: PayStubRow) => fmtMoney(stub.gross_pay),
            },
            {
              key: 'net',
              header: 'Take-home',
              align: 'right',
              render: (stub: PayStubRow) => fmtMoney(stub.net_pay),
            },
            {
              key: 'hours',
              header: 'Hours',
              align: 'right',
              render: (stub: PayStubRow) => fmtHours(stub.hours_worked),
            },
            {
              key: 'rate',
              header: 'Rate',
              align: 'right',
              render: (stub: PayStubRow) => fmtRate(stub.hourly_rate),
            },
            {
              key: 'actions',
              header: 'Actions',
              align: 'right',
              render: (stub: PayStubRow) => (
                <div className="ns-paychecks__actions">
                  {/* Stays visible for free users and explains itself on
                      click, rather than disappearing. */}
                  <ProAction
                    feature="ai_explanations"
                    variant="link"
                    loading={explaining === stub.id}
                    onClick={() => void explain(stub.id)}
                  >
                    Explain this
                  </ProAction>
                  <ConfirmButton
                    variant="link"
                    onConfirm={async () => {
                      if (!user) return;
                      await deleteRow('pay_stubs', stub.id, user.id);
                      await refresh();
                    }}
                  >
                    Delete
                  </ConfirmButton>
                </div>
              ),
            },
          ]}
          rows={visible}
          getKey={(stub) => stub.id}
          empty={
            <EmptyState title="No paychecks saved yet" icon="▤">
              Upload a stub above. Once a few are saved, NetShift can audit them, learn your real
              deduction rate, and size your income buffer.
            </EmptyState>
          }
        />

        {!isPro && items.length > historyLimit && (
          <Callout tone="warning" icon="!">
            You have {items.length} paychecks saved, and the free plan shows the most recent{' '}
            {historyLimit}. Nothing has been deleted — Pro shows all of them.
          </Callout>
        )}
      </Panel>

      {explanation && (
        <Panel title="What this paycheck says" tone="success">
          <p style={{ whiteSpace: 'pre-wrap' }}>{explanation.body}</p>
          <Callout tone="neutral">
            An explanation of your own figures, for education. Not tax, payroll, or financial advice.
          </Callout>
          <Button variant="ghost" onClick={() => setExplanation(null)}>
            Close
          </Button>
        </Panel>
      )}
    </>
  );
}
