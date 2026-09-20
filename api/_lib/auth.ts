/**
 * Caller authentication.
 *
 * Every endpoint except the Stripe webhook begins with `requireUser`. The token
 * is verified against Supabase rather than merely decoded, so a forged or
 * expired JWT cannot get past this function — decoding a JWT tells you what it
 * claims, not whether it is true.
 */

import type { VercelRequest } from '@vercel/node';
import { ApiError } from './http';
import { serviceClient, userClient } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthedUser {
  id: string;
  email: string | null;
  accessToken: string;
  /** A Supabase client acting as this user, subject to RLS. */
  db: SupabaseClient;
}

function bearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization ?? req.headers.Authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

/**
 * Verifies the caller and returns their identity.
 *
 * Throws `unauthorized` rather than returning null, so an endpoint cannot
 * accidentally continue with an anonymous caller by forgetting a null check.
 */
export async function requireUser(req: VercelRequest): Promise<AuthedUser> {
  const token = bearerToken(req);
  if (!token) {
    throw new ApiError('unauthorized', 'You need to be signed in to do that.');
  }

  // getUser() with an explicit token asks Supabase to validate the signature
  // and expiry. This is the actual authentication step.
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data?.user) {
    throw new ApiError('unauthorized', 'Your session has expired. Sign in again.');
  }

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    accessToken: token,
    db: userClient(token),
  };
}
