/**
 * The two calculators NetShift started as: Hours → Pay and Target → Hours.
 *
 * Both are free-tier, both read the active pay profile, and both show their
 * working. The day grid is the input that matters: overtime depends on how
 * hours fall across days, so a single "total hours" box would quietly produce
 * the wrong answer for anyone working long days.
 */

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  Button,
  Callout,
  Grid,
  NumberField,
  Panel,
  SelectField,
  Stat,
  Tabs,
  TabPanel,
  Workings,
  WorkingsLine,
} from '@/components/ui';
import { usePayProfile } from '@/features/pay-profile/PayProfileContext';
import { DayGrid } from './DayGrid';
import { hoursToPay, targetToHours, type WeekInput } from '@/lib/calc/pay';
import { weeksInPeriod, type PayPeriodKind, type ShiftDesignation, type SundayTreatment } from '@/lib/calc/hours';
import { fmtHours, fmtMoney, fmtRate } from '@/lib/format';
import { num } from '@/lib/calc/money';
import { Link } from 'react-router-dom';

type CalculatorTab = 'hours' | 'target';

const DESIGNATIONS: { value: ShiftDesignation; label: string }[] = [
  { value: 'day', label: 'Day shift' },
  { value: 'evening', label: 'Evening / mids' },
  { value: 'night', label: 'Night shift' },
];

const SUNDAY_OPTIONS: { value: SundayTreatment; label: string }[] = [
  { value: 'regular', label: 'Regular time' },
  { value: 'ot', label: 'Overtime (1.5×)' },
  { value: 'double', label: 'Double time (2×)' },
];

export function CalculatorsPage() {
  const [tab, setTab] = useState<CalculatorTab>('hours');

  return (
    <>
      <PageHeader
        title="Calculators"
        feature="hours_to_pay"
        description="Turn hours into an estimated paycheck, or work backwards from what you need to take home. Both use your pay profile's rate, premiums, and overtime rules."
      />
      <Tabs
        label="Calculator"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'hours', label: 'Hours → Pay' },
          { id: 'target', label: 'Target → Hours' },
        ]}
      />
      <TabPanel id="hours" active={tab === 'hours'}>
        <HoursToPayCalculator />
      </TabPanel>
      <TabPanel id="target" active={tab === 'target'}>
        <TargetToHoursCalculator />
      </TabPanel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Hours → Pay
// ---------------------------------------------------------------------------

