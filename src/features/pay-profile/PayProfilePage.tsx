/**
 * The pay profile: rate, premiums, overtime rules, and the wage ladder.
 *
 * This is the page everything else depends on. A wrong rate here makes every
 * calculator, audit, and plan wrong in a way the user will not spot, so the
 * emphasis is on making the rules explicit and easy to check rather than on
 * hiding them behind defaults.
 */

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  Badge,
  Button,
  Callout,
  CheckboxField,
  ConfirmButton,
  DataTable,
  EmptyState,
  ErrorMessage,
  Grid,
  LoadingState,
  NumberField,
  Panel,
  SelectField,
  TextField,
} from '@/components/ui';
import { DocumentUpload } from '@/components/DocumentUpload';
import { usePayProfile } from './PayProfileContext';
import { parseWageSheetText, type ParsedWageSheet } from '@/lib/parsing/wageSheet';
import {
  EXAMPLE_WAGE_PROFILES,
  EXAMPLE_WAGE_DISCLAIMER,
  WAGE_SOURCE_DESCRIPTIONS,
  WAGE_SOURCE_LABELS,
} from '@/lib/data/exampleWageProfiles';
import { fmtMoney, fmtPct, fmtRate } from '@/lib/format';
import { num } from '@/lib/calc/money';
import type { ShiftDesignation, SundayTreatment } from '@/lib/calc/hours';
import type { PayPeriodKind } from '@/lib/calc/hours';
import type { WageStep } from '@/services/payProfile';

