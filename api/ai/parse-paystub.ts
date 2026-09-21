/**
 * POST /api/ai/parse-paystub
 *
 * Reads a pay stub image or scanned PDF. Available to free users within the
 * configured monthly allowance — document parsing is the feature that makes
 * NetShift usable at all, so it is not held behind the paywall.
 *
 * Order of operations matters: authenticate, rate-limit, validate the file,
 * *then* claim allowance, then call the provider. Claiming before the call and
 * releasing on failure means a provider outage never costs a user a parse,
 * while a successful call always costs exactly one.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth.js';
import { aiModels } from '../_lib/env.js';
import { methodGuard, noStore, ok, withErrorHandling } from '../_lib/http.js';
import { AI_RATE_LIMIT, consumeRateLimit } from '../_lib/rateLimit.js';
import { claimAiUsage, getEntitlement, recordAiUsage } from '../_lib/entitlements.js';
import { callAnthropic, parseJsonResponse } from '../_lib/anthropic.js';
import { documentContentBlocks, validateDocumentSet } from '../_lib/documents.js';
import { validatePayStub } from '../_lib/validation.js';

const SYSTEM_PROMPT = [
  'You extract figures from a pay stub and return JSON only.',
  'Respond with a single JSON object and nothing else: no prose, no markdown fences.',
  'Schema:',
  '{"pay_date": string|null, "period_start": string|null, "period_end": string|null,',
  ' "gross_pay": number|null, "net_pay": number|null, "hours_worked": number|null,',
  ' "regular_hours": number|null, "overtime_hours": number|null, "double_time_hours": number|null,',
  ' "hourly_rate": number|null, "federal_tax": number|null, "state_tax": number|null,',
  ' "social_security": number|null, "medicare": number|null, "other_deductions_total": number|null,',
  ' "shift_differential_amount": number|null, "sunday_premium_amount": number|null,',
  ' "role_premium_amount": number|null, "per_diem_amount": number|null}',
  'Rules:',
  '- Money and hours are plain numbers: no currency symbols, no thousands separators.',
  '- Use null for anything not shown on the stub. Never estimate or infer a missing value.',
  '- Read the CURRENT PERIOD column, never the year-to-date column.',
  '- Dates as they appear; the caller normalises them.',
  '- A large document arrives as several labelled page images. Treat them as one stub,',
  '  in the order given, and merge what you find across them.',
].join('\n');

export default withErrorHandling(
  'ai.parsePaystub',
  async (req: VercelRequest, res: VercelResponse) => {
    if (!methodGuard(req, res, ['POST'])) return;
    noStore(res);

    const user = await requireUser(req);
    await consumeRateLimit(user.id, AI_RATE_LIMIT);

    // Validate the file before spending allowance: a user who uploads a 30 MB
    // video should get a clear error, not a consumed parse.
    const documents = validateDocumentSet((req.body ?? {}) as Record<string, unknown>);

    const entitlement = await getEntitlement(user.id);
    const claim = await claimAiUsage(user.id, entitlement.tier, 'parse_paystub');

    const model = aiModels().extraction;
    const startedAt = Date.now();

    try {
      const result = await callAnthropic({
        model,
        maxTokens: 1500,
        system: SYSTEM_PROMPT,
        temperature: 0,
        content: [
          ...documentContentBlocks(documents),
          { type: 'text', text: 'Extract this pay stub as JSON per the schema.' },
        ],
      });

      const parsed = parseJsonResponse<Record<string, unknown>>(result.text);
      const { value, issues } = validatePayStub(parsed);

      await recordAiUsage({
        userId: user.id,
        operation: 'parse_paystub',
        month: claim.month,
        tier: entitlement.tier,
        model,
        countsTowardAllowance: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: Date.now() - startedAt,
        outcome: 'ok',
      });

      ok(res, {
        data: value,
        issues,
        source: 'ai',
        // Echoed so the UI can show the remaining allowance without a second
        // round trip.
        usage: {
          used: claim.used,
          limit: claim.unlimited ? null : claim.limit,
          remaining: claim.unlimited ? null : Math.max(0, claim.limit - claim.used),
          month: claim.month,
        },
      });
    } catch (error) {
      // A failed extraction must not cost the user a parse from their
      // allowance — they got nothing for it.
      await claim.release();
      await recordAiUsage({
        userId: user.id,
        operation: 'parse_paystub',
        month: claim.month,
        tier: entitlement.tier,
        model,
        countsTowardAllowance: false,
        durationMs: Date.now() - startedAt,
        outcome: 'error',
        errorCode: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
  },
);
