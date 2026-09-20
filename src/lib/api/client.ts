/**
 * Typed wrapper around NetShift's own API routes.
 *
 * Every call attaches the caller's Supabase access token, and every error is
 * unwrapped into an `ApiClientError` carrying the server's stable code — so
 * the UI can react to `allowance_exhausted` or `pro_required` specifically
 * rather than string-matching a message.
 */

import { getAccessToken } from '../supabase/client';

export type ApiErrorCode =
  | 'method_not_allowed'
  | 'unauthorized'
  | 'forbidden'
  | 'pro_required'
  | 'allowance_exhausted'
  | 'invalid_request'
  | 'file_too_large'
  | 'unsupported_file_type'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'extraction_failed'
  | 'not_found'
  | 'conflict'
  | 'server_error'
  | 'network_error';

export class ApiClientError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** `true` when the fix is to upgrade, which the UI turns into an upgrade prompt. */
  get requiresPro(): boolean {
    return this.code === 'pro_required';
  }

  get isAllowanceExhausted(): boolean {
    return this.code === 'allowance_exhausted';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string>;
  /** Aborts the request; used to cancel in-flight uploads. */
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new ApiClientError('unauthorized', 'You need to be signed in to do that.', 401);
  }

  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError(
      'network_error',
      'Could not reach NetShift. Check your connection and try again.',
      0,
    );
  }

  if (!response.ok) {
    let code: ApiErrorCode = 'server_error';
    let message = 'Something went wrong. Please try again.';
    let details: Record<string, unknown> | undefined;

    try {
      const body = (await response.json()) as {
        error?: { code?: ApiErrorCode; message?: string; details?: Record<string, unknown> };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
      details = body.error?.details;
    } catch {
      // A non-JSON error body (a gateway page, say) keeps the generic message.
    }

    throw new ApiClientError(code, message, response.status, details);
  }

  return (await response.json()) as T;
}