function HoursToPayCalculator() {
  const { effective, loading } = usePayProfile();

  const [rate, setRate] = useState('');
  const [period, setPeriod] = useState<PayPeriodKind>('biweekly');
  const [mode, setMode] = useState<'daily' | 'totals'>('daily');

  const [week1, setWeek1] = useState<string[]>(['8', '8', '8', '8', '8', '0', '0']);
  const [week2, setWeek2] = useState<string[]>(['8', '8', '8', '8', '8', '0', '0']);
  const [week1Sunday, setWeek1Sunday] = useState<SundayTreatment>('regular');
  const [week2Sunday, setWeek2Sunday] = useState<SundayTreatment>('regular');
  const [week1Shift, setWeek1Shift] = useState<ShiftDesignation>('day');
  const [week2Shift, setWeek2Shift] = useState<ShiftDesignation>('day');

  const [totalRegular, setTotalRegular] = useState('');
  const [totalOvertime, setTotalOvertime] = useState('');
  const [totalDouble, setTotalDouble] = useState('');
  const [totalsShift, setTotalsShift] = useState<ShiftDesignation>('day');

  const [deductionPct, setDeductionPct] = useState('');
  const [perDiemRate, setPerDiemRate] = useState('');
  const [perDiemDays, setPerDiemDays] = useState('');

  // The profile supplies the defaults; the fields override them for a one-off
  // calculation without editing the saved profile.
  const effectiveRate = rate === '' ? effective.baseRate : num(rate);
  const effectiveDeduction = deductionPct === '' ? effective.deductionPct : num(deductionPct);
  const effectivePerDiemRate = perDiemRate === '' ? effective.perDiemRate : num(perDiemRate);
  const effectivePerDiemDays = perDiemDays === '' ? effective.perDiemDaysPerWeek : num(perDiemDays);

  const result = useMemo(() => {
    const weeks: WeekInput[] = [
      { days: week1, sundayTreatment: week1Sunday, designation: week1Shift },
      { days: week2, sundayTreatment: week2Sunday, designation: week2Shift },
    ];
    return hoursToPay({
      baseRate: effectiveRate,
      payPeriod: period,
      premiums: effective.premiums,
      rules: effective.rules,
      deductionPct: effectiveDeduction,
      perDiemRate: effectivePerDiemRate,
      perDiemDaysPerWeek: effectivePerDiemDays,
      ...(mode === 'totals'
        ? {
            totals: {
              regularHours: num(totalRegular),
              overtimeHours: num(totalOvertime),
              doubleTimeHours: num(totalDouble),
              designation: totalsShift,
            },
          }
        : { weeks }),
    });
  }, [
    mode, week1, week2, week1Sunday, week2Sunday, week1Shift, week2Shift,
    totalRegular, totalOvertime, totalDouble, totalsShift,
    effectiveRate, period, effective.premiums, effective.rules,
    effectiveDeduction, effectivePerDiemRate, effectivePerDiemDays,
  ]);

  const hasRate = effectiveRate > 0;
  const showWeek2 = period === 'biweekly';

  if (loading) return <Panel><p>Loading your pay profile…</p></Panel>;

  return (
    <>
      {!hasRate && (
        <Callout tone="warning" icon="!">
          Add your hourly rate below, or save it once in your{' '}
          <Link to="/pay-profile">pay profile</Link> so every calculator uses it.
        </Callout>
      )}

      <Panel title="Your pay">
        <Grid min={200}>
          <NumberField
            label="Hourly rate"
            prefix="$"
            step="0.01"
            min="0"
            placeholder={effective.baseRate ? effective.baseRate.toFixed(2) : '0.00'}
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            hint={effective.baseRate > 0 && rate === '' ? 'From your pay profile' : undefined}
          />
          <SelectField
            label="Pay period"
            value={period}
            onChange={(event) => setPeriod(event.target.value as PayPeriodKind)}
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="semimonthly">Twice a month</option>
            <option value="monthly">Monthly</option>
          </SelectField>
          <NumberField
            label="Deductions"
            suffix="%"
            step="0.1"
            min="0"
            max="100"
            placeholder={effective.deductionPct.toFixed(1)}
            value={deductionPct}
            onChange={(event) => setDeductionPct(event.target.value)}
            hint="Share of gross withheld. NetShift learns this from your saved stubs."
          />
        </Grid>

        {effective.premiums.shiftPremium > 0 || effective.premiums.hasRolePremium ? (
          <Callout tone="neutral">
            Premiums from your pay profile are applied automatically:{' '}
            {effective.premiums.shiftPremium > 0 &&
              `${fmtMoney(effective.premiums.shiftPremium)}/hr shift differential`}
            {effective.premiums.shiftPremium > 0 && effective.premiums.hasRolePremium && ', '}
            {effective.premiums.hasRolePremium &&
              `${fmtMoney(effective.premiums.rolePremium)}/hr role premium`}
            .
          </Callout>
        ) : null}
      </Panel>

      <Panel
        title="Hours"
        description="Overtime depends on how hours fall across days, so enter them day by day where you can."
        actions={
          <Button
            variant="ghost"
            onClick={() => setMode(mode === 'daily' ? 'totals' : 'daily')}
          >
            {mode === 'daily' ? 'Enter totals instead' : 'Enter day by day'}
          </Button>
        }
      >
        {mode === 'daily' ? (
          <>
            <DayGrid
              label={showWeek2 ? 'Week 1' : 'Hours this week'}
              values={week1}
              onChange={setWeek1}
              dailyThreshold={effective.rules.dailyThreshold}
            />
            <Grid min={180}>
              <SelectField
                label="Week 1 Sunday pays"
                value={week1Sunday}
                onChange={(event) => setWeek1Sunday(event.target.value as SundayTreatment)}
              >
                {SUNDAY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </SelectField>
              <SelectField
                label="Week 1 shift"
                value={week1Shift}
                onChange={(event) => setWeek1Shift(event.target.value as ShiftDesignation)}
              >
                {DESIGNATIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </SelectField>
            </Grid>

            {showWeek2 && (
              <>
                <DayGrid
                  label="Week 2"
                  values={week2}
                  onChange={setWeek2}
                  dailyThreshold={effective.rules.dailyThreshold}
                />
                <Grid min={180}>
                  <SelectField
                    label="Week 2 Sunday pays"
                    value={week2Sunday}
                    onChange={(event) => setWeek2Sunday(event.target.value as SundayTreatment)}
                  >
                    {SUNDAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Week 2 shift"
                    value={week2Shift}
                    onChange={(event) => setWeek2Shift(event.target.value as ShiftDesignation)}
                  >
                    {DESIGNATIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </SelectField>
                </Grid>
                <Button variant="link" onClick={() => setWeek2([...week1])}>
                  Copy week 1 into week 2
                </Button>
              </>
            )}

            {(period === 'monthly' || period === 'semimonthly') && (
              <Callout tone="info">
                For a {period === 'monthly' ? 'monthly' : 'twice-monthly'} period, NetShift repeats
                the week you entered {weeksInPeriod(period).toFixed(2)} times. Overtime is still
                worked out per week, so the estimate is only as approximate as the number of weeks.
              </Callout>
            )}
          </>
        ) : (
          <>
            <Callout tone="warning" icon="!">
              Entered as totals, NetShift cannot apply the daily or weekly overtime rule — it uses
              exactly the split you type. Enter hours day by day for the rule to be applied.
            </Callout>
            <Grid min={160}>
              <NumberField
                label="Regular hours"
                step="0.25"
                min="0"
                value={totalRegular}
                onChange={(event) => setTotalRegular(event.target.value)}
              />
              <NumberField
                label="Overtime hours"
                step="0.25"
                min="0"
                value={totalOvertime}
                onChange={(event) => setTotalOvertime(event.target.value)}
              />
              <NumberField
                label="Double-time hours"
                step="0.25"
                min="0"
                value={totalDouble}
                onChange={(event) => setTotalDouble(event.target.value)}
              />
              <SelectField
                label="Shift"
                value={totalsShift}
                onChange={(event) => setTotalsShift(event.target.value as ShiftDesignation)}
              >
                {DESIGNATIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </SelectField>
            </Grid>
          </>
        )}
      </Panel>

      <Panel title="Per diem" description="Per diem is not taxed, so it is added after deductions.">
        <Grid min={180}>
          <NumberField
            label="Per diem rate"
            prefix="$"
            step="0.01"
            min="0"
            placeholder={effective.perDiemRate ? effective.perDiemRate.toFixed(2) : '0.00'}
            value={perDiemRate}
            onChange={(event) => setPerDiemRate(event.target.value)}
          />
          <NumberField
            label="Eligible days per week"
            step="0.5"
            min="0"
            max="7"
            placeholder={String(effective.perDiemDaysPerWeek || 0)}
            value={perDiemDays}
            onChange={(event) => setPerDiemDays(event.target.value)}
          />
        </Grid>
      </Panel>

      <Panel title="Estimated paycheck" tone={result.gross > 0 ? 'success' : 'default'}>
        {result.gross === 0 ? (
          <p className="ns-muted">Enter an hourly rate and some hours to see an estimate.</p>
        ) : (
          <>
            <Grid min={160}>
              <Stat label="Gross" value={fmtMoney(result.gross)} estimated size="medium" />
              <Stat
                label="Take-home"
                value={fmtMoney(result.estimatedTakeHome)}
                tone="positive"
                estimated
                size="large"
                sub={`Keeping about ${result.keepPct.toFixed(1)}% of gross${result.perDiemTotal > 0 ? `, plus ${fmtMoney(result.perDiemTotal)} per diem` : ''}`}
              />
              <Stat
                label="Total hours"
                value={fmtHours(result.totalHours)}
                sub={`${fmtHours(result.buckets.regular)} reg · ${fmtHours(result.buckets.overtime)} OT${result.buckets.doubleTime > 0 ? ` · ${fmtHours(result.buckets.doubleTime)} DT` : ''}`}
              />
            </Grid>

            <Workings summary="Show how this was worked out">
              {result.lines.map((line, index) => (
                <WorkingsLine
                  key={`${line.label}-${index}`}
                  label={`${fmtHours(line.hours)} hrs ${line.label} at ${fmtRate(line.rate)}${line.multiplier !== 1 ? ` × ${line.multiplier}` : ''}`}
                  amount={line.amount}
                  sign={1}
                  formatter={fmtMoney}
                />
              ))}
              <WorkingsLine
                label={`Estimated deductions at ${result.deductionPct.toFixed(1)}%`}
                amount={result.gross - result.estimatedTakeHomeBeforePerDiem}
                sign={-1}
                note="An estimate from your own paycheck history, not a tax calculation"
                formatter={fmtMoney}
              />
              {result.perDiemTotal > 0 && (
                <WorkingsLine
                  label="Per diem"
                  amount={result.perDiemTotal}
                  sign={1}
                  note="Not taxed, so it is added after deductions"
                  formatter={fmtMoney}
                />
              )}
              <p className="ns-workings__footnote">{result.note}</p>
            </Workings>
          </>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Target → Hours
// ---------------------------------------------------------------------------

function TargetToHoursCalculator() {
  const { effective } = usePayProfile();

  const [target, setTarget] = useState('');
  const [rate, setRate] = useState('');
  const [period, setPeriod] = useState<PayPeriodKind>('biweekly');
  const [deductionPct, setDeductionPct] = useState('');
  const [assumeOvertime, setAssumeOvertime] = useState(true);
  const [daysPerWeek, setDaysPerWeek] = useState('5');
  const [sundayDouble, setSundayDouble] = useState(false);
  const [designation, setDesignation] = useState<ShiftDesignation>('day');
  const [perDiemTotal, setPerDiemTotal] = useState('');

  const effectiveRate = rate === '' ? effective.baseRate : num(rate);
  const effectiveDeduction = deductionPct === '' ? effective.deductionPct : num(deductionPct);

  const result = useMemo(
    () =>
      targetToHours({
        targetTakeHome: num(target),
        baseRate: effectiveRate,
        payPeriod: period,
        deductionPct: effectiveDeduction,
        designation,
        premiums: effective.premiums,
        rules: effective.rules,
        assumeOvertime,
        daysPerWeek: num(daysPerWeek, 5),
        sundayDoubleTime: sundayDouble,
        perDiemTotal: num(perDiemTotal),
      }),
    [
      target, effectiveRate, period, effectiveDeduction, designation,
      effective.premiums, effective.rules, assumeOvertime, daysPerWeek,
      sundayDouble, perDiemTotal,
    ],
  );

  return (
    <>
      <Panel title="What do you need to take home?">
        <Grid min={200}>
          <NumberField
            label="Take-home target"
            prefix="$"
            step="1"
            min="0"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            hint="What you want to end up with, after deductions."
          />
          <NumberField
            label="Hourly rate"
            prefix="$"
            step="0.01"
            min="0"
            placeholder={effective.baseRate ? effective.baseRate.toFixed(2) : '0.00'}
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
          <SelectField
            label="Over what period"
            value={period}
            onChange={(event) => setPeriod(event.target.value as PayPeriodKind)}
          >
            <option value="weekly">One week</option>
            <option value="biweekly">Two weeks</option>
            <option value="semimonthly">Half a month</option>
            <option value="monthly">A month</option>
          </SelectField>
          <NumberField
            label="Deductions"
            suffix="%"
            step="0.1"
            min="0"
            max="100"
            placeholder={effective.deductionPct.toFixed(1)}
            value={deductionPct}
            onChange={(event) => setDeductionPct(event.target.value)}
          />
        </Grid>
      </Panel>

      <Panel title="How you would work it">
        <Grid min={180}>
          <SelectField
            label="Overtime"
            value={assumeOvertime ? 'yes' : 'no'}
            onChange={(event) => setAssumeOvertime(event.target.value === 'yes')}
          >
            <option value="yes">Paid overtime past the threshold</option>
            <option value="no">Straight time on every hour</option>
          </SelectField>
          <NumberField
            label="Days worked per week"
            step="1"
            min="1"
            max="7"
            value={daysPerWeek}
            onChange={(event) => setDaysPerWeek(event.target.value)}
          />
          <SelectField
            label="Shift"
            value={designation}
            onChange={(event) => setDesignation(event.target.value as ShiftDesignation)}
          >
            {DESIGNATIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </SelectField>
          <SelectField
            label="Sunday"
            value={sundayDouble ? 'double' : 'normal'}
            onChange={(event) => setSundayDouble(event.target.value === 'double')}
            hint={num(daysPerWeek, 5) < 7 ? 'Only applies on a 7-day week.' : undefined}
          >
            <option value="normal">Paid like any other day</option>
            <option value="double">Paid at double time</option>
          </SelectField>
          <NumberField
            label="Per diem expected"
            prefix="$"
            step="1"
            min="0"
            value={perDiemTotal}
            onChange={(event) => setPerDiemTotal(event.target.value)}
            hint="Untaxed, so it reduces the wages you need."
          />
        </Grid>
      </Panel>

      <Panel title="What it would take" tone={result.solvable ? 'success' : 'default'}>
        {!result.solvable ? (
          <p className="ns-muted">{result.note}</p>
        ) : (
          <>
            <Grid min={160}>
              <Stat
                label="Hours needed"
                value={fmtHours(result.hours)}
                tone="warning"
                size="large"
                estimated
              />
              <Stat label="Gross to earn" value={fmtMoney(result.grossNeeded)} estimated />
              {result.breakdown && (
                <Stat
                  label="Per day worked"
                  value={fmtHours(result.breakdown.hoursPerDay)}
                  sub={
                    result.breakdown.kind === 'grid'
                      ? `${result.breakdown.daysPerWeek} days a week for ${result.breakdown.weeks} week${result.breakdown.weeks > 1 ? 's' : ''}`
                      : `over ${result.breakdown.totalWorkDays} working days`
                  }
                />
              )}
            </Grid>

            {result.breakdown?.kind === 'grid' && (
              <StaticDayPreview
                hoursPerDay={result.breakdown.hoursPerDay}
                dayLabels={result.breakdown.dayLabels}
                weeks={result.breakdown.weeks}
                dailyThreshold={effective.rules.dailyThreshold}
              />
            )}

            <Workings summary="Show how this was worked out">
              <WorkingsLine
                label="Take-home you asked for"
                amount={num(target)}
                sign={1}
                formatter={fmtMoney}
              />
              {num(perDiemTotal) > 0 && (
                <WorkingsLine
                  label="Covered by untaxed per diem"
                  amount={num(perDiemTotal)}
                  sign={-1}
                  formatter={fmtMoney}
                />
              )}
              <WorkingsLine
                label={`Grossed up for ${effectiveDeduction.toFixed(1)}% deductions`}
                amount={result.grossNeeded - Math.max(0, num(target) - num(perDiemTotal))}
                sign={1}
                formatter={fmtMoney}
              />
              <div className="ns-workings__result">
                <span>Gross to earn</span>
                <span className="tabular">{fmtMoney(result.grossNeeded)}</span>
              </div>
              <p className="ns-workings__footnote">
                At {fmtRate(result.effectiveRate)}: {result.note}
              </p>
            </Workings>

            {result.hours > 84 * weeksInPeriod(period) && (
              <Callout tone="warning" icon="!">
                That is more hours than a normal schedule allows. Consider a longer period or a
                smaller target.
              </Callout>
            )}
          </>
        )}
      </Panel>
    </>
  );
}

function StaticDayPreview({
  hoursPerDay,
  dayLabels,
  weeks,
  dailyThreshold,
}: {
  hoursPerDay: number;
  dayLabels: string[];
  weeks: number;
  dailyThreshold: number | null;
}) {
  const over = dailyThreshold !== null && hoursPerDay > dailyThreshold;
  return (
    <div className="ns-daypreview">
      {Array.from({ length: weeks }, (_, week) => (
        <div key={week}>
          {weeks > 1 && <div className="ns-daypreview__label">Week {week + 1}</div>}
          <div className="ns-daypreview__row">
            {dayLabels.map((day) => (
              <div key={day} className={`ns-daypreview__day ${over ? 'ns-daypreview__day--over' : ''}`}>
                <span className="ns-daypreview__name">{day}</span>
                <span className="ns-daypreview__hours tabular">{hoursPerDay.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {over && (
        <p className="ns-daypreview__note">
          Each of those days is over your {dailyThreshold}-hour daily threshold, so part of every
          day is overtime.
        </p>
      )}
    </div>
  );
}
