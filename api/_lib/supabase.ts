/**
 * Supabase clients for the server side.
 *
 * Two distinct clients, and the distinction matters:
 *
 *  - `serviceClient()` bypasses row-level security. It is the only thing that
 *    may write entitlements, AI usage counters, and the Stripe event log. It
 *    must never be handed a user-supplied filter without an explicit user_id
 *    predicate, because RLS is not there to catch a mistake.
 *
 *  - `userClient(token)` runs *as the caller*, with their access token
 *    attached, so RLS applies exactly as it does from the browser. Endpoints
 *    that only need to read the caller's own data use this, which means a
 *    missing `.eq('user_id', …)` is a bug that returns nothing rather than a
 *    bug that returns somebody else's pay stubs.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './env.js';

let cachedServiceClient: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (cachedServiceClient) return cachedServiceClient;
  cachedServiceClient = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': 'netshift-api' } },
    },
  );
  return cachedServiceClient;
}

/** A client that acts as the signed-in caller, subject to RLS. */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Client-Info': 'netshift-api-user',
      },
    },
  });
}
