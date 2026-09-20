/**
 * The browser's view of the user's plan.
 *
 * This decides what the UI *shows*. It does not decide what the user can *do*:
 * every Pro capability is enforced again on the server, and the data itself is
 * protected by row-level security. Treating this as a security boundary would
 * be a mistake — it is a presentation concern, and it is written down here so
 * nobody later assumes otherwise.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiRequest } from '@/lib/api/client';
import {
  FREE_ENTITLEMENT,
  tierAllows,
  type FeatureKey,
  type PlanTier,
  type SubscriptionStatus,
} from '@/config/plans';
import { useAuth } from '@/features/auth/AuthContext';

export interface SubscriptionSnapshot {
  tier: PlanTier;
  status: SubscriptionStatus;
  reason: string;
  inGracePeriod: boolean;
  cancelAtPeriodEnd: boolean;
  accessEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  priceId: string | null;
  hasBillingAccount: boolean;
  documentParses: {
    used: number;
    limit: number | null;
    remaining: number | null;
    month: string;
  };
}

const FREE_SNAPSHOT: SubscriptionSnapshot = {
  tier: 'free',
  status: 'none',
  reason: FREE_ENTITLEMENT.reason,
  inGracePeriod: false,
  cancelAtPeriodEnd: false,
  accessEndsAt: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialEnd: null,
  priceId: null,
  hasBillingAccount: false,
  documentParses: { used: 0, limit: null, remaining: null, month: '' },
};

interface EntitlementState {
  subscription: SubscriptionSnapshot;
  loading: boolean;
  error: string | null;
  isPro: boolean;
  can: (feature: FeatureKey) => boolean;
  refresh: () => Promise<SubscriptionSnapshot | null>;
  /**
   * Polls until the tier changes or the attempts run out. Used after returning
   * from Checkout, because the webhook may land a second or two after the
   * browser redirect — and the redirect itself is never proof of payment.
   */
  waitForUpgrade: (attempts?: number) => Promise<boolean>;
}

const EntitlementContext = createContext<EntitlementState | null>(null);

export function EntitlementProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [subscription, setSubscription] = useState<SubscriptionSnapshot>(FREE_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<SubscriptionSnapshot | null> => {
    if (!user) {
      setSubscription(FREE_SNAPSHOT);
      setLoading(false);
      return null;
    }
    try {
      const snapshot = await apiRequest<SubscriptionSnapshot>('/api/stripe/subscription', {
        method: 'GET',
      });
      if (mounted.current) {
        setSubscription(snapshot);
        setError(null);
      }
      return snapshot;
    } catch (caught) {
      // Billing being unreachable must not lock a user out of the free
      // features they can always use, so this degrades to the free tier
      // rather than showing an error page.
      if (mounted.current) {
        setSubscription(FREE_SNAPSHOT);
        setError(caught instanceof Error ? caught.message : 'Could not load your plan.');
      }
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    void refresh();
  }, [authLoading, refresh]);

  const waitForUpgrade = useCallback(
    async (attempts = 8): Promise<boolean> => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const snapshot = await refresh();
        if (snapshot?.tier === 'pro') return true;
        // Back off gently: most webhooks arrive within a couple of seconds.
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
      }
      const final = await refresh();
      return final?.tier === 'pro';
    },
    [refresh],
  );

  const can = useCallback(
    (feature: FeatureKey) => tierAllows(subscription.tier, feature),
    [subscription.tier],
  );

  const value = useMemo<EntitlementState>(
    () => ({
      subscription,
      loading,
      error,
      isPro: subscription.tier === 'pro',
      can,
      refresh,
      waitForUpgrade,
    }),
    [subscription, loading, error, can, refresh, waitForUpgrade],
  );

  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>;
}

export function useEntitlement(): EntitlementState {
  const context = useContext(EntitlementContext);
  if (!context) throw new Error('useEntitlement must be used inside an EntitlementProvider');
  return context;
}
