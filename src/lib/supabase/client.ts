/**
 * The browser's Supabase client.
 *
 * Uses the anon key, which is meant to be public: row-level security, not
 * key secrecy, is what stops one user reading another's data. The service-role
 * key is never imported here and has no `VITE_` prefix, so Vite cannot bundle
 * it even by mistake.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** `false` when the app has not been configured yet; the UI says so plainly. */
export const isSupabaseConfigured = Boolean(url && anonKey);

function createStub(): SupabaseClient {
  // A proxy that fails loudly on use, so an unconfigured deploy produces a
  // clear setup message rather than an obscure "undefined is not a function".
  const message =
    'NetShift is not connected to Supabase yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.';
  const handler: ProxyHandler<object> = {
    get() {
      throw new Error(message);
    },
  };
  return new Proxy({}, handler) as SupabaseClient;
}

export const supabase: SupabaseClient = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Needed for the password-reset and email-confirmation links, which
        // arrive as a URL fragment the client must consume on load.
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : createStub();

/** The current access token, for calls to NetShift's own API routes. */
export async function getAccessToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
