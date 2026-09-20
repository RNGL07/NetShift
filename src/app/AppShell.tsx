/**
 * The authenticated shell: navigation, disclaimers, and the page frame.
 *
 * Navigation is a single list rendered two ways — a sidebar on a wide screen,
 * a slide-over drawer on a phone — rather than two separate menus that drift
 * apart. Each entry carries its tier badge, so what is free and what is Pro is
 * visible before anything is clicked.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import { FEATURES, type FeatureKey } from '@/config/plans';
import { Badge, Button } from '@/components/ui';
import { LegacyImportPrompt } from '@/features/legacy-import/LegacyImportPrompt';
import './app-shell.css';

interface NavItem {
  to: string;
  label: string;
  feature?: FeatureKey;
  group: 'Plan' | 'Track' | 'Build' | 'Account';
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', group: 'Plan' },
  { to: '/calculators', label: 'Calculators', feature: 'hours_to_pay', group: 'Plan' },
  { to: '/plan', label: 'Paycheck plan', feature: 'paycheck_forecast', group: 'Plan' },
  { to: '/shift-value', label: 'Is this shift worth it?', feature: 'shift_value_basic', group: 'Plan' },

  { to: '/hours', label: 'Hours', feature: 'hours_logging', group: 'Track' },
  { to: '/paychecks', label: 'Paychecks', group: 'Track' },
  { to: '/audit', label: 'Paycheck audit', feature: 'paycheck_audit_basic', group: 'Track' },
  { to: '/rotations', label: 'Rotation calendar', feature: 'rotation_automation', group: 'Track' },

  { to: '/goals', label: 'Goals', group: 'Build' },
  { to: '/buffer', label: 'Income buffer', feature: 'buffer_recommendations', group: 'Build' },
  { to: '/debt', label: 'Debt payoff', feature: 'debt_scenarios', group: 'Build' },
  { to: '/bonuses', label: 'Bonus planner', feature: 'bonus_planner', group: 'Build' },
  { to: '/investments', label: 'Investments', feature: 'investments', group: 'Build' },
  { to: '/market-reports', label: 'Market reports', feature: 'ai_market_reports', group: 'Build' },

  { to: '/pay-profile', label: 'Pay profile', feature: 'pay_profile', group: 'Account' },
  { to: '/billing', label: 'Plan & billing', group: 'Account' },
  { to: '/settings', label: 'Settings', group: 'Account' },
];

const GROUPS: NavItem['group'][] = ['Plan', 'Track', 'Build', 'Account'];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useEntitlement();

  return (
    <nav className="ns-nav" aria-label="Main">
      {GROUPS.map((group) => (
        <div key={group} className="ns-nav__group">
          <h2 className="ns-nav__group-title">{group}</h2>
          <ul>
            {NAV.filter((item) => item.group === group).map((item) => {
              const isPro = item.feature ? FEATURES[item.feature].tier === 'pro' : false;
              const locked = item.feature ? !can(item.feature) : false;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `ns-nav__link ${isActive ? 'ns-nav__link--active' : ''}`
                    }
                  >
                    <span>{item.label}</span>
                    {/* Locked Pro features stay listed and labelled, rather
                        than disappearing — hiding them hides the product. */}
                    {isPro && (
                      <Badge tone={locked ? 'neutral' : 'amber'} title="Part of NetShift Pro">
                        Pro
                      </Badge>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const { subscription } = useEntitlement();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on navigation, and move focus to the page heading so a
  // keyboard or screen-reader user lands on the new content rather than back
  // at the top of the menu.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    // Stops the page behind the drawer scrolling on a phone.
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  return (
    <div className="ns-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <header className="ns-topbar">
        <button
          type="button"
          className="ns-topbar__menu"
          onClick={() => setDrawerOpen((open) => !open)}
          aria-expanded={drawerOpen}
          aria-controls="ns-drawer"
        >
          <span className="sr-only">{drawerOpen ? 'Close menu' : 'Open menu'}</span>
          <span aria-hidden="true">{drawerOpen ? '✕' : '☰'}</span>
        </button>

        <div className="ns-topbar__brand">
          <span className="ns-topbar__title">
            Net<span>Shift</span>
          </span>
          {subscription.tier === 'pro' && <Badge tone="amber">Pro</Badge>}
        </div>

        <div className="ns-topbar__right">
          <span className="ns-topbar__email" title={user?.email ?? ''}>
            {user?.email}
          </span>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>

      <div className="ns-shell__body">
        <aside className="ns-sidebar">
          <NavList />
          <Disclaimer />
        </aside>

        {drawerOpen && (
          <>
            <div
              className="ns-drawer__scrim"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <div className="ns-drawer" id="ns-drawer" role="dialog" aria-label="Menu">
              <NavList onNavigate={() => setDrawerOpen(false)} />
              <Disclaimer />
            </div>
          </>
        )}

        <main className="ns-main" id="main" tabIndex={-1}>
          <LegacyImportPrompt />
          {children}
          <footer className="ns-footer">
            <Disclaimer inline />
          </footer>
        </main>
      </div>
    </div>
  );
}

/**
 * The independence and educational-use disclaimers.
 *
 * Both are product requirements, not boilerplate: NetShift must never imply
 * an employer relationship it does not have, and its figures are estimates.
 */
export function Disclaimer({ inline = false }: { inline?: boolean }) {
  return (
    <div className={inline ? 'ns-disclaimer ns-disclaimer--inline' : 'ns-disclaimer'}>
      <p>
        NetShift is an independent product. It is not affiliated with, endorsed by, or sponsored by
        Toyota or any other employer.
      </p>
      <p>
        Figures are estimates and educational tools — not tax, legal, investment, payroll, or
        financial advice. Always check against your own paperwork.
      </p>
    </div>
  );
}
