/**
 * Seven day-of-week hour inputs.
 *
 * Values are held as strings by the caller so a half-typed "1." survives a
 * re-render — coercing to a number on every keystroke makes decimal entry
 * fight the user, which is unusable on a phone.
 *
 * Days over the daily overtime threshold are marked as they are typed, so the
 * overtime rule is visible at the point of entry rather than only in the
 * result.
 */

import { useId } from 'react';
import { DAY_LABELS } from '@/lib/calc/hours';
import { num } from '@/lib/calc/money';
import './day-grid.css';

export function DayGrid({
  label,
  values,
  onChange,
  dailyThreshold,
  disabled = false,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  dailyThreshold: number | null;
  disabled?: boolean;
}) {
  const groupId = useId();
  const total = values.reduce((sum, value) => sum + num(value), 0);

  return (
    <fieldset className="ns-daygrid" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      <div className="ns-daygrid__head">
        <span className="ns-daygrid__label" aria-hidden="true">
          {label}
        </span>
        <span className="ns-daygrid__total tabular">
          {total.toFixed(2)} hrs
          {dailyThreshold !== null && total > dailyThreshold * 5 && ''}
        </span>
      </div>

      <div className="ns-daygrid__row">
        {DAY_LABELS.map((day, index) => {
          const value = values[index] ?? '';
          const hours = num(value);
          const isWeekend = day === 'Sat' || day === 'Sun';
          const isOver = dailyThreshold !== null && hours > dailyThreshold;
          const inputId = `${groupId}-${day}`;

          return (
            <div
              key={day}
              className={`ns-daygrid__day ${isWeekend ? 'ns-daygrid__day--weekend' : ''} ${
                isOver ? 'ns-daygrid__day--over' : ''
              }`}
            >
              <label htmlFor={inputId}>
                {day}
                {isOver && (
                  <span className="ns-daygrid__flag" title="Over the daily overtime threshold">
                    OT
                  </span>
                )}
              </label>
              <input
                id={inputId}
                type="number"
                min="0"
                max="24"
                step="0.25"
                inputMode="decimal"
                value={value}
                aria-label={`${label}, ${day} hours`}
                onChange={(event) => {
                  const next = [...values];
                  next[index] = event.target.value;
                  onChange(next);
                }}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          );
        })}
      </div>

      <div className="ns-daygrid__actions">
        <button type="button" onClick={() => onChange(['8', '8', '8', '8', '8', '0', '0'])}>
          5 × 8
        </button>
        <button type="button" onClick={() => onChange(['10', '10', '10', '10', '0', '0', '0'])}>
          4 × 10
        </button>
        <button type="button" onClick={() => onChange(['12', '12', '12', '0', '0', '0', '0'])}>
          3 × 12
        </button>
        <button type="button" onClick={() => onChange(['0', '0', '0', '0', '0', '0', '0'])}>
          Clear
        </button>
      </div>
    </fieldset>
  );
}
