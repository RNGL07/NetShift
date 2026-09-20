/**
 * A small harness for exercising Vercel handlers in-process.
 *
 * Endpoint behaviour that matters — "does an anonymous caller get a 401",
 * "does a free user get a 402 from a Pro endpoint" — is not visible in unit
 * tests of the helper functions. These fakes let the real handler run with its
 * real guard clauses, with only Supabase, Stripe, and Anthropic stubbed.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { vi } from 'vitest';

export interface CapturedResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

export function createRequest(options: {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
} = {}): VercelRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  return {
    method: options.method ?? 'POST',
    body: options.body,
    query: options.query ?? {},
    headers,
  } as unknown as VercelRequest;
}

export function createResponse(): { res: VercelResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: undefined, headers: {} };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
    send(payload: unknown) {
      captured.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return this;
    },
    get headersSent() {
      return captured.statusCode !== 0;
    },
  } as unknown as VercelResponse;
  return { res, captured };
}

/** Reads the error code out of a captured error response. */
export function errorCode(captured: CapturedResponse): string | undefined {
  const body = captured.body as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

/** Sets the environment every endpoint expects, with obviously fake values. */
export function stubEnv(overrides: Record<string, string> = {}): () => void {
  const previous: Record<string, string | undefined> = {};
  const values: Record<string, string> = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    STRIPE_PRO_PRICE_ID: 'price_fake',
    APP_URL: 'https://netshift.test',
    ...overrides,
  };

  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * A stand-in for a Supabase query builder.
 *
 * Every chainable method returns `this`, and the terminal methods resolve to
 * whatever result was configured for the table, so a handler's real query chain
 * runs unmodified.
 */
export interface TableResult {
  data?: unknown;
  error?: unknown;
}

export function createSupabaseStub(tables: Record<string, TableResult> = {}) {
  const rpcResults: Record<string, TableResult> = {};
  const inserted: { table: string; rows: unknown }[] = [];
  const rpcCalls: { name: string; args: unknown }[] = [];

  const builderFor = (table: string) => {
    const result = tables[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of [
      'select', 'eq', 'in', 'neq', 'gt', 'gte', 'lt', 'lte',
      'order', 'limit', 'range', 'filter', 'is', 'not', 'or',
    ]) {
      builder[method] = chain;
    }
    builder.insert = (rows: unknown) => {
      inserted.push({ table, rows });
      return builder;
    };
    builder.upsert = (rows: unknown) => {
      inserted.push({ table, rows });
      return builder;
    };
    builder.update = () => builder;
    builder.delete = () => builder;
    builder.maybeSingle = async () => result;
    builder.single = async () => result;
    builder.then = (resolve: (value: TableResult) => unknown) => Promise.resolve(result).then(resolve);
    return builder;
  };

  const client = {
    from: (table: string) => builderFor(table),
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return rpcResults[name] ?? { data: null, error: null };
    },
    auth: {
      getUser: vi.fn(),
    },
  };

  return {
    client,
    inserted,
    rpcCalls,
    setRpcResult(name: string, result: TableResult) {
      rpcResults[name] = result;
    },
    setTableResult(table: string, result: TableResult) {
      tables[table] = result;
    },
  };
}
