/**
 * Feature 8 — Bonus and profit-sharing planner.
 *
 * Annual profit sharing is the biggest single cheque many manufacturing
 * workers see, it is withheld at supplemental rates, and it is usually spent
 * twice before it lands. The three-point estimate and the hard allocation cap
 * are both there to make that harder to do.
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
  Progress,
  SelectField,
  Stat,
  TextField,
} from '@/components/ui';
import { ProGate } from '@/components/ProGate';
import { useAuth } from '@/features/auth/AuthContext';
import { useCollection } from '@/hooks/useCollection';
import { deleteRow, insertRow, updateRow } from '@/services/crud';
import type { BonusAllocationRow, BonusRow, DebtRow, GoalRow } from '@/types/database';
import {
  ALLOCATION_TARGET_LABELS,
  BONUS_KIND_LABELS,
  planBonus,
  validateAllocations,
  type AllocationTarget,
  type BonusKind,
} from '@/lib/calc/bonus';
import { formatIsoDate } from '@/lib/calc/dates';
import { fmtMoney, fmtPct } from '@/lib/format';
import { num } from '@/lib/calc/money';
import './bonuses.css';

export function BonusesPage() {
  const { user } = useAuth();
  const { items: bonuses, loading, refresh } = useCollection<BonusRow>('bonuses', {
    orderBy: 'expected_date',
    ascending: false,
  });
  const { items: allocations, refresh: refreshAllocations } =
    useCollection<BonusAllocationRow>('bonus_allocations', { orderBy: 'sort_order', ascending: true });
  const { items: goals } = useCollection<GoalRow>('goals', { isNull: ['completed_at'] });
  const { items: debts } = useCollection<DebtRow>('debts', { isNull: ['paid_off_at'] });

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    kind: 'profit_sharing' as BonusKind,
    expectedDate: '',
    conservative: '',
    base: '',
    optimistic: '',
    withholding: '30',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addBonus() {
    if (!user) return;
    if (!draft.name.trim()) {
      setError('Give this bonus a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await insertRow('bonuses', user.id, {
        name: draft.name.trim(),
        kind: draft.kind,
        expected_date: draft.expectedDate || null,
        conservative_gross: num(draft.conservative),
        base_gross: num(draft.base),
        optimistic_gross: num(draft.optimistic),
        withholding_pct: num(draft.withholding, 30),
        allocate_against: 'conservative',
      });
      setDraft({ name: '', kind: 'profit_sharing', expectedDate: '', conservative: '', base: '', optimistic: '', withholding: '30' });
      setAdding(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that bonus.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading…" />;

  return (
    <>
      <PageHeader
        title="Bonus planner"
        feature="bonus_planner"
        description="Plan a bonus before it lands, allocate it without overcommitting, and compare what you expected to what actually arrived."
        actions={
          <Button variant={adding ? 'ghost' : 'primary'} onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add a bonus'}
          </Button>
        }
      />

      <ErrorMessage>{error}</ErrorMessage>

      <ProGate
        feature="bonus_planner"
        preview={<Panel title="Profit sharing"><p>&nbsp;</p></Panel>}
      >
        {adding && (
          <Panel title="New bonus">
            <Grid min={175}>
              <TextField
                label="Name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="2026 profit sharing"
              />
              <SelectField
                label="Type"
                value={draft.kind}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value as BonusKind })}
              >
                {(Object.keys(BONUS_KIND_LABELS) as BonusKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {BONUS_KIND_LABELS[kind]}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Expected date"
                type="date"
                value={draft.expectedDate}
                onChange={(event) => setDraft({ ...draft, expectedDate: event.target.value })}
              />
              <NumberField
                label="Conservative estimate"
                prefix="$"
                step="100"
                min="0"
                value={draft.conservative}
                onChange={(event) => setDraft({ ...draft, conservative: event.target.value })}
                hint="What you would be comfortable planning around."
              />
              <NumberField
                label="Base estimate"
                prefix="$"
                step="100"
                min="0"
                value={draft.base}
                onChange={(event) => setDraft({ ...draft, base: event.target.value })}
              />
              <NumberField
                label="Optimistic estimate"
                prefix="$"
                step="100"
                min="0"
                value={draft.optimistic}
                onChange={(event) => setDraft({ ...draft, optimistic: event.target.value })}
              />
              <NumberField
                label="Estimated withholding"
                suffix="%"
                step="1"
                min="0"
                max="100"
                value={draft.withholding}
                onChange={(event) => setDraft({ ...draft, withholding: event.target.value })}
                hint="Bonuses are usually withheld at a higher rate than regular pay."
              />
            </Grid>
            <Button variant="primary" loading={saving} onClick={() => void addBonus()}>
              Save bonus
            </Button>
          </Panel>
        )}

        {bonuses.length === 0 && !adding ? (
          <Panel>
            <EmptyState
              title="No bonuses tracked"
              icon="★"
              action={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Plan a bonus
                </Button>
              }
            >
              Profit sharing, an annual bonus, a retention payment — plan where it goes before it
              arrives, and NetShift will stop you allocating more than it nets.
            </EmptyState>
          </Panel>
        ) : (
          bonuses.map((bonus) => (
            <BonusCard
              key={bonus.id}
              bonus={bonus}
              allocations={allocations.filter((row) => row.bonus_id === bonus.id)}
              goals={goals}
              debts={debts}
              userId={user?.id ?? null}
              onChanged={async () => {
                await refresh();
                await refreshAllocations();
              }}
              onError={setError}
            />
          ))
        )}
      </ProGate>
    </>
  );
}

function BonusCard({
  bonus,
  allocations,
  goals,
  debts,
  userId,
  onChanged,
  onError,
}: {
  bonus: BonusRow;
  allocations: BonusAllocationRow[];
  goals: GoalRow[];
  debts: DebtRow[];
  userId: string | null;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [allocationDraft, setAllocationDraft] = useState({
    target: 'savings' as AllocationTarget,
    label: '',
    mode: 'percent' as 'percent' | 'amount',
    value: '',
    linkedId: '',
  });
  const [actualGross, setActualGross] = useState(bonus.actual_gross ? String(bonus.actual_gross) : '');
  const [actualNet, setActualNet] = useState(bonus.actual_net ? String(bonus.actual_net) : '');
  const [busy, setBusy] = useState(false);

  const plan = useMemo(
    () =>
      planBonus({
        name: bonus.name,
        kind: bonus.kind as BonusKind,
        expectedDate: bonus.expected_date,
        conservativeGross: bonus.conservative_gross,
        baseGross: bonus.base_gross,
        optimisticGross: bonus.optimistic_gross,
        withholdingPct: bonus.withholding_pct,
        allocateAgainst: bonus.allocate_against,
        actualGross: bonus.actual_gross,
        actualNet: bonus.actual_net,
        allocations: allocations.map((row) => ({
          id: row.id,
          target: row.target,
          label: row.label,
          percent: row.percent,
          amount: row.amount,
          linkedId: row.linked_goal_id ?? row.linked_debt_id,
        })),
      }),
    [bonus, allocations],
  );

  async function addAllocation() {
    if (!userId) return;
    const value = num(allocationDraft.value);
    if (value <= 0) {
      onError('Enter a percentage or an amount above zero.');
      return;
    }

    const candidate = [
      ...allocations.map((row) => ({
        id: row.id,
        target: row.target,
        label: row.label,
        percent: row.percent,
        amount: row.amount,
      })),
      {
        id: 'new',
        target: allocationDraft.target,
        label: allocationDraft.label || ALLOCATION_TARGET_LABELS[allocationDraft.target],
        percent: allocationDraft.mode === 'percent' ? value : null,
        amount: allocationDraft.mode === 'amount' ? value : null,
      },
    ];

    // Validate the whole set, not just the new row — the cap is on the total.
    const validation = validateAllocations(candidate, plan.allocatableNet);
    if (!validation.valid) {
      onError(validation.errors[0].message);
      return;
    }

    setBusy(true);
    onError(null);
    try {
      const [kind, id] = allocationDraft.linkedId ? allocationDraft.linkedId.split(':') : [null, null];
      await insertRow('bonus_allocations', userId, {
        bonus_id: bonus.id,
        target: allocationDraft.target,
        label: allocationDraft.label || ALLOCATION_TARGET_LABELS[allocationDraft.target],
        percent: allocationDraft.mode === 'percent' ? value : null,
        amount: allocationDraft.mode === 'amount' ? value : null,
        linked_goal_id: kind === 'goal' ? id : null,
        linked_debt_id: kind === 'debt' ? id : null,
        sort_order: allocations.length,
      });
      setAllocationDraft({ target: 'savings', label: '', mode: 'percent', value: '', linkedId: '' });
      await onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not save that allocation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={bonus.name}
      description={`${BONUS_KIND_LABELS[bonus.kind as BonusKind]}${bonus.expected_date ? ` · expected ${formatIsoDate(bonus.expected_date)}` : ''}`}
      tone={plan.overAllocated ? 'danger' : bonus.actual_gross ? 'success' : 'default'}
      actions={
        <ConfirmButton
          variant="link"
          onConfirm={async () => {
            if (!userId) return;
            await deleteRow('bonuses', bonus.id, userId);
            await onChanged();
          }}
        >
          Delete
        </ConfirmButton>
      }
    >
      <Grid min={160}>
        <Stat
          label="Conservative"
          value={fmtMoney(plan.scenarios.conservative.net)}
          sub={`${fmtMoney(plan.scenarios.conservative.gross)} gross`}
          estimated
        />
        <Stat
          label="Base"
          value={fmtMoney(plan.scenarios.base.net)}
          sub={`${fmtMoney(plan.scenarios.base.gross)} gross`}
          estimated
        />
        <Stat
          label="Optimistic"
          value={fmtMoney(plan.scenarios.optimistic.net)}
          sub={`${fmtMoney(plan.scenarios.optimistic.gross)} gross`}
          estimated
        />
        {plan.actual && (
          <Stat
            label="Actually received"
            value={fmtMoney(plan.actual.net)}
            sub={`${fmtMoney(plan.actual.gross)} gross`}
            tone="positive"
          />
        )}
      </Grid>

      <Callout tone="neutral">
        Allocations are measured against the <strong>{plan.allocatedAgainst.toLowerCase()}</strong>{' '}
        estimate — {fmtMoney(plan.allocatableNet)} after {fmtPct(bonus.withholding_pct, 0)}{' '}
        withholding. Planning against the lowest figure is what stops a smaller-than-hoped bonus
        turning into a shortfall.
        <div className="ns-bonus__against">
          {(['conservative', 'base', 'optimistic'] as const).map((option) => (
            <Button
              key={option}
              variant={bonus.allocate_against === option ? 'primary' : 'ghost'}
              onClick={async () => {
                if (!userId) return;
                await updateRow('bonuses', bonus.id, userId, { allocate_against: option });
                await onChanged();
              }}
            >
              {option}
            </Button>
          ))}
        </div>
      </Callout>

      {plan.warnings.map((warning) => (
        <Callout key={warning} tone="warning" icon="!">
          {warning}
        </Callout>
      ))}

      {plan.allocatableNet > 0 && (
        <Progress
          value={plan.totalAllocated}
          max={plan.allocatableNet}
          label="Allocated"
          tone={plan.overAllocated ? 'rust' : 'green'}
        />
      )}

      <DataTable
        caption="Allocations"
        columns={[
          {
            key: 'label',
            header: 'Toward',
            render: (row) => (
              <>
                {row.label} <Badge>{ALLOCATION_TARGET_LABELS[row.target]}</Badge>
                {row.trimmed && <Badge tone="rust">trimmed to fit</Badge>}
              </>
            ),
          },
          {
            key: 'amount',
            header: 'Amount',
            align: 'right',
            render: (row) => fmtMoney(row.amount),
          },
          {
            key: 'pct',
            header: 'Share',
            align: 'right',
            render: (row) => fmtPct(row.percentOfNet, 1),
          },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (row) => (
              <ConfirmButton
                variant="link"
                onConfirm={async () => {
                  if (!userId) return;
                  await deleteRow('bonus_allocations', row.id, userId);
                  await onChanged();
                }}
              >
                Remove
              </ConfirmButton>
            ),
          },
        ]}
        rows={plan.allocations}
        getKey={(row) => row.id}
        empty={<p className="ns-muted">Nothing allocated yet. Add where the money should go below.</p>}
      />

      {plan.unallocated > 0 && (
        <Callout tone="info" icon="i">
          {fmtMoney(plan.unallocated)} is still unallocated.
        </Callout>
      )}

      <div className="ns-bonus__add">
        <Grid min={150}>
          <SelectField
            label="Toward"
            value={allocationDraft.target}
            onChange={(event) =>
              setAllocationDraft({ ...allocationDraft, target: event.target.value as AllocationTarget })
            }
          >
            {(Object.keys(ALLOCATION_TARGET_LABELS) as AllocationTarget[]).map((target) => (
              <option key={target} value={target}>
                {ALLOCATION_TARGET_LABELS[target]}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Label"
            value={allocationDraft.label}
            onChange={(event) => setAllocationDraft({ ...allocationDraft, label: event.target.value })}
            placeholder={ALLOCATION_TARGET_LABELS[allocationDraft.target]}
          />
          <SelectField
            label="As"
            value={allocationDraft.mode}
            onChange={(event) =>
              setAllocationDraft({ ...allocationDraft, mode: event.target.value as 'percent' | 'amount' })
            }
          >
            <option value="percent">A percentage</option>
            <option value="amount">A fixed amount</option>
          </SelectField>
          <NumberField
            label={allocationDraft.mode === 'percent' ? 'Percentage' : 'Amount'}
            prefix={allocationDraft.mode === 'amount' ? '$' : undefined}
            suffix={allocationDraft.mode === 'percent' ? '%' : undefined}
            step={allocationDraft.mode === 'percent' ? '1' : '50'}
            min="0"
            max={allocationDraft.mode === 'percent' ? '100' : undefined}
            value={allocationDraft.value}
            onChange={(event) => setAllocationDraft({ ...allocationDraft, value: event.target.value })}
          />
          {(goals.length > 0 || debts.length > 0) && (
            <SelectField
              label="Link to"
              value={allocationDraft.linkedId}
              onChange={(event) =>
                setAllocationDraft({ ...allocationDraft, linkedId: event.target.value })
              }
            >
              <option value="">Nothing specific</option>
              {goals.map((goal) => (
                <option key={goal.id} value={`goal:${goal.id}`}>
                  Goal — {goal.name}
                </option>
              ))}
              {debts.map((debt) => (
                <option key={debt.id} value={`debt:${debt.id}`}>
                  Debt — {debt.name}
                </option>
              ))}
            </SelectField>
          )}
        </Grid>
        <Button variant="primary" loading={busy} onClick={() => void addAllocation()}>
          Add allocation
        </Button>
      </div>

      <details className="ns-workings">
        <summary>Record what actually arrived</summary>
        <div className="ns-workings__body">
          <Grid min={160}>
            <NumberField
              label="Actual gross"
              prefix="$"
              step="1"
              min="0"
              value={actualGross}
              onChange={(event) => setActualGross(event.target.value)}
            />
            <NumberField
              label="Actual net"
              prefix="$"
              step="1"
              min="0"
              value={actualNet}
              onChange={(event) => setActualNet(event.target.value)}
            />
          </Grid>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (!userId) return;
              if (num(actualNet) > num(actualGross)) {
                onError('The net cannot be more than the gross.');
                return;
              }
              setBusy(true);
              try {
                await updateRow('bonuses', bonus.id, userId, {
                  actual_gross: actualGross === '' ? null : num(actualGross),
                  actual_net: actualNet === '' ? null : num(actualNet),
                  received_on: actualGross === '' ? null : new Date().toISOString().slice(0, 10),
                });
                await onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            Save what arrived
          </Button>

          {plan.variance && (
            <Callout tone={(plan.variance.grossVsBase ?? 0) >= 0 ? 'success' : 'warning'}>
              {plan.variance.message}
            </Callout>
          )}
        </div>
      </details>
    </Panel>
  );
}
