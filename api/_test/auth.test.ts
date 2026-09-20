/**
 * Authentication and authorization enforcement at the endpoint boundary.
 *
 * These run the real handlers with Supabase stubbed, so the guard clauses
 * under test are the ones that actually ship — not a re-implementation of
 * them in the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequest, createResponse, errorCode, stubEnv } from './harness.js';

const getUser = vi.fn();
const subscriptionRow = vi.fn();
const rpc = vi.fn();
const tableRows = vi.fn();

// One shared stub for every Supabase call the handlers make.
vi.mock('../_lib/supabase', () => {
  const builder = () => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete']) {
      chain[method] = () => chain;
    }
    chain.insert = () => chain;
    chain.upsert = () => chain;
    chain.maybeSingle = async () => tableRows();
    chain.single = async () => tableRows();
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(tableRows()).then(resolve);
    return chain;
  };
  const client = {
    from: () => builder(),
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getUser: (...args: unknown[]) => getUser(...args) },
  };
  return { serviceClient: () => client, userClient: () => client };
});

// Never reached in these tests, but imported by the handlers under test.
vi.mock('../_lib/anthropic', () => ({
  callAnthropic: vi.fn(async () => ({
    text: '{}',
    inputTokens: 1,
    outputTokens: 1,
    stopReason: 'end_turn',
  })),
  parseJsonResponse: (text: string) => JSON.parse(text),
}));

const FREE_USER = { id: '11111111-1111-1111-1111-111111111111', email: 'free@example.test' };

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = stubEnv();
  getUser.mockReset();
  subscriptionRow.mockReset();
  rpc.mockReset();
  tableRows.mockReset();
  tableRows.mockReturnValue({ data: null, error: null });
  rpc.mockImplementation(async () => ({ data: 1, error: null }));
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

/** Loads a handler fresh so module-level caches do not leak between tests. */
async function loadHandler(path: string) {
  const module = await import(path);
  return module.default as (req: unknown, res: unknown) => Promise<void>;
}

const PROTECTED_ENDPOINTS = [
  ['pay-stub parsing', '../ai/parse-paystub'],
  ['wage-sheet parsing', '../ai/parse-wage-sheet'],
  ['paycheck explanation', '../ai/explain-paycheck'],
  ['market report', '../ai/market-report'],
  ['checkout', '../stripe/checkout'],
  ['portal', '../stripe/portal'],
  ['account deletion', '../account/delete'],
] as const;

describe('every protected endpoint rejects an unauthenticated caller', () => {
  it.each(PROTECTED_ENDPOINTS)(
    '%s returns 401 with no Authorization header',
    async (_name, path) => {
      const handler = await loadHandler(path);
      const { res, captured } = createResponse();
      await handler(createRequest({ method: 'POST', body: {} }), res);

      expect(captured.statusCode).toBe(401);
      expect(errorCode(captured)).toBe('unauthorized');
    },
  );

  it.each(PROTECTED_ENDPOINTS)('%s returns 401 for an invalid token', async (_name, path) => {
    getUser.mockResolvedValue({ data: null, error: { message: 'bad jwt' } });
    const handler = await loadHandler(path);
    const { res, captured } = createResponse();
    await handler(
      createRequest({ method: 'POST', body: {}, headers: { authorization: 'Bearer forged' } }),
      res,
    );

    expect(captured.statusCode).toBe(401);
    expect(errorCode(captured)).toBe('unauthorized');
  });

  it('the prices endpoint also requires a signed-in caller', async () => {
    const handler = await loadHandler('../prices');
    const { res, captured } = createResponse();
    await handler(createRequest({ method: 'GET', query: { tickers: 'VOO' } }), res);
    expect(captured.statusCode).toBe(401);
  });
});

describe('method guards', () => {
  it('rejects a GET on an endpoint that takes POST', async () => {
    const handler = await loadHandler('../ai/parse-paystub');
    const { res, captured } = createResponse();
    await handler(createRequest({ method: 'GET' }), res);
    expect(captured.statusCode).toBe(405);
    expect(captured.headers.allow).toBe('POST');
  });

  it('rejects a POST on the read-only subscription endpoint', async () => {
    const handler = await loadHandler('../stripe/subscription');
    const { res, captured } = createResponse();
    await handler(createRequest({ method: 'POST' }), res);
    expect(captured.statusCode).toBe(405);
  });
});

