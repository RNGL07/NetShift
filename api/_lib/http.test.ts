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

describe('error references', () => {
  /** Pulls the ref out of every JSON line the handler logged. */
  function loggedRefs(): string[] {
    const spy = console.error as unknown as { mock: { calls: unknown[][] } };
    return spy.mock.calls
      .map(([line]) => {
        try {
          return (JSON.parse(String(line)) as { ref?: string }).ref;
        } catch {
          return undefined;
        }
      })
      .filter((ref): ref is string => typeof ref === 'string');
  }

  it('gives a crash a reference that appears in both the response and the log', async () => {
    // The whole point: "something went wrong" with nothing to quote leaves the
    // real cause sitting in a log nobody can connect to the report.
    const handler = withErrorHandling('test', async () => {
      throw new Error('something internal broke');
    });
    const { res, captured } = createResponse();
    await handler(createRequest(), res);

    expect(captured.statusCode).toBe(500);
    expect(errorCode(captured)).toBe('server_error');

    const ref = (captured.body as { error: { details?: { ref?: string } } }).error.details?.ref;
    expect(ref).toMatch(/^[0-9a-f]{8}$/);
    // Shown to the user, so it can be read back without opening dev tools.
    expect(JSON.stringify(captured.body)).toContain(ref);
    // And written to the log, so the reference actually leads somewhere.
    expect(loggedRefs()).toContain(ref);
  });

  it('gives a configuration failure a reference too', async () => {
    const handler = withErrorHandling('test', async () => {
      requireEnv('DEFINITELY_NOT_SET_ANYWHERE');
    });
    const { res, captured } = createResponse();
    await handler(createRequest(), res);

    const ref = (captured.body as { error: { details?: { ref?: string } } }).error.details?.ref;
    expect(ref).toMatch(/^[0-9a-f]{8}$/);
    expect(loggedRefs()).toContain(ref);
  });

  it('still leaks nothing internal alongside the reference', async () => {
    const handler = withErrorHandling('test', async () => {
      throw new Error('connection to db-prod-7 refused: password authentication failed');
    });
    const { res, captured } = createResponse();
    await handler(createRequest(), res);

    const serialised = JSON.stringify(captured.body);
    expect(serialised).not.toContain('db-prod-7');
    expect(serialised).not.toContain('password');
  });

  it('gives each request its own reference', async () => {
    const handler = withErrorHandling('test', async () => {
      throw new Error('boom');
    });
    const refs: (string | undefined)[] = [];
    for (let i = 0; i < 2; i++) {
      const { res, captured } = createResponse();
      await handler(createRequest(), res);
      refs.push((captured.body as { error: { details?: { ref?: string } } }).error.details?.ref);
    }
    expect(refs[0]).not.toBe(refs[1]);
  });
});
