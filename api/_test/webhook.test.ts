/**
 * Stripe webhook handler behaviour.
 *
 * The two properties worth testing here are the ones a mistake in would be
 * invisible until it cost money: that an unsigned or wrongly-signed request is
 * rejected, and that a redelivered event is not processed twice.
 *
 * The signature is computed with Stripe's own scheme so `constructEvent` is
 * exercised for real rather than stubbed — a test that mocks away signature
 * verification proves nothing about signature verification.
 */

import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResponse, stubEnv } from './harness';

const WEBHOOK_SECRET = 'whsec_test_secret';

const rpc = vi.fn();
const tableRows = vi.fn();
const subscriptionsRetrieve = vi.fn();
const upserted: unknown[] = [];

vi.mock('../_lib/supabase', () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete']) {
      chain[method] = () => chain;
    }
    chain.insert = () => chain;
    chain.upsert = (rows: unknown) => {
      upserted.push({ table, rows });
      return chain;
    };
    chain.maybeSingle = async () => tableRows();
    chain.single = async () => tableRows();
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(tableRows()).then(resolve);
    return chain;
  };
  const client = {
    from: (table: string) => builder(table),
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getUser: vi.fn() },
  };
  return { serviceClient: () => client, userClient: () => client };
});

/** Builds the `Stripe-Signature` header the way Stripe does. */
function signPayload(payload: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function subscriptionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_test_subscription',
    object: 'event',
    type: 'customer.subscription.updated',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'sub_test',
        object: 'subscription',
        status: 'active',
        customer: 'cus_test',
        cancel_at_period_end: false,
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 2_592_000,
        canceled_at: null,
        trial_end: null,
        metadata: { supabase_user_id: '11111111-1111-1111-1111-111111111111' },
        items: { data: [{ price: { id: 'price_test' } }] },
        ...overrides,
      },
    },
  };
}

/** A request whose body is a real readable stream, as Vercel delivers it. */
function webhookRequest(payload: string, signature: string | null) {
  const stream = Readable.from([Buffer.from(payload, 'utf8')]) as unknown as Record<string, unknown>;
  stream.method = 'POST';
  stream.headers = signature ? { 'stripe-signature': signature } : {};
  stream.query = {};
  return stream;
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = stubEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  rpc.mockReset();
  tableRows.mockReset();
  subscriptionsRetrieve.mockReset();
  upserted.length = 0;
  tableRows.mockReturnValue({ data: null, error: null });
  rpc.mockResolvedValue({ data: 'claimed', error: null });
  subscriptionsRetrieve.mockResolvedValue(subscriptionEvent().data.object);
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

async function loadWebhook() {
  const module = await import('../stripe/webhook');
  return module.default as (req: unknown, res: unknown) => Promise<void>;
}

describe('signature verification', () => {
  it('rejects a request with no signature header', async () => {
    const handler = await loadWebhook();
    const { res, captured } = createResponse();
    await handler(webhookRequest(JSON.stringify(subscriptionEvent()), null), res);

    expect(captured.statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const payload = JSON.stringify(subscriptionEvent());
    const handler = await loadWebhook();
    const { res, captured } = createResponse();
    await handler(webhookRequest(payload, signPayload(payload, 'whsec_wrong')), res);

    expect(captured.statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a body that was altered after signing', async () => {
    const original = JSON.stringify(subscriptionEvent());
    const signature = signPayload(original);
    // The classic attack: keep the signature, change the payload.
    const tampered = original.replace('"status":"active"', '"status":"trialing"');

    const handler = await loadWebhook();
    const { res, captured } = createResponse();
    await handler(webhookRequest(tampered, signature), res);

    expect(captured.statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a replayed signature that is outside the tolerance window', async () => {
    const payload = JSON.stringify(subscriptionEvent());
    const old = Math.floor(Date.now() / 1000) - 86_400;
    const handler = await loadWebhook();
    const { res, captured } = createResponse();
    await handler(webhookRequest(payload, signPayload(payload, WEBHOOK_SECRET, old)), res);

    expect(captured.statusCode).toBe(400);
  });

  it('accepts a correctly signed request', async () => {
    const payload = JSON.stringify(subscriptionEvent());
    const handler = await loadWebhook();
    const { res, captured } = createResponse();
    await handler(webhookRequest(payload, signPayload(payload)), res);

    expect(captured.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalled();
  });

  it('rejects a non-POST request before reading the body', async () => {
    const handler = await loadWebhook();
    const { res, captured } = createResponse();
    const request = webhookRequest('{}', null) as Record<string, unknown>;
    request.method = 'GET';
    await handler(request, res);

    expect(captured.statusCode).toBe(405);
  });
});

describe('idempotency', () => {
  const send = async (eventId: string) => {
    const event = subscriptionEvent();
    event.id = eventId;
    const payload = JSON.stringify(event);
    const handler = await loadWebhook();
    const { res, captured } = createResponse();
    await handler(webhookRequest(payload, signPayload(payload)), res);
    return captured;
  };

  it('processes a freshly claimed event', async () => {
    rpc.mockResolvedValue({ data: 'claimed', error: null });
    const captured = await send('evt_fresh');
    expect(captured.statusCode).toBe(200);
    expect((captured.body as { duplicate?: boolean }).duplicate).toBeUndefined();
  });

  it('acknowledges a duplicate without reprocessing it', async () => {
    rpc.mockResolvedValue({ data: 'duplicate', error: null });
    const captured = await send('evt_duplicate');

    // 200 so Stripe stops retrying, and no subscription write.
    expect(captured.statusCode).toBe(200);
    expect((captured.body as { duplicate?: boolean }).duplicate).toBe(true);
    expect(upserted.filter((u) => (u as { table: string }).table === 'subscriptions')).toHaveLength(0);
  });

  it('asks Stripe to retry when another delivery is mid-flight', async () => {
    rpc.mockResolvedValue({ data: 'in_progress', error: null });
    const captured = await send('evt_concurrent');

    expect(captured.statusCode).toBe(409);
    expect(upserted.filter((u) => (u as { table: string }).table === 'subscriptions')).toHaveLength(0);
  });

  it('asks Stripe to retry when the event cannot even be claimed', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const captured = await send('evt_claim_fails');

    // 500 makes Stripe retry, rather than losing the event silently.
    expect(captured.statusCode).toBe(500);
  });
});

describe('event routing', () => {
  it('acknowledges an event type NetShift does not act on, so retries stop', async () => {
    const event = subscriptionEvent();
    event.type = 'customer.created';
    const payload = JSON.stringify(event);

    const handler = await loadWebhook();
    const { res, captured } = createResponse();
    await handler(webhookRequest(payload, signPayload(payload)), res);

    expect(captured.statusCode).toBe(200);
    expect((captured.body as { handled?: boolean }).handled).toBe(false);
    // Never claimed, so an unhandled type does not fill the events table.
    expect(rpc).not.toHaveBeenCalled();
  });

  it('handles each subscription lifecycle event type', async () => {
    for (const type of [
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]) {
      rpc.mockResolvedValue({ data: 'claimed', error: null });
      const event = subscriptionEvent();
      event.type = type;
      event.id = `evt_${type}`;
      const payload = JSON.stringify(event);

      const handler = await loadWebhook();
      const { res, captured } = createResponse();
      await handler(webhookRequest(payload, signPayload(payload)), res);

      expect(captured.statusCode, `${type} should be handled`).toBe(200);
    }
  });
});
