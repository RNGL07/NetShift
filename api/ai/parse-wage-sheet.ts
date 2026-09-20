/**
 * POST /api/ai/parse-wage-sheet
 *
 * Reads an employer wage sheet, grow-in scale, or offer letter. Free within
 * the same monthly document allowance as pay-stub parsing — employer wage
 * profiles are NetShift's differentiator, and making them expensive to enter
 * would undercut the whole product.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth.js';
import { aiModels } from '../_lib/env.js';
import { methodGuard, noStore, ok, withErrorHandling } from '../_lib/http.js';
import { AI_RATE_LIMIT, consumeRateLimit } from '../_lib/rateLimit.js';
import { claimAiUsage, getEntitlement, recordAiUsage } from '../_lib/entitlements.js';
import { callAnthropic, parseJsonResponse } from '../_lib/anthropic.js';
import { documentContentBlock, validateDocument } from '../_lib/documents.js';
import { validateWageSheet } from '../_lib/validation.js';

const SYSTEM_PROMPT = [
  'You extract a wage scale from an employer pay document and return JSON only.',
  'Respond with a single JSON object and nothing else: no prose, no markdown fences.',
  'Schema:',
  '{"track_label": string|null, "effective_date": string|null, "shift_premium": number|null,',
  ' "team_leader_premium": number|null, "steps": [{"label": string, "rate": number}]}',
  'Rules:',
  '- "steps" is the tenure-based progression from the start rate to the top rate, in order,',
  '  using the document’s own milestone labels (Start, 6 Months, 1 Year, and so on).',
  '- If several job tracks appear, extract the one that reads as the main hourly rate table.',
  '- Premiums are PER HOUR. If a figure is weekly or annual, return null rather than converting.',
  '- Rates are plain numbers: no currency symbols, no thousands separators.',
  '- Use null or an empty array for anything not present. Never estimate.',
].join('\n');

export default withErrorHandling(
  'ai.parseWageSheet',
  async (req: VercelRequest, res: VercelResponse) => {
    if (!methodGuard(req, res, ['POST'])) return;
    noStore(res);

    const user = await requireUser(req);
    await consumeRateLimit(user.id, AI_RATE_LIMIT);

    const document = validateDocument((req.body ?? {}) as Record<string, unknown>);

    const entitlement = await getEntitlement(user.id);
    const claim = await claimAiUsage(user.id, entitlement.tier, 'parse_wage_sheet');

    const model = aiModels().extraction;
    const startedAt = Date.now();

    try {
      const result = await callAnthropic({
        model,
        maxTokens: 2000,
        system: SYSTEM_PROMPT,
        temperature: 0,
        content: [
          documentContentBlock(document),
          { type: 'text', text: 'Extract this wage document as JSON per the schema.' },
        ],
      });

      const parsed = parseJsonResponse<Record<string, unknown>>(result.text);
      const { value, issues } = validateWageSheet(parsed);

      await recordAiUsage({
        userId: user.id,
        operation: 'parse_wage_sheet',
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
        usage: {
          used: claim.used,
          limit: claim.unlimited ? null : claim.limit,
          remaining: claim.unlimited ? null : Math.max(0, claim.limit - claim.used),
          month: claim.month,
        },
      });
    } catch (error) {
      await claim.release();
      await recordAiUsage({
        userId: user.id,
        operation: 'parse_wage_sheet',
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
