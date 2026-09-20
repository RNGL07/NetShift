/**
 * Feature-gating behaviour in the UI.
 *
 * These assert the *presentation* rule from the brief: a locked feature shows
 * an informative preview rather than disappearing. They deliberately do not
 * assert anything about security — the server enforces that, and the endpoint
 * tests in api/_test cover it.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ProGate, TierBadge } from './ProGate';
import type { PlanTier } from '@/config/plans';

const mockTier = vi.hoisted(() => ({ current: 'free' as PlanTier }));

vi.mock('@/features/billing/EntitlementContext', () => ({
  useEntitlement: () => ({
    subscription: { tier: mockTier.current },
    isPro: mockTier.current === 'pro',
    can: (feature: string) => {
      // Mirrors the real tierAllows without importing the provider tree.
      const proOnly = [
        'debt_scenarios',
        'ai_market_reports',
        'ai_explanations',
        'paycheck_audit_full',
        'rotation_automation',
      ];
      return mockTier.current === 'pro' || !proOnly.includes(feature);
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
    waitForUpgrade: vi.fn(),
  }),
}));

function renderWithRouter(ui: ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ProGate for a free user', () => {
  it('renders free features normally', () => {
    mockTier.current = 'free';
    renderWithRouter(
      <ProGate feature="hours_to_pay">
        <p>The calculator</p>
      </ProGate>,
    );
    expect(screen.getByText('The calculator')).toBeInTheDocument();
  });

  it('hides a Pro feature behind an upgrade prompt rather than removing it', () => {
    mockTier.current = 'free';
    renderWithRouter(
      <ProGate feature="debt_scenarios">
        <p>Secret payoff plan</p>
      </ProGate>,
    );

    expect(screen.queryByText('Secret payoff plan')).not.toBeInTheDocument();
    // The feature is still named and described — a user can see what they
    // would be buying.
    expect(screen.getByText('Debt payoff scenarios')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /upgrade to pro/i })).toHaveAttribute(
      'href',
      '/billing',
    );
  });

  it('shows the preview when one is supplied, marked for assistive tech', () => {
    mockTier.current = 'free';
    const { container } = renderWithRouter(
      <ProGate feature="debt_scenarios" preview={<p>Blurred sample</p>}>
        <p>Real content</p>
      </ProGate>,
    );

    expect(screen.getByText('Blurred sample')).toBeInTheDocument();
    expect(screen.queryByText('Real content')).not.toBeInTheDocument();
    // The preview is decorative; a screen reader should skip it.
    expect(container.querySelector('.ns-gate__preview')).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses a one-line notice in compact mode', () => {
    mockTier.current = 'free';
    renderWithRouter(
      <ProGate feature="ai_market_reports" compact>
        <p>Reports</p>
      </ProGate>,
    );
    expect(screen.queryByText('Reports')).not.toBeInTheDocument();
    expect(screen.getByText(/part of netshift pro/i)).toBeInTheDocument();
  });
});

describe('ProGate for a Pro user', () => {
  it('renders Pro features with no prompt in the way', () => {
    mockTier.current = 'pro';
    renderWithRouter(
      <ProGate feature="debt_scenarios">
        <p>Real payoff plan</p>
      </ProGate>,
    );
    expect(screen.getByText('Real payoff plan')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /upgrade/i })).not.toBeInTheDocument();
  });
});

describe('TierBadge', () => {
  it('labels a free feature Free and a Pro feature Pro', () => {
    mockTier.current = 'free';
    const { rerender } = renderWithRouter(<TierBadge feature="hours_to_pay" />);
    expect(screen.getByText('Free')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <TierBadge feature="debt_scenarios" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Pro')).toBeInTheDocument();
  });
});
