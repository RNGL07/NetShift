/**
 * The application root: providers, routing, and the authenticated shell.
 *
 * Routes are grouped by whether they need a session. The auth screens live
 * outside the shell so a signed-out user never briefly sees a navigation bar
 * for features they cannot reach.
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/features/auth/AuthContext';
import { EntitlementProvider } from '@/features/billing/EntitlementContext';
import { PayProfileProvider } from '@/features/pay-profile/PayProfileContext';
import { AppShell } from './AppShell';
import { AuthScreen } from '@/features/auth/AuthScreen';
import { ResetPasswordScreen } from '@/features/auth/ResetPasswordScreen';
import { SetupRequired } from './SetupRequired';
import { LoadingState } from '@/components/ui';

import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { CalculatorsPage } from '@/features/calculators/CalculatorsPage';
import { PayProfilePage } from '@/features/pay-profile/PayProfilePage';
import { HoursPage } from '@/features/hours/HoursPage';
import { PaychecksPage } from '@/features/paychecks/PaychecksPage';
import { PaycheckPlanPage } from '@/features/paycheck-plan/PaycheckPlanPage';
import { PaycheckAuditPage } from '@/features/paycheck-audit/PaycheckAuditPage';
import { ShiftValuePage } from '@/features/shift-value/ShiftValuePage';
import { GoalsPage } from '@/features/goals/GoalsPage';
import { BufferPage } from '@/features/buffer/BufferPage';
import { DebtPage } from '@/features/debt/DebtPage';
import { RotationsPage } from '@/features/rotations/RotationsPage';
import { BonusesPage } from '@/features/bonuses/BonusesPage';
import { InvestmentsPage } from '@/features/investments/InvestmentsPage';
import { MarketReportsPage } from '@/features/market-reports/MarketReportsPage';
import { BillingPage } from '@/features/billing/BillingPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { NotFoundPage } from './NotFoundPage';

function AuthedRoutes() {
  return (
    <PayProfileProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/calculators" element={<CalculatorsPage />} />
          <Route path="/pay-profile" element={<PayProfilePage />} />
          <Route path="/hours" element={<HoursPage />} />
          <Route path="/paychecks" element={<PaychecksPage />} />
          <Route path="/plan" element={<PaycheckPlanPage />} />
          <Route path="/audit" element={<PaycheckAuditPage />} />
          <Route path="/shift-value" element={<ShiftValuePage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/buffer" element={<BufferPage />} />
          <Route path="/debt" element={<DebtPage />} />
          <Route path="/rotations" element={<RotationsPage />} />
          <Route path="/bonuses" element={<BonusesPage />} />
          <Route path="/investments" element={<InvestmentsPage />} />
          <Route path="/market-reports" element={<MarketReportsPage />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Signed-in users landing on an auth route go to the dashboard. */}
          <Route path="/signin" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppShell>
    </PayProfileProvider>
  );
}

function Router() {
  const { user, loading, configured, isRecoveringPassword } = useAuth();

  if (!configured) return <SetupRequired />;
  if (loading) return <LoadingState label="Loading NetShift…" />;

  // A password-recovery session is technically signed in, but the only thing
  // that should happen next is setting a new password.
  if (isRecoveringPassword) {
    return (
      <Routes>
        <Route path="*" element={<ResetPasswordScreen />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordScreen />} />
        <Route path="*" element={<AuthScreen />} />
      </Routes>
    );
  }

  return <AuthedRoutes />;
}

export function App() {
  return (
    <AuthProvider>
      <EntitlementProvider>
        <Router />
      </EntitlementProvider>
    </AuthProvider>
  );
}
