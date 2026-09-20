/**
 * Feature 1 — Expected vs Actual Paycheck Audit.
 *
 * The tone rules from the product brief are enforced in `src/lib/calc/audit.ts`
 * and carried through here without softening or sharpening: NetShift compares
 * its own estimate against the stub and says what is worth checking. It never
 * claims payroll made an error, because it has no authoritative payroll data
 * and never will.
 */

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  EmptyState,
  Grid,
  LoadingState,
  Panel,
  SelectField,
  Stat,
} from '@/components/ui';
import { ProGate } from '@/components/ProGate';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import { useCollection } from '@/hooks/useCollection';
import type { LoggedShiftRow, PayStubRow } from '@/types/database';
import {
  auditPaycheck,
  buildExpectedPaycheck,
  detectAnomalies,
  type AuditLine,
} from '@/lib/calc/audit';
import { bucketWeek, addBuckets, type HourBuckets } from '@/lib/calc/hours';
import { daysBetween, formatIsoDate, startOfWeek } from '@/lib/calc/dates';
import { fmtHours, fmtMoney, fmtMoneySigned, fmtRate } from '@/lib/format';
import { downloadCsv } from '@/lib/export';
import './audit.css';

export function PaycheckAuditPage() {
  const { effective } = usePayProfile();
  const { isPro } = useEntitlement();
  const { items: stubs, loading } = useCollection<PayStubRow>('pay_stubs', {
    orderBy: 'pay_date',
    ascending: false,
  });
  const { items: shifts } = useCollection<LoggedShiftRow>('logged_shifts', {
    orderBy: 'work_date',
    ascending: true,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => stubs.find((stub) => stub.id === selectedId) ?? stubs[0] ?? null,
    [stubs, selectedId],
  );

  /**
   * Buckets the hours logged inside the stub's pay period.
   *
   * Hours are bucketed **week by week**, not pooled across the period: a
   * 14-day period is two separate overtime weeks, and pooling them would
   * under-count overtime and make every audit report a phantom shortfall.
   */
  const expected = useMemo(() => {
    if (!selected) return null;
    const start = selected.period_start;
    const end = selected.period_end;
    if (!start || !end) return null;

    const inPeriod = shifts.filter(
      (shift) => shift.work_date >= start && shift.work_date <= end && shift.paid_hours > 0,
    );
    if (inPeriod.length === 0) return null;

    const weeks = new Map<string, number[]>();
    for (const shift of inPeriod) {
      const weekStart = startOfWeek(shift.work_date);
      const days = weeks.get(weekStart) ?? [0, 0, 0, 0, 0, 0, 0];
      const index = daysBetween(weekStart, shift.work_date);
      if (index >= 0 && index < 7) days[index] += shift.paid_hours;
      weeks.set(weekStart, days);
    }

    let buckets: HourBuckets = { regular: 0, overtime: 0, doubleTime: 0 };
    for (const days of weeks.values()) {
      buckets = addBuckets(buckets, bucketWeek(days, effective.rules));
    }

    const premiumHours = inPeriod
      .filter((shift) => shift.designation !== 'day')
      .reduce((sum, shift) => sum + shift.paid_hours, 0);
    const totalHours = inPeriod.reduce((sum, shift) => sum + shift.paid_hours, 0);

    return buildExpectedPaycheck({
      buckets,
      baseRate: effective.baseRate,
      shiftPremiumPerHour: effective.premiums.shiftPremium,
      shiftPremiumHours: premiumHours,
      rolePremiumPerHour: effective.premiums.rolePremium,
      rolePremiumHours: effective.premiums.hasRolePremium ? totalHours : 0,
      perDiemAmount: 0,
      rules: effective.rules,
    });
  }, [selected, shifts, effective]);

  const audit = useMemo(() => {
    if (!selected || !expected) return null;
    return auditPaycheck(expected, {
      grossPay: selected.gross_pay,
      netPay: selected.net_pay,
      hoursWorked: selected.hours_worked,
      regularHours: selected.regular_hours,
      overtimeHours: selected.overtime_hours,
      doubleTimeHours: selected.double_time_hours,
      hourlyRate: selected.hourly_rate,
      shiftDifferentialAmount: selected.shift_differential_amount,
      sundayPremiumAmount: selected.sunday_premium_amount,
      rolePremiumAmount: selected.role_premium_amount,
      perDiemAmount: selected.per_diem_amount,
      federalTax: selected.federal_tax,
      stateTax: selected.state_tax,
      socialSecurity: selected.social_security,
      medicare: selected.medicare,
      otherDeductionsTotal: selected.other_deductions_total,
    });
  }, [selected, expected]);

  const anomalies = useMemo(
    () =>
      detectAnomalies(
        stubs.map((stub) => ({
          id: stub.id,
          payDate: stub.pay_date,
          grossPay: stub.gross_pay,
          netPay: stub.net_pay,
          hoursWorked: stub.hours_worked,
        })),
      ),
    [stubs],
  );

  if (loading) return <LoadingState label="Loading your paychecks…" />;

  if (stubs.length === 0) {
    return (
      <>
        <PageHeader title="Paycheck audit" feature="paycheck_audit_basic" />
        <Panel>
          <EmptyState title="No paychecks to check yet" icon="⚖">
            Save a pay stub and log the hours for the same period, and NetShift will compare what it
            expected against what the stub says.
          </EmptyState>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Paycheck audit"
        feature="paycheck_audit_basic"
        description="NetShift compares the hours you logged against what the stub says. These are estimates — they may not include every employer-specific payroll rule."
      />

      <Panel title="Which paycheck">
        <SelectField
          label="Paycheck"
          value={selected?.id ?? ''}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {stubs.map((stub) => (
            <option key={stub.id} value={stub.id}>
              {formatIsoDate(stub.pay_date)} — {fmtMoney(stub.gross_pay)} gross
            </option>
          ))}
        </SelectField>
      </Panel>

      {!selected?.period_start || !selected?.period_end ? (
        <Callout tone="warning" icon="!">
          This paycheck has no pay-period dates saved, so NetShift cannot tell which hours belong to
          it. Add the period start and end on the Paychecks page to run the comparison.
        </Callout>
      ) : !expected ? (
        <Callout tone="warning" icon="!">
          No hours are logged between {formatIsoDate(selected.period_start)} and{' '}
          {formatIsoDate(selected.period_end)}. Log the hours for that period and the comparison will
          run.
        </Callout>
      ) : audit ? (
        <>
          <Panel
            title="The comparison"
            tone={
              audit.findings.some((finding) => finding.severity === 'review')
                ? 'warning'
                : audit.findings.length > 0
                  ? 'default'
                  : 'success'
            }
          >
            <Grid min={170}>
              <Stat label="NetShift expected" value={fmtMoney(audit.expectedGross)} estimated />
              <Stat label="The stub says" value={fmtMoney(audit.actualGross)} />
              <Stat
                label="Difference"
                value={fmtMoneySigned(audit.grossDifference)}
                tone={
                  audit.grossDifference === null || Math.abs(audit.grossDifference) < 1
                    ? 'default'
                    : audit.grossDifference > 0
                      ? 'positive'
                      : 'negative'
                }
              />
            </Grid>

            <Callout
              tone={
                audit.findings.some((finding) => finding.severity === 'review')
                  ? 'warning'
                  : audit.findings.length > 0
                    ? 'info'
                    : 'success'
              }
              icon={audit.findings.length > 0 ? '!' : '✓'}
            >
              {audit.verdict}
            </Callout>

            <AuditLines lines={audit.summary} />
          </Panel>

          <ProGate
            feature="paycheck_audit_full"
            preview={
              <Panel title="Line-by-line reconciliation">
                <AuditLines lines={audit.detail.slice(0, 3)} />
              </Panel>
            }
          >
            <Panel
              title="Line-by-line reconciliation"
              actions={
                <Button
                  variant="ghost"
                  onClick={() =>
                    downloadCsv(
                      `netshift-audit-${selected.pay_date ?? 'paycheck'}.csv`,
                      ['Line', 'Expected', 'Actual', 'Difference', 'Severity', 'Note'],
                      audit.detail.map((line) => [
                        line.label,
                        line.expected ?? '',
                        line.actual ?? '',
                        line.difference ?? '',
                        line.severity,
                        line.message,
                      ]),
                    )
                  }
                >
                  Export as CSV
                </Button>
              }
            >
              <AuditLines lines={audit.detail} />
              {audit.incomparableCount > 0 && (
                <Callout tone="neutral">
                  {audit.incomparableCount} of these could not be compared because the figure was not
                  on the stub or NetShift does not estimate it. That is normal — most stubs do not
                  break out every line.
                </Callout>
              )}
            </Panel>
          </ProGate>

          <ProGate
            feature="anomaly_detection"
            preview={<Panel title="Historical anomaly detection"><p>&nbsp;</p></Panel>}
          >
            <Panel title="Anything unusual across your history">
              {!anomalies.sufficientHistory ? (
                <Callout tone="neutral">{anomalies.note}</Callout>
              ) : anomalies.findings.length === 0 ? (
                <Callout tone="success" icon="✓">
                  {anomalies.note}
                </Callout>
              ) : (
                <>
                  <Callout tone="info" icon="i">
                    {anomalies.note} NetShift compares each paycheck against the middle of your own
                    history, so one big shutdown cheque does not hide everything else.
                  </Callout>
                  <DataTable
                    caption="Unusual paychecks"
                    columns={[
                      {
                        key: 'date',
                        header: 'Pay date',
                        render: (finding) => formatIsoDate(finding.payDate),
                      },
                      { key: 'metric', header: 'Figure', render: (finding) => finding.metric.replace(/_/g, ' ') },
                      {
                        key: 'value',
                        header: 'This paycheck',
                        align: 'right',
                        render: (finding) =>
                          finding.metric === 'hours'
                            ? fmtHours(finding.value)
                            : finding.metric === 'deduction_rate'
                              ? `${finding.value.toFixed(1)}%`
                              : fmtMoney(finding.value),
                      },
                      {
                        key: 'median',
                        header: 'Your usual',
                        align: 'right',
                        render: (finding) =>
                          finding.metric === 'hours'
                            ? fmtHours(finding.median)
                            : finding.metric === 'deduction_rate'
                              ? `${finding.median.toFixed(1)}%`
                              : fmtMoney(finding.median),
                      },
                      {
                        key: 'note',
                        header: 'Note',
                        render: (finding) => <span className="ns-muted">{finding.message}</span>,
                      },
                    ]}
                    rows={anomalies.findings}
                    getKey={(finding) => `${finding.paycheckId}-${finding.metric}`}
                  />
                </>
              )}
            </Panel>
          </ProGate>

          <Panel title="What NetShift expected, and why">
            <DataTable
              caption="Expected paycheck breakdown"
              columns={[
                { key: 'item', header: 'Item', render: (row: [string, string]) => row[0] },
                { key: 'value', header: 'Value', align: 'right', render: (row: [string, string]) => row[1] },
              ]}
              rows={[
                ['Regular hours logged', fmtHours(expected.buckets.regular)] as [string, string],
                ['Overtime hours logged', fmtHours(expected.buckets.overtime)],
                ['Double-time hours logged', fmtHours(expected.buckets.doubleTime)],
                ['Base rate', fmtRate(expected.baseRate)],
                ['Effective rate with premiums', fmtRate(expected.effectiveRate)],
                ['Expected gross', fmtMoney(expected.gross)],
              ]}
              getKey={(row) => row[0]}
            />
            <Callout tone="neutral">
              Hours are bucketed one week at a time, which is how overtime actually works — a
              two-week period is two separate overtime weeks, not one long one.
            </Callout>
          </Panel>
        </>
      ) : null}

      {!isPro && (
        <Callout tone="neutral">
          The free plan compares gross pay and total hours. Pro adds the line-by-line reconciliation,
          anomaly detection across your history, and CSV export.
        </Callout>
      )}
    </>
  );
}

function AuditLines({ lines }: { lines: AuditLine[] }) {
  return (
    <div className="ns-audit__lines">
      {lines.map((line) => (
        <div
          key={line.kind}
          className={`ns-audit__line ns-audit__line--${line.insufficientData ? 'missing' : line.severity}`}
        >
          <div className="ns-audit__line-head">
            <span className="ns-audit__line-label">{line.label}</span>
            {line.insufficientData ? (
              <Badge tone="neutral">not compared</Badge>
            ) : line.severity === 'match' ? (
              <Badge tone="green">matches</Badge>
            ) : line.severity === 'minor' ? (
              <Badge tone="neutral">small difference</Badge>
            ) : (
              <Badge tone="amber">worth reviewing</Badge>
            )}
          </div>

          {!line.insufficientData && (
            <div className="ns-audit__line-figures">
              <span>
                Expected{' '}
                <strong className="tabular">
                  {line.unit === 'hours'
                    ? fmtHours(line.expected)
                    : line.unit === 'rate'
                      ? fmtRate(line.expected)
                      : fmtMoney(line.expected)}
                </strong>
              </span>
              <span>
                Stub{' '}
                <strong className="tabular">
                  {line.unit === 'hours'
                    ? fmtHours(line.actual)
                    : line.unit === 'rate'
                      ? fmtRate(line.actual)
                      : fmtMoney(line.actual)}
                </strong>
              </span>
              {line.difference !== null && Math.abs(line.difference) > 0.004 && (
                <span className="ns-audit__line-diff">
                  {line.unit === 'hours'
                    ? `${line.difference > 0 ? '+' : '−'}${fmtHours(Math.abs(line.difference))} hrs`
                    : fmtMoneySigned(line.difference)}
                </span>
              )}
            </div>
          )}

          <p className="ns-audit__line-message">{line.message}</p>
        </div>
      ))}
    </div>
  );
}
