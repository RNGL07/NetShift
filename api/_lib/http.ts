/**
 * HTTP helpers shared by every endpoint.
 *
 * The central rule here: an error that reaches the browser carries a stable
 * `code`, a sentence a user can act on, and nothing else. Stack traces,
 * provider messages, SQL errors, and environment variable names stay on the
 * server. `fail()` is the only way an endpoint reports a problem, so that rule
 * cannot be forgotten in one handler.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export type ErrorCode =
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
  | 'not_configured'
  | 'server_error';

const STATUS_FOR: Record<ErrorCode, number> = {
  method_not_allowed: 405,
  unauthorized: 401,
  forbidden: 403,
  pro_required: 402,
  allowance_exhausted: 429,
  invalid_request: 400,
  file_too_large: 413,
  unsupported_file_type: 415,
  rate_limited: 429,
  upstream_unavailable: 503,
  extraction_failed: 422,
  not_found: 404,
  conflict: 409,
  not_configured: 503,
  server_error: 500,
};

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** A sentence safe to show a user. */
    message: string;
    /** Extra machine-readable context, e.g. the allowance that ran out. */
    details?: Record<string, unknown>;
  };
}

/** Thrown inside a handler; turned into a response by `withErrorHandling`. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export function fail(
  res: VercelResponse,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  const body: ApiErrorBody = { error: { code, message } };
  if (details) body.error.details = details;
  res.status(STATUS_FOR[code]).json(body);
}

export function ok<T>(res: VercelResponse, body: T, status = 200): void {
  res.status(status).json(body);
}

export function methodGuard(
  req: VercelRequest,
  res: VercelResponse,
  allowed: readonly string[],
): boolean {
  if (!req.method || !allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    fail(res, 'method_not_allowed', `This endpoint accepts ${allowed.join(' or ')}.`);
    return false;
  }
  return true;
}

/**
 * Logs an internal problem without leaking it to the caller.
 *
 * Financial values and document contents must never reach the logs, so this
 * takes a message and a small context object that callers are expected to keep
 * free of user data — never an arbitrary request body.
 */
export function logServerError(
  scope: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      scope,
      message,
      ...context,
      at: new Date().toISOString(),
    }),
  );
}

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void> | void;

/**
 * Wraps a handler so an unexpected throw becomes a generic 500 rather than a
 * stack trace in the response body.
 */
export function withErrorHandling(scope: string, handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof ApiError) {
        fail(res, error.code, error.message, error.details);
        return;
      }

      // A missing environment variable is an operator problem, not a user
      // problem, and it needs to be distinguishable from a genuine crash.
      // Reported as a generic 500 it is effectively undiagnosable: the user
      // sees "something went wrong" and there is nothing to act on. The
      // variable's NAME still stays server-side — the log has it.
      if (error instanceof Error && error.name === 'ConfigurationError') {
        logServerError(`${scope}.misconfigured`, error, {
          variable: (error as { variable?: string }).variable ?? 'unknown',
        });
        fail(
          res,
          'not_configured',
          'NetShift is missing part of its server configuration, so this feature is unavailable. This has been logged — please report it.',
        );
        return;
      }

      logServerError(scope, error);
      if (!res.headersSent) {
        fail(res, 'server_error', 'Something went wrong on our side. Please try again.');
      }
    }
  };
}

/** Applies the no-store cache policy every authenticated endpoint needs. */
export function noStore(res: VercelResponse): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}
