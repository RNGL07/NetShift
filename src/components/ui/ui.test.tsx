/**
 * UI kit behaviour that the rest of the app relies on.
 *
 * Accessibility here is not decoration: NetShift is used one-handed on a plant
 * floor and by people using screen readers, and a field with no bound label or
 * a one-click delete is a real defect.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  CheckboxField,
  ConfirmButton,
  DataTable,
  NumberField,
  Progress,
  Stat,
  TextField,
  Workings,
} from './index';

describe('form fields are properly labelled', () => {
  it('binds a text field label to its input', () => {
    render(<TextField label="Employer" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Employer');
    expect(input).toBeInTheDocument();
  });

  it('binds a number field label and raises the numeric keypad', () => {
    render(<NumberField label="Hourly rate" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Hourly rate');
    expect(input).toHaveAttribute('type', 'number');
    // Without inputMode, a phone shows the full keyboard for a rate entry.
    expect(input).toHaveAttribute('inputMode', 'decimal');
  });

  it('associates a hint with the field for assistive tech', () => {
    render(<TextField label="Payday" hint="A recent one" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Payday');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('A recent one');
  });

  it('marks an invalid field and announces the error', () => {
    render(<TextField label="Rate" error="That is not a number" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Rate')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('That is not a number');
  });

  it('keeps a hidden label available to screen readers', () => {
    render(<NumberField label="Monday hours" hideLabel value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Monday hours')).toBeInTheDocument();
  });

  it('binds a checkbox to its label so the text is clickable', async () => {
    const onChange = vi.fn();
    render(<CheckboxField label="I am a team leader" checked={false} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText(/team leader/i));
    expect(onChange).toHaveBeenCalled();
  });
});

describe('ConfirmButton', () => {
  it('does not act on the first click', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton onConfirm={onConfirm}>Delete</ConfirmButton>);

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /tap again to confirm/i })).toBeInTheDocument();
  });

  it('acts on the second click', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton onConfirm={onConfirm}>Delete</ConfirmButton>);

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: /tap again to confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('disarms itself after the timeout, so a stale arm cannot fire later', async () => {
    // fireEvent rather than userEvent: userEvent's own async scheduling does
    // not compose with fake timers here and hangs the test.
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} timeoutMs={40}>
        Delete
      </ConfirmButton>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: /tap again/i })).toBeInTheDocument();

    // Once the window lapses the button returns to its unarmed label, so a
    // second click much later starts over rather than deleting.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('Button', () => {
  it('announces and enforces a busy state', () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole('button', { name: /save/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});

describe('Stat', () => {
  it('marks an estimate as an estimate', () => {
    render(<Stat label="Take-home" value="$1,200.00" estimated />);
    expect(screen.getByText('est.')).toBeInTheDocument();
  });

  it('shows no estimate badge on a confirmed figure', () => {
    render(<Stat label="Take-home" value="$1,200.00" />);
    expect(screen.queryByText('est.')).not.toBeInTheDocument();
  });
});

describe('Progress', () => {
  it('exposes its value to assistive technology', () => {
    render(<Progress value={30} max={120} label="Goal progress" />);
    const bar = screen.getByRole('progressbar', { name: 'Goal progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
  });

  it('clamps out-of-range values rather than overflowing', () => {
    render(<Progress value={500} max={100} label="Over" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('DataTable', () => {
  const columns = [{ key: 'name', header: 'Name', render: (row: { name: string }) => row.name }];

  it('renders rows with a caption for screen readers', () => {
    render(
      <DataTable
        caption="Saved paychecks"
        columns={columns}
        rows={[{ name: 'March' }]}
        getKey={(row) => row.name}
      />,
    );
    expect(screen.getByRole('table', { name: 'Saved paychecks' })).toBeInTheDocument();
    expect(screen.getByText('March')).toBeInTheDocument();
  });

  it('carries the column header on each cell so a phone can label it', () => {
    const { container } = render(
      <DataTable columns={columns} rows={[{ name: 'March' }]} getKey={(row) => row.name} />,
    );
    // The mobile card layout renders this attribute as the visible label.
    expect(container.querySelector('td')).toHaveAttribute('data-label', 'Name');
  });

  it('shows the empty state instead of an empty table', () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        getKey={(row) => row.name}
        empty={<p>Nothing saved yet</p>}
      />,
    );
    expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('Workings', () => {
  it('keeps the maths available but collapsed by default', () => {
    render(
      <Workings>
        <p>8 hrs at $40.00</p>
      </Workings>,
    );
    // The content is in the DOM (so it is findable and printable) but the
    // details element is closed.
    expect(screen.getByText('8 hrs at $40.00')).toBeInTheDocument();
    expect(screen.getByRole('group')).not.toHaveAttribute('open');
  });

  it('can be opened by default where the maths is the point', () => {
    render(
      <Workings defaultOpen>
        <p>The sum</p>
      </Workings>,
    );
    expect(screen.getByRole('group')).toHaveAttribute('open');
  });
});
