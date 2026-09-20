/**
 * Loads a user-scoped collection with loading, error, and refresh state.
 *
 * Every feature page needs the same four states — loading, empty, error, and
 * data — and getting any of them wrong shows a user a blank panel that looks
 * broken. One hook means one implementation to get right.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { listRows, type ListOptions } from '@/services/crud';

export interface CollectionState<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Replaces local state without a round trip, for optimistic updates. */
  setItems: (items: T[]) => void;
}

export function useCollection<T>(
  table: string,
  options: ListOptions = {},
  enabled = true,
): CollectionState<T> {
  const { user } = useAuth();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  // Serialised so a fresh object literal in the caller does not re-trigger the
  // effect on every render.
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!user || !enabled) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await listRows<T>(table, user.id, JSON.parse(optionsKey) as ListOptions);
      if (mounted.current) {
        setItems(rows);
        setError(null);
      }
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : 'Could not load that.');
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user, table, optionsKey, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, loading, error, refresh, setItems };
}