export function PayProfilePage() {
  const { effective, active, loading, error, save, saveLadder, chooseStep } = usePayProfile();

  const [draft, setDraft] = useState({
    name: '',
    baseRate: '',
    shiftPremium: '',
    rolePremium: '',
    hasRolePremium: false,
    designation: 'day' as ShiftDesignation,
    dailyThreshold: '',
    weeklyThreshold: '',
    overtimeMultiplier: '',
    doubleTimeMultiplier: '',
    sundayTreatment: 'regular' as SundayTreatment,
    perDiemRate: '',
    perDiemDays: '',
    payFrequency: 'biweekly' as PayPeriodKind,
    anchorPayday: '',
    deductionPct: '',
    marginalDeductionPct: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pendingSheet, setPendingSheet] = useState<ParsedWageSheet | null>(null);

  // Seed the form from the loaded profile once it arrives.
  useEffect(() => {
    if (loading) return;
    setDraft({
      name: effective.name,
      baseRate: effective.baseRate ? String(effective.baseRate) : '',
      shiftPremium: effective.premiums.shiftPremium ? String(effective.premiums.shiftPremium) : '',
      rolePremium: effective.premiums.rolePremium ? String(effective.premiums.rolePremium) : '',
      hasRolePremium: effective.premiums.hasRolePremium,
      designation: effective.defaultDesignation,
      dailyThreshold: effective.rules.dailyThreshold === null ? '' : String(effective.rules.dailyThreshold),
      weeklyThreshold: effective.rules.weeklyThreshold === null ? '' : String(effective.rules.weeklyThreshold),
      overtimeMultiplier: String(effective.rules.overtimeMultiplier),
      doubleTimeMultiplier: String(effective.rules.doubleTimeMultiplier),
      sundayTreatment: effective.rules.sundayTreatment,
      perDiemRate: effective.perDiemRate ? String(effective.perDiemRate) : '',
      perDiemDays: effective.perDiemDaysPerWeek ? String(effective.perDiemDaysPerWeek) : '',
      payFrequency: effective.payFrequency,
      anchorPayday: effective.anchorPayday ?? '',
      deductionPct: String(effective.deductionPct),
      marginalDeductionPct:
        effective.marginalDeductionPct === effective.deductionPct
          ? ''
          : String(effective.marginalDeductionPct),
    });
  }, [loading, effective]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await save({
        name: draft.name.trim() || 'My pay profile',
        baseRate: num(draft.baseRate),
        premiums: {
          shiftPremium: num(draft.shiftPremium),
          rolePremium: num(draft.rolePremium),
          hasRolePremium: draft.hasRolePremium,
        },
        defaultDesignation: draft.designation,
        rules: {
          dailyThreshold: draft.dailyThreshold === '' ? null : num(draft.dailyThreshold, 8),
          weeklyThreshold: draft.weeklyThreshold === '' ? null : num(draft.weeklyThreshold, 40),
          sundayTreatment: draft.sundayTreatment,
          overtimeMultiplier: num(draft.overtimeMultiplier, 1.5),
          doubleTimeMultiplier: num(draft.doubleTimeMultiplier, 2),
        },
        perDiemRate: num(draft.perDiemRate),
        perDiemDaysPerWeek: num(draft.perDiemDays),
        payFrequency: draft.payFrequency,
        anchorPayday: draft.anchorPayday || null,
        deductionPct: num(draft.deductionPct, 25),
        marginalDeductionPct:
          draft.marginalDeductionPct === '' ? null : num(draft.marginalDeductionPct),
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : 'Could not save your pay profile.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading your pay profile…" />;

  return (
    <>
      <PageHeader
        title="Pay profile"
        feature="pay_profile"
        description="Your rate, premiums, and overtime rules. Every calculator, audit, and plan in NetShift uses these, so it is worth getting them right once."
      />

      <ErrorMessage>{error ?? saveError}</ErrorMessage>
      {saved && <Callout tone="success" icon="✓">Pay profile saved.</Callout>}

      <Panel title="Rate and premiums">
        <Grid min={200}>
          <TextField
            label="Profile name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <NumberField
            label="Base hourly rate"
            prefix="$"
            step="0.01"
            min="0"
            value={draft.baseRate}
            onChange={(event) => setDraft({ ...draft, baseRate: event.target.value })}
            hint="Your straight-time rate, before any premium."
          />
          <NumberField
            label="Shift differential"
            prefix="$"
            suffix="/hr"
            step="0.01"
            min="0"
            value={draft.shiftPremium}
            onChange={(event) => setDraft({ ...draft, shiftPremium: event.target.value })}
            hint="Added per hour on evenings and nights."
          />
          <NumberField
            label="Team leader / role premium"
            prefix="$"
            suffix="/hr"
            step="0.01"
            min="0"
            value={draft.rolePremium}
            onChange={(event) => setDraft({ ...draft, rolePremium: event.target.value })}
          />
          <SelectField
            label="Usual shift"
            value={draft.designation}
            onChange={(event) =>
              setDraft({ ...draft, designation: event.target.value as ShiftDesignation })
            }
          >
            <option value="day">Day</option>
            <option value="evening">Evening / mids</option>
            <option value="night">Night</option>
          </SelectField>
        </Grid>

        <CheckboxField
          label="I currently receive the role premium"
          hint="Turn this off when you step out of the role; NetShift stops applying it."
          checked={draft.hasRolePremium}
          onChange={(event) => setDraft({ ...draft, hasRolePremium: event.target.checked })}
        />

        {num(draft.baseRate) > 0 && (
          <Callout tone="neutral">
            On {draft.designation === 'day' ? 'days' : draft.designation === 'night' ? 'nights' : 'mids'},
            your effective rate is{' '}
            <strong>
              {fmtRate(
                num(draft.baseRate) +
                  (draft.designation !== 'day' ? num(draft.shiftPremium) : 0) +
                  (draft.hasRolePremium ? num(draft.rolePremium) : 0),
              )}
            </strong>
            . Overtime is paid on that figure, not the base rate.
          </Callout>
        )}
      </Panel>

      <Panel
        title="Overtime rules"
        description="How your employer pays overtime. The defaults are the common ones; change them if your contract differs."
      >
        <Grid min={180}>
          <NumberField
            label="Daily overtime after"
            suffix="hrs"
            step="0.5"
            min="0"
            value={draft.dailyThreshold}
            onChange={(event) => setDraft({ ...draft, dailyThreshold: event.target.value })}
            hint="Leave blank if there is no daily rule."
          />
          <NumberField
            label="Weekly overtime after"
            suffix="hrs"
            step="1"
            min="0"
            value={draft.weeklyThreshold}
            onChange={(event) => setDraft({ ...draft, weeklyThreshold: event.target.value })}
            hint="Leave blank if there is no weekly rule."
          />
          <NumberField
            label="Overtime multiplier"
            suffix="×"
            step="0.1"
            min="1"
            value={draft.overtimeMultiplier}
            onChange={(event) => setDraft({ ...draft, overtimeMultiplier: event.target.value })}
          />
          <NumberField
            label="Double-time multiplier"
            suffix="×"
            step="0.1"
            min="1"
            value={draft.doubleTimeMultiplier}
            onChange={(event) => setDraft({ ...draft, doubleTimeMultiplier: event.target.value })}
          />
          <SelectField
            label="Sunday pays"
            value={draft.sundayTreatment}
            onChange={(event) =>
              setDraft({ ...draft, sundayTreatment: event.target.value as SundayTreatment })
            }
            hint="Sunday hours are held out of the weekly threshold and paid this way."
          >
            <option value="regular">Regular time</option>
            <option value="ot">Overtime</option>
            <option value="double">Double time</option>
          </SelectField>
        </Grid>

        <Callout tone="info" icon="i">
          An hour is never counted as both daily and weekly overtime. NetShift takes daily overtime
          out first, then applies the weekly threshold to what is left — which is how a five-day,
          ten-hour week comes out as 40 regular and 10 overtime, not 40 and 20.
        </Callout>
      </Panel>

      <Panel title="Pay period and deductions">
        <Grid min={190}>
          <SelectField
            label="Paid"
            value={draft.payFrequency}
            onChange={(event) =>
              setDraft({ ...draft, payFrequency: event.target.value as PayPeriodKind })
            }
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="semimonthly">Twice a month</option>
            <option value="monthly">Monthly</option>
          </SelectField>
          <TextField
            label="A recent payday"
            type="date"
            value={draft.anchorPayday}
            onChange={(event) => setDraft({ ...draft, anchorPayday: event.target.value })}
            hint="NetShift works out every other payday from this one."
          />
          <NumberField
            label="Average deductions"
            suffix="%"
            step="0.1"
            min="0"
            max="100"
            value={draft.deductionPct}
            onChange={(event) => setDraft({ ...draft, deductionPct: event.target.value })}
            hint="Share of gross that does not reach your account."
          />
          <NumberField
            label="Deductions on extra earnings"
            suffix="%"
            step="0.1"
            min="0"
            max="100"
            value={draft.marginalDeductionPct}
            onChange={(event) => setDraft({ ...draft, marginalDeductionPct: event.target.value })}
            hint="Overtime is often withheld at a higher rate. Leave blank to use the average."
          />
          <NumberField
            label="Per diem rate"
            prefix="$"
            step="0.01"
            min="0"
            value={draft.perDiemRate}
            onChange={(event) => setDraft({ ...draft, perDiemRate: event.target.value })}
          />
          <NumberField
            label="Per diem days per week"
            step="0.5"
            min="0"
            max="7"
            value={draft.perDiemDays}
            onChange={(event) => setDraft({ ...draft, perDiemDays: event.target.value })}
          />
        </Grid>

        <Callout tone="neutral">
          Deduction percentages are estimates, not tax calculations. NetShift updates them from your
          own saved pay stubs as you add them — that is more accurate than any formula it could
          apply.
        </Callout>
      </Panel>

      <div className="ns-profile__save">
        <Button variant="primary" loading={saving} onClick={() => void handleSave()}>
          Save pay profile
        </Button>
      </div>

      <WageLadderSection
        steps={effective.steps}
        baseRate={effective.baseRate}
        deductionPct={effective.deductionPct}
        ladderSource={effective.ladderSource}
        onChooseStep={chooseStep}
        onSaveLadder={saveLadder}
        hasProfile={Boolean(active)}
        pendingSheet={pendingSheet}
        setPendingSheet={setPendingSheet}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Wage ladder
// ---------------------------------------------------------------------------

function WageLadderSection({
  steps,
  baseRate,
  deductionPct,
  ladderSource,
  onChooseStep,
  onSaveLadder,
  pendingSheet,
  setPendingSheet,
}: {
  steps: WageStep[];
  baseRate: number;
  deductionPct: number;
  ladderSource: 'local' | 'ai' | 'manual' | null;
  onChooseStep: (stepId: string | null, rate: number, label: string | null) => Promise<void>;
  onSaveLadder: (
    steps: { label: string; hourlyRate: number; tenureMonths?: number | null }[],
    source: 'local' | 'ai' | 'manual',
  ) => Promise<void>;
  hasProfile: boolean;
  pendingSheet: ParsedWageSheet | null;
  setPendingSheet: (sheet: ParsedWageSheet | null) => void;
}) {
  const [manual, setManual] = useState<{ label: string; rate: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentIndex = steps.findIndex((step) => step.isCurrent);
  const current = currentIndex >= 0 ? steps[currentIndex] : null;
  const next = currentIndex >= 0 && currentIndex < steps.length - 1 ? steps[currentIndex + 1] : null;
  const raise = current && next ? next.hourlyRate - current.hourlyRate : null;

  async function applyLadder(
    rows: { label: string; hourlyRate: number; tenureMonths?: number | null }[],
    source: 'local' | 'ai' | 'manual',
  ) {
    setBusy(true);
    setError(null);
    try {
      await onSaveLadder(rows, source);
      setPendingSheet(null);
      setManual([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the wage ladder.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Panel
        title="Wage ladder"
        description="Where you are on your pay progression, and what the next step is worth."
        actions={
          ladderSource && (
            <Badge tone="neutral" title={
              ladderSource === 'local'
                ? 'Read from a PDF in your browser'
                : ladderSource === 'ai'
                  ? 'Transcribed by the AI service'
                  : 'Entered by hand'
            }>
              {ladderSource === 'local' ? 'parsed locally' : ladderSource === 'ai' ? 'AI-parsed' : 'entered by hand'}
            </Badge>
          )
        }
      >
        <ErrorMessage>{error}</ErrorMessage>

        {steps.length === 0 ? (
          <EmptyState title="No wage ladder yet" icon="↗">
            Upload your employer&rsquo;s wage sheet below, load an example to edit, or add the steps
            by hand.
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption="Your wage ladder"
              columns={[
                { key: 'label', header: 'Step', render: (step: WageStep) => step.label },
                {
                  key: 'rate',
                  header: 'Rate',
                  align: 'right',
                  render: (step: WageStep) => <span className="tabular">{fmtRate(step.hourlyRate)}</span>,
                },
                {
                  key: 'current',
                  header: 'Current',
                  align: 'right',
                  render: (step: WageStep) =>
                    step.isCurrent ? (
                      <Badge tone="green">You are here</Badge>
                    ) : (
                      <Button
                        variant="link"
                        onClick={() => void onChooseStep(step.id, step.hourlyRate, step.label)}
                      >
                        Set as current
                      </Button>
                    ),
                },
              ]}
              rows={steps}
              getKey={(step) => step.id}
            />

            {current && next && raise !== null && (
              <Callout tone="success" icon="↗">
                Your next step, <strong>{next.label}</strong>, is {fmtMoney(raise)}/hr more — about{' '}
                <strong>{fmtMoney(raise * 80 * (1 - deductionPct / 100))}</strong> more take-home per
                80-hour pay period, at your current deduction rate of {fmtPct(deductionPct)}.
              </Callout>
            )}
            {current && !next && (
              <Callout tone="neutral">You are at the top of this ladder.</Callout>
            )}
            {!current && (
              <Callout tone="warning" icon="!">
                Mark which step you are on so NetShift can show what the next one is worth.
              </Callout>
            )}
          </>
        )}

        {baseRate > 0 && current && Math.abs(current.hourlyRate - baseRate) > 0.01 && (
          <Callout tone="warning" icon="!">
            Your saved base rate ({fmtRate(baseRate)}) does not match the step you marked as current
            ({fmtRate(current.hourlyRate)}). Set the step again to bring them back in line.
          </Callout>
        )}
      </Panel>

      <Panel title="Load an example ladder">
        <Callout tone="warning" icon="!">
          {EXAMPLE_WAGE_DISCLAIMER}
        </Callout>
        <div className="ns-profile__examples">
          {EXAMPLE_WAGE_PROFILES.map((profile) => (
            <div key={profile.key} className="ns-profile__example">
              <div>
                <strong>{profile.employerName}</strong> — {profile.jobClassification}
                <div className="ns-profile__example-meta">
                  <Badge tone="neutral" title={WAGE_SOURCE_DESCRIPTIONS[profile.sourceStatus]}>
                    {WAGE_SOURCE_LABELS[profile.sourceStatus]}
                  </Badge>
                  <span>
                    {profile.steps.length} steps, {fmtRate(profile.steps[0].rate)} to{' '}
                    {fmtRate(profile.steps[profile.steps.length - 1].rate)}
                  </span>
                </div>
              </div>
              <Button
                loading={busy}
                onClick={() =>
                  void applyLadder(
                    profile.steps.map((step) => ({
                      label: step.label,
                      hourlyRate: step.rate,
                      tenureMonths: step.tenureMonths,
                    })),
                    'manual',
                  )
                }
              >
                Load and edit
              </Button>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Upload your wage sheet">
        <DocumentUpload
          kind="wage-sheet"
          label="Upload a wage sheet or offer letter"
          description="A company pay scale, grow-in sheet, or offer letter — NetShift reads the steps out of it."
          parseLocally={(text) => {
            const result = parseWageSheetText(text);
            return { data: result.data, confident: result.confidence.confident };
          }}
          onParsed={(outcome) => {
            const sheet = outcome.data as ParsedWageSheet;
            setPendingSheet(sheet);
          }}
        />

        {pendingSheet && (
          <Panel title="Check what was read" tone="warning">
            <p className="ns-muted">
              Nothing is saved until you confirm. Check every rate against the document.
            </p>
            {pendingSheet.trackLabel && (
              <p>
                <strong>{pendingSheet.trackLabel}</strong>
                {pendingSheet.effectiveDate && ` · effective ${pendingSheet.effectiveDate}`}
              </p>
            )}
            <DataTable
              columns={[
                { key: 'label', header: 'Step', render: (step: { label: string; rate: number }) => step.label },
                {
                  key: 'rate',
                  header: 'Rate',
                  align: 'right',
                  render: (step: { label: string; rate: number }) => fmtRate(step.rate),
                },
              ]}
              rows={pendingSheet.steps}
              getKey={(step) => `${step.label}-${step.rate}`}
              empty={<p className="ns-muted">No steps were found in that document.</p>}
            />
            <div className="ns-review__actions">
              <Button
                variant="primary"
                loading={busy}
                disabled={pendingSheet.steps.length === 0}
                onClick={() =>
                  void applyLadder(
                    pendingSheet.steps.map((step) => ({ label: step.label, hourlyRate: step.rate })),
                    'local',
                  )
                }
              >
                Save these {pendingSheet.steps.length} steps
              </Button>
              <Button variant="ghost" onClick={() => setPendingSheet(null)}>
                Discard
              </Button>
            </div>
          </Panel>
        )}
      </Panel>

      <Panel title="Build a ladder by hand">
        {manual.map((step, index) => (
          <Grid key={index} min={160}>
            <TextField
              label={`Step ${index + 1} label`}
              value={step.label}
              onChange={(event) => {
                const next = [...manual];
                next[index] = { ...step, label: event.target.value };
                setManual(next);
              }}
            />
            <NumberField
              label={`Step ${index + 1} rate`}
              prefix="$"
              step="0.01"
              min="0"
              value={step.rate}
              onChange={(event) => {
                const next = [...manual];
                next[index] = { ...step, rate: event.target.value };
                setManual(next);
              }}
            />
          </Grid>
        ))}
        <div className="ns-review__actions">
          <Button onClick={() => setManual([...manual, { label: `Step ${manual.length + 1}`, rate: '' }])}>
            Add a step
          </Button>
          {manual.length > 0 && (
            <>
              <Button
                variant="primary"
                loading={busy}
                onClick={() =>
                  void applyLadder(
                    manual
                      .filter((step) => num(step.rate) > 0)
                      .map((step) => ({ label: step.label || 'Step', hourlyRate: num(step.rate) })),
                    'manual',
                  )
                }
              >
                Replace my ladder with these
              </Button>
              <ConfirmButton variant="ghost" onConfirm={() => setManual([])}>
                Clear
              </ConfirmButton>
            </>
          )}
        </div>
      </Panel>
    </>
  );
}
