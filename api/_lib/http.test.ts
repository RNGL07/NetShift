/**
 * Error reporting at the HTTP boundary.
 *
 * Two rules are tested here, both of which failed in production in ways that
 * were hard to diagnose:
 *
 *  - An error that reaches the browser carries a stable code and a sentence a
 *    user can act on — never a stack trace, a provider message, or the name of
 *    an environment variable.
 *  - A missing environment variable is distinguishable from a genuine crash.
 *    Reported as a generic 500 it is effectively undiagnosable: the user sees
 *    "something went wrong" and the operator has nothing to go on.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, withErrorHandling } from './http.js';
import { ConfigurationError, requireEnv } from './env.js';
import { createRequest, createResponse, errorCode } from '../_test/harness.js';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('withErrorHandling', () => {
  it('passes an ApiError through with its own code and message', async () => {
    const handler = withErrorHandling('test', async () => {
      throw new ApiError('pro_required', 'This feature is part of NetShift Pro.');
    });
    const { res, captured } = createResponse();
    await handler(createRequest(), res);

    expect(captured.statusCode).toBe(402);
    expect(errorCode(captured)).toBe('pro_required');
  });

  it('reports a missing environment variable as a distinct 503', async () => {
    const handler = withErrorHandling('test', async () => {
      requireEnv('DEFINITELY_NOT_SET_ANYWHERE');
    });
    const { res, captured } = createResponse();
    await handler(createRequest(), res);

    // Not an indistinguishable 500 — the operator can tell config from crash.
    expect(captured.statusCode).toBe(503);
    expect(errorCode(captured)).toBe('not_configured');
    expect(JSON.stringify(captured.body)).toMatch(/configuration/i);
  });

  it('never names the missing variable in the response', async () => {
    const handler = withErrorHandling('test', async () => {
      requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    });
    const { res, captured } = createResponse();
    await handler(createRequest(), res);

    expect(JSON.stringify(captured.body)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(JSON.stringify(captured.body)).not.toContain('service_role');
  });

  it('does log the variable name, so the operator can act on it', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line) => {
      logged.push(String(line));
    });

    const handler = withErrorHandling('test', async () => {
      requireEnv('SOME_MISSING_KEY');
    });
    const { res } = createResponse();
    await handler(createRequest(), res);

    expect(logged.join(' ')).toContain('SOME_MISSING_KEY');
    expect(logged.join(' ')).toContain('misconfigured');
  });

  it('turns an unexpected throw into a generic 500 with no internals', async () => {
    const handler = withErrorHandling('test', async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 while querying pay_stubs');
    });
    const { res, captured } = createResponse();
    await handler(createRequest(), res);

    expect(captured.statusCode).toBe(500);
    expect(errorCode(captured)).toBe('server_error');
    const body = JSON.stringify(captured.body);
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('10.0.0.5');
    expect(body).not.toContain('pay_stubs');
  });

  it('carries a ConfigurationError thrown directly, not only via requireEnv', async () => {
    const handler = withErrorHandling('test', async () => {
      throw new ConfigurationError('ANYTHING');
    });
    const { res, captured } = createResponse();
    await handler(createRequest(), res);

    expect(errorCode(captured)).toBe('not_configured');
  });
});
