/**
 * The shared UI kit.
 *
 * Small, unopinionated pieces that every feature composes. Two rules run
 * through all of them:
 *
 *  - Every form control has a real `<label>` bound by id. Placeholder-as-label
 *    disappears the moment someone types and is invisible to a screen reader.
 *  - Nothing destructive happens on a single click. `ConfirmButton` exists so
 *    that rule is easy to follow rather than easy to forget.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import './ui.css';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Panel({
  title,
  description,
  children,
  actions,
  tone = 'default',
  as: Tag = 'section',
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <Tag className={`ns-panel ns-panel--${tone}`}>
      {(title || actions) && (
        <header className="ns-panel__head">
          <div>
            {title && <h3 className="ns-panel__title">{title}</h3>}
            {description && <p className="ns-panel__desc">{description}</p>}
          </div>
          {actions && <div className="ns-panel__actions">{actions}</div>}
        </header>
      )}
      {children}
    </Tag>
  );
}

export function Stack({
  children,
  gap = 4,
  direction = 'column',
  wrap = false,
  align,
  justify,
}: {
  children: ReactNode;
  gap?: 1 | 2 | 3 | 4 | 5 | 6;
  direction?: 'row' | 'column';
  wrap?: boolean;
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
}) {
  return (
    <div
      className="ns-stack"
      style={{
        flexDirection: direction,
        gap: `var(--space-${gap})`,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        alignItems: align,
        justifyContent:
          justify === 'between' ? 'space-between' : justify ? `flex-${justify}` : undefined,
      }}
    >
      {children}
    </div>
  );
}

export function Grid({ children, min = 220 }: { children: ReactNode; min?: number }) {
  return (
    <div
      className="ns-grid"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))` }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

export function Button({
  variant = 'secondary',
  loading = false,
  full = false,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  full?: boolean;
}) {
  return (
    <button
      type="button"
      className={`ns-btn ns-btn--${variant} ${full ? 'ns-btn--full' : ''} ${className}`}
      disabled={disabled || loading}
      // Announces the busy state rather than only showing a spinner.
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="ns-btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * A two-step button for anything irreversible.
 *
 * The first click arms it and the second confirms, with the armed state timing
 * out. A one-click delete on a phone, in a list, is a data-loss bug waiting to
 * happen.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Tap again to confirm',
  variant = 'danger',
  timeoutMs = 4000,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onConfirm: () => void;
  children: ReactNode;
  confirmLabel?: string;
  variant?: ButtonVariant;
  timeoutMs?: number;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Button
      variant={armed ? 'danger' : variant}
      onClick={() => {
        if (armed) {
          window.clearTimeout(timer.current);
          setArmed(false);
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = window.setTimeout(() => setArmed(false), timeoutMs);
      }}
      {...rest}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

interface FieldShell {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Renders the label for screen readers only, for dense grids. */
  hideLabel?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  required,
  hideLabel,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & FieldShell) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  return (
    <div className={`ns-field ${error ? 'ns-field--error' : ''}`}>
      <label htmlFor={fieldId} className={hideLabel ? 'sr-only' : undefined}>
        {label}
        {required && (
          <span className="ns-field__required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <input
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {hint && (
        <p className="ns-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="ns-field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A numeric field.
 *
 * `inputMode="decimal"` is what raises the numeric keypad on a phone — the
 * difference between entering hours in two taps and hunting for the number
 * row. Values are held as strings so a half-typed "1." is not destroyed
 * mid-entry by a premature `Number()`.
 */
export function NumberField({
  label,
  hint,
  error,
  required,
  hideLabel,
  id,
  prefix,
  suffix,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> &
  FieldShell & { prefix?: string; suffix?: string }) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  return (
    <div className={`ns-field ${error ? 'ns-field--error' : ''}`}>
      <label htmlFor={fieldId} className={hideLabel ? 'sr-only' : undefined}>
        {label}
        {required && (
          <span className="ns-field__required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <div className="ns-field__adorned">
        {prefix && (
          <span className="ns-field__prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          id={fieldId}
          type="number"
          inputMode="decimal"
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
          onFocus={(event) => event.currentTarget.select()}
          {...rest}
        />
        {suffix && (
          <span className="ns-field__suffix" aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>
      {hint && (
        <p className="ns-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="ns-field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  hideLabel,
  id,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & FieldShell) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;

  return (
    <div className={`ns-field ${error ? 'ns-field--error' : ''}`}>
      <label htmlFor={fieldId} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </label>
      <select
        id={fieldId}
        required={required}
        aria-describedby={hint ? hintId : undefined}
        {...rest}
      >
        {children}
      </select>
      {hint && (
        <p className="ns-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="ns-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  id,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldShell) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className={`ns-field ${error ? 'ns-field--error' : ''}`}>
      <label htmlFor={fieldId}>{label}</label>
      <textarea id={fieldId} rows={3} {...rest} />
      {hint && <p className="ns-field__hint">{hint}</p>}
      {error && (
        <p className="ns-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function CheckboxField({
  label,
  hint,
  id,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string; hint?: ReactNode }) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="ns-checkbox">
      <input id={fieldId} type="checkbox" {...rest} />
      <label htmlFor={fieldId}>
        {label}
        {hint && <span className="ns-checkbox__hint">{hint}</span>}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Callout({
  tone = 'info',
  title,
  children,
  icon,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  title?: ReactNode;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className={`ns-callout ns-callout--${tone}`}
      // Warnings and errors are announced; informational notes are not, so a
      // screen reader is not interrupted by every hint on the page.
      role={tone === 'danger' || tone === 'warning' ? 'alert' : undefined}
    >
      {icon && <span className="ns-callout__icon" aria-hidden="true">{icon}</span>}
      <div>
        {title && <strong className="ns-callout__title">{title}</strong>}
        <div className="ns-callout__body">{children}</div>
      </div>
    </div>
  );
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <Callout tone="danger" icon="!">
      {children}
    </Callout>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="ns-spinner" role="status">
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="ns-loading" role="status">
      <Spinner label={label} />
      <span>{label}</span>
    </div>
  );
}

/**
 * The empty state.
 *
 * Always says what the thing is and offers the action that fills it, rather
 * than leaving a blank panel that looks like a bug.
 */
export function EmptyState({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="ns-empty">
      {icon && <div className="ns-empty__icon" aria-hidden="true">{icon}</div>}
      <h4 className="ns-empty__title">{title}</h4>
      {children && <p className="ns-empty__body">{children}</p>}
      {action && <div className="ns-empty__action">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

/**
 * A headline figure.
 *
 * `estimated` is not decoration: NetShift's numbers are mostly estimates, and
 * the difference between an estimate and a confirmed figure is the single most
 * important thing for a user to be able to see at a glance.
 */
export function Stat({
  label,
  value,
  sub,
  tone = 'default',
  estimated = false,
  size = 'medium',
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'positive' | 'negative' | 'warning';
  estimated?: boolean;
  size?: 'small' | 'medium' | 'large';
}) {
  return (
    <div className={`ns-stat ns-stat--${size} ns-stat--${tone}`}>
      <div className="ns-stat__label">
        {label}
        {estimated && (
          <span className="ns-stat__badge" title="An estimate, not a confirmed figure">
            est.
          </span>
        )}
      </div>
      <div className="ns-stat__value tabular">{value}</div>
      {sub && <div className="ns-stat__sub">{sub}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'amber' | 'green' | 'rust' | 'blue';
  title?: string;
}) {
  return (
    <span className={`ns-badge ns-badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

export function DefinitionRow({
  term,
  value,
  sub,
}: {
  term: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="ns-defrow">
      <span className="ns-defrow__term">{term}</span>
      <span className="ns-defrow__value tabular">{value}</span>
      {sub && <span className="ns-defrow__sub">{sub}</span>}
    </div>
  );
}

/**
 * A collapsible "show the maths" block.
 *
 * Every calculated figure in NetShift can be opened up to see the arithmetic
 * behind it. This is the component that makes that cheap enough to do
 * everywhere, so no number is ever a magic number.
 */
export function Workings({
  summary = 'Show the maths',
  children,
  defaultOpen = false,
}: {
  summary?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="ns-workings" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="ns-workings__body">{children}</div>
    </details>
  );
}

export function WorkingsLine({
  label,
  amount,
  sign,
  note,
  formatter,
}: {
  label: ReactNode;
  amount: number;
  sign: 1 | -1;
  note?: ReactNode;
  formatter: (value: number) => string;
}) {
  return (
    <div className="ns-workings__line">
      <span className="ns-workings__op" aria-hidden="true">
        {sign > 0 ? '+' : '−'}
      </span>
      <span className="ns-workings__label">
        {label}
        {note && <span className="ns-workings__note">{note}</span>}
      </span>
      <span className="ns-workings__amount tabular">{formatter(amount)}</span>
    </div>
  );
}

export function Progress({
  value,
  max = 100,
  label,
  tone = 'amber',
}: {
  value: number;
  max?: number;
  label?: string;
  tone?: 'amber' | 'green' | 'rust';
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className={`ns-progress ns-progress--${tone}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="ns-progress__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * A table that becomes a stack of cards on a phone.
 *
 * A horizontally scrolling table is the usual mobile answer and it is a bad
 * one: figures scroll out of view of their own labels. Each cell carries its
 * header in a data attribute so CSS can re-render the row as labelled lines.
 */
export function DataTable<T>({
  columns,
  rows,
  getKey,
  empty,
  caption,
}: {
  columns: { key: string; header: ReactNode; align?: 'left' | 'right'; render: (row: T) => ReactNode }[];
  rows: T[];
  getKey: (row: T) => string;
  empty?: ReactNode;
  caption?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className="ns-table-wrap">
      <table className="ns-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={{ textAlign: column.align ?? 'left' }}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  data-label={typeof column.header === 'string' ? column.header : column.key}
                  style={{ textAlign: column.align ?? 'left' }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Divider({ label }: { label?: string }) {
  if (!label) return <hr className="ns-divider" />;
  return (
    <div className="ns-divider-labelled">
      <span>{label}</span>
    </div>
  );
}

/** A tab strip with proper roving focus and arrow-key navigation. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: { id: T; label: ReactNode; badge?: ReactNode }[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="ns-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          className={`ns-tab ${active === tab.id ? 'ns-tab--active' : ''}`}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = tabs[(index + delta + tabs.length) % tabs.length];
            onChange(next.id);
            document.getElementById(`tab-${next.id}`)?.focus();
          }}
        >
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}