describe('Pro endpoints refuse a free user on the server', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: FREE_USER }, error: null });
    // No subscription row at all — the free-tier default.
    tableRows.mockReturnValue({ data: null, error: null });
  });

  const authed = (body: unknown = {}) =>
    createRequest({ method: 'POST', body, headers: { authorization: 'Bearer valid' } });

  it('market reports are Pro-only', async () => {
    const handler = await loadHandler('../ai/market-report');
    const { res, captured } = createResponse();
    await handler(authed(), res);

    expect(captured.statusCode).toBe(402);
    expect(errorCode(captured)).toBe('pro_required');
  });

  it('paycheck explanations are Pro-only', async () => {
    const handler = await loadHandler('../ai/explain-paycheck');
    const { res, captured } = createResponse();
    await handler(authed({ payStubId: '22222222-2222-2222-2222-222222222222' }), res);

    expect(captured.statusCode).toBe(402);
    expect(errorCode(captured)).toBe('pro_required');
  });

  it('a free user with an expired subscription is still refused', async () => {
    tableRows.mockReturnValue({
      data: {
        status: 'canceled',
        current_period_end: '2020-01-01T00:00:00Z',
        cancel_at_period_end: true,
        trial_end: null,
        past_due_since: null,
      },
      error: null,
    });
    const handler = await loadHandler('../ai/market-report');
    const { res, captured } = createResponse();
    await handler(authed(), res);
    expect(captured.statusCode).toBe(402);
  });

  it('refuses before contacting the AI provider', async () => {
    const anthropic = await import('../_lib/anthropic');
    const handler = await loadHandler('../ai/market-report');
    const { res } = createResponse();
    await handler(authed(), res);
    expect(anthropic.callAnthropic).not.toHaveBeenCalled();
  });
});

describe('Pro endpoints admit an entitled user', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: FREE_USER }, error: null });
    tableRows.mockReturnValue({
      data: {
        status: 'active',
        current_period_end: '2099-01-01T00:00:00Z',
        cancel_at_period_end: false,
        trial_end: null,
        past_due_since: null,
      },
      error: null,
    });
  });

  it('gets past the entitlement gate and on to its own validation', async () => {
    const handler = await loadHandler('../ai/explain-paycheck');
    const { res, captured } = createResponse();
    await handler(
      createRequest({
        method: 'POST',
        body: { payStubId: 'not-a-uuid' },
        headers: { authorization: 'Bearer valid' },
      }),
      res,
    );

    // 400, not 402: the Pro check passed and the request-shape check is what
    // rejected it.
    expect(captured.statusCode).toBe(400);
    expect(errorCode(captured)).toBe('invalid_request');
  });
});

describe('free-tier endpoints are reachable by free users', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: FREE_USER }, error: null });
    tableRows.mockReturnValue({ data: null, error: null });
  });

  it('pay-stub parsing validates the file rather than refusing the tier', async () => {
    const handler = await loadHandler('../ai/parse-paystub');
    const { res, captured } = createResponse();
    await handler(
      createRequest({
        method: 'POST',
        body: { base64: '', mediaType: 'application/pdf' },
        headers: { authorization: 'Bearer valid' },
      }),
      res,
    );

    // 400 for the empty file, never 402 — parsing is a free-tier feature.
    expect(captured.statusCode).toBe(400);
    expect(errorCode(captured)).toBe('invalid_request');
  });
});

describe('allowance exhaustion', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: FREE_USER }, error: null });
    tableRows.mockReturnValue({ data: null, error: null });
  });

  it('returns 429 when the monthly parse allowance is spent', async () => {
    // A null return from claim_ai_usage is how the database reports "limit hit".
    // The rate limiter uses a different function and must keep succeeding, or
    // this would assert the wrong guard.
    rpc.mockImplementation(async (name: string) =>
      name === 'claim_ai_usage' ? { data: null, error: null } : { data: 1, error: null },
    );

    const pdf = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46]),
      Buffer.alloc(60, 0x20),
    ]).toString('base64');

    const handler = await loadHandler('../ai/parse-paystub');
    const { res, captured } = createResponse();
    await handler(
      createRequest({
        method: 'POST',
        body: { base64: pdf, mediaType: 'application/pdf' },
        headers: { authorization: 'Bearer valid' },
      }),
      res,
    );

    expect(captured.statusCode).toBe(429);
    expect(errorCode(captured)).toBe('allowance_exhausted');
  });

  it('never calls the AI provider once the allowance is spent', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'claim_ai_usage' ? { data: null, error: null } : { data: 1, error: null },
    );
    const anthropic = await import('../_lib/anthropic');

    const pdf = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46]),
      Buffer.alloc(60, 0x20),
    ]).toString('base64');

    const handler = await loadHandler('../ai/parse-paystub');
    const { res } = createResponse();
    await handler(
      createRequest({
        method: 'POST',
        body: { base64: pdf, mediaType: 'application/pdf' },
        headers: { authorization: 'Bearer valid' },
      }),
      res,
    );

    expect(anthropic.callAnthropic).not.toHaveBeenCalled();
  });
});

describe('error responses never leak internals', () => {
  it('reports a configuration problem without naming the variable', async () => {
    restoreEnv();
    restoreEnv = stubEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const handler = await loadHandler('../ai/parse-paystub');
    const { res, captured } = createResponse();
    await handler(
      createRequest({ method: 'POST', body: {}, headers: { authorization: 'Bearer valid' } }),
      res,
    );

    const serialised = JSON.stringify(captured.body);
    expect(serialised).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(serialised).not.toContain('service_role');
  });
});
