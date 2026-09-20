/**
 * A small typed CRUD helper over Supabase.
 *
 * Fourteen features each need list/create/update/delete against their own
 * table with the same `user_id` scoping and the same error handling. Writing
 * that fourteen times invites the one omission that matters — a missing
 * `.eq('user_id', …)` — so it is written once here.
 *
 * Row-level security is the real guarantee; this scoping is belt-and-braces
 * that also keeps queries cheap.
 */

import { supabase } from '@/lib/supabase/client';

export class DataError extends Error {
  /** The underlying Postgres error, for logging — never shown to a user. */
  readonly source: unknown;

  constructor(message: string, source?: unknown) {
    super(message);
    this.name = 'DataError';
    this.source = source;
  }
}

/** Turns a Postgres error into something a user can act on. */
function friendly(error: { code?: string; message?: string } | null, fallback: string): string {
  if (!error) return fallback;
  switch (error.code) {
    case '23505':
      return 'That already exists.';
    case '23503':
      return 'That refers to something which no longer exists. Refresh and try again.';
    case '23514':
      return 'Some of those values are outside the range NetShift accepts. Check the figures.';
    case '42501':
      return 'You do not have permission to do that.';
    case 'PGRST116':
      return 'That record could not be found.';
    default:
      return fallback;
  }
}

export interface ListOptions {
  orderBy?: string;
  ascending?: boolean;
  limit?: number;
  /** Extra equality filters, e.g. `{ pay_profile_id: id }`. */
  match?: Record<string, string | number | boolean | null>;
  /** Restricts to rows whose column is null, e.g. archived_at. */
  isNull?: string[];
}

export async function listRows<T>(
  table: string,
  userId: string,
  options: ListOptions = {},
): Promise<T[]> {
  let query = supabase.from(table).select('*').eq('user_id', userId);

  for (const [column, value] of Object.entries(options.match ?? {})) {
    query = value === null ? query.is(column, null) : query.eq(column, value);
  }
  for (const column of options.isNull ?? []) {
    query = query.is(column, null);
  }
  if (options.orderBy) {
    query = query.order(options.orderBy, { ascending: options.ascending ?? true });
  }
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error) throw new DataError(friendly(error, `Could not load ${table.replace(/_/g, ' ')}.`), error);
  return (data ?? []) as T[];
}

export async function getRow<T>(table: string, id: string, userId: string): Promise<T | null> {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new DataError(friendly(error, 'Could not load that record.'), error);
  return (data as T) ?? null;
}

export async function insertRow<T>(
  table: string,
  userId: string,
  values: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase
    .from(table)
    // user_id is set here rather than trusted from the caller, which is what
    // the RLS `with check` would reject anyway — this makes it impossible to
    // get wrong rather than merely rejected.
    .insert({ ...values, user_id: userId })
    .select('*')
    .single();
  if (error) throw new DataError(friendly(error, 'Could not save that.'), error);
  return data as T;
}

export async function insertRows<T>(
  table: string,
  userId: string,
  rows: Record<string, unknown>[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  const { data, error } = await supabase
    .from(table)
    .insert(rows.map((row) => ({ ...row, user_id: userId })))
    .select('*');
  if (error) throw new DataError(friendly(error, 'Could not save those.'), error);
  return (data ?? []) as T[];
}

export async function updateRow<T>(
  table: string,
  id: string,
  userId: string,
  values: Record<string, unknown>,
): Promise<T | null> {
  const { data, error } = await supabase
    .from(table)
    .update(values)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();
  if (error) throw new DataError(friendly(error, 'Could not save that change.'), error);
  return (data as T) ?? null;
}

export async function upsertRow<T>(
  table: string,
  values: Record<string, unknown>,
  onConflict: string,
): Promise<T> {
  const { data, error } = await supabase
    .from(table)
    .upsert(values, { onConflict })
    .select('*')
    .single();
  if (error) throw new DataError(friendly(error, 'Could not save that.'), error);
  return data as T;
}

export async function deleteRow(table: string, id: string, userId: string): Promise<void> {
  const { error } = await supabase.from(table).delete().eq('id', id).eq('user_id', userId);
  if (error) throw new DataError(friendly(error, 'Could not delete that.'), error);
}

export async function countRows(
  table: string,
  userId: string,
  options: ListOptions = {},
): Promise<number> {
  let query = supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
  for (const [column, value] of Object.entries(options.match ?? {})) {
    query = value === null ? query.is(column, null) : query.eq(column, value);
  }
  for (const column of options.isNull ?? []) {
    query = query.is(column, null);
  }
  const { count, error } = await query;
  if (error) throw new DataError(friendly(error, 'Could not count those records.'), error);
  return count ?? 0;
}
