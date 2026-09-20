/**
 * The active pay profile, shared across every feature.
 *
 * Almost every calculation needs the user's rate, premiums, and overtime
 * rules. Loading them once here avoids each page re-fetching the same rows,
 * and — more importantly — guarantees that the Hours→Pay calculator, the
 * audit, and the shift evaluator all price the same hour identically.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import {
  DEFAULT_PAY_PROFILE,
  createPayProfile,
  listPayProfiles,
  replaceLadder,
  setCurrentStep,
  updatePayProfile,
  type PayProfile,
  type PayProfilePatch,
} from '@/services/payProfile';

interface PayProfileState {
  profiles: PayProfile[];
  active: PayProfile | null;
  /** A usable profile even before one is saved, so forms are never empty. */
  effective: Omit<PayProfile, 'id'> & { id: string | null };
  loading: boolean;
  error: string | null;
  setActiveId: (id: string) => void;
  refresh: () => Promise<void>;
  save: (patch: PayProfilePatch) => Promise<void>;
  create: (patch?: PayProfilePatch) => Promise<PayProfile>;
  saveLadder: (
    steps: { label: string; hourlyRate: number; tenureMonths?: number | null }[],
    source: 'local' | 'ai' | 'manual',
  ) => Promise<void>;
  chooseStep: (stepId: string | null, rate: number, label: string | null) => Promise<void>;
}

const PayProfileContext = createContext<PayProfileState | null>(null);

export function PayProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [profiles, setProfiles] = useState<PayProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setProfiles([]);
      setLoading(false);
      return;
    }
    try {
      const list = await listPayProfiles(user.id);
      setProfiles(list);
      setError(null);
      setActiveId((current) => {
        if (current && list.some((p) => p.id === current)) return current;
        return list.find((p) => p.isActive)?.id ?? list[0]?.id ?? null;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your pay profile.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = useMemo(
    () => profiles.find((profile) => profile.id === activeId) ?? profiles[0] ?? null,
    [profiles, activeId],
  );

  const effective = useMemo(
    () => (active ? active : { ...DEFAULT_PAY_PROFILE, id: null }),
    [active],
  );

  const save = useCallback(
    async (patch: PayProfilePatch) => {
      if (!user) return;
      // A user who edits their rate before ever creating a profile gets one
      // created implicitly, rather than an error about a missing record.
      if (!active) {
        const created = await createPayProfile(user.id, patch);
        await updatePayProfile(created.id, patch);
        setActiveId(created.id);
        await refresh();
        return;
      }
      await updatePayProfile(active.id, patch);
      await refresh();
    },
    [user, active, refresh],
  );

  const create = useCallback(
    async (patch: PayProfilePatch = {}) => {
      if (!user) throw new Error('Not signed in');
      const created = await createPayProfile(user.id, patch);
      setActiveId(created.id);
      await refresh();
      return created;
    },
    [user, refresh],
  );

  const saveLadder = useCallback(
    async (
      steps: { label: string; hourlyRate: number; tenureMonths?: number | null }[],
      source: 'local' | 'ai' | 'manual',
    ) => {
      if (!user) return;
      let profileId = active?.id;
      if (!profileId) {
        const created = await createPayProfile(user.id);
        profileId = created.id;
        setActiveId(created.id);
      }
      await replaceLadder(user.id, profileId, steps);
      await updatePayProfile(profileId, { ladderSource: source });
      await refresh();
    },
    [user, active, refresh],
  );

  const chooseStep = useCallback(
    async (stepId: string | null, rate: number, label: string | null) => {
      if (!active) return;
      await setCurrentStep(active.id, stepId);
      // Selecting a step also sets the base rate: keeping them separate is how
      // a user ends up with a ladder that disagrees with their own pay.
      await updatePayProfile(active.id, { baseRate: rate, currentStepLabel: label });
      await refresh();
    },
    [active, refresh],
  );

  const value = useMemo<PayProfileState>(
    () => ({
      profiles,
      active,
      effective,
      loading,
      error,
      setActiveId,
      refresh,
      save,
      create,
      saveLadder,
      chooseStep,
    }),
    [profiles, active, effective, loading, error, refresh, save, create, saveLadder, chooseStep],
  );

  return <PayProfileContext.Provider value={value}>{children}</PayProfileContext.Provider>;
}

export function usePayProfile(): PayProfileState {
  const context = useContext(PayProfileContext);
  if (!context) throw new Error('usePayProfile must be used inside a PayProfileProvider');
  return context;
}
