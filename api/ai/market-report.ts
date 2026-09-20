/**
 * POST /api/ai/market-report — Pro only.
 *
 * Generates an educational market summary. Labelled as education in the prompt,
 * in the response, and in the database column that stores it, because a
 * generated paragraph about markets is exactly the kind of content a reader
 * can mistake for a recommendation.
 *
 * Note what this endpoint is *not* used for: portfolio valuation. Holding
 * prices come from `/api/prices`, a real market-data source — asking a language
 * model for a share price produces a number that looks authoritative and may
 * simply be wrong.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth.js';
import { aiModels } from '../_lib/env.js';
import { methodGuard, noStore, ok, withErrorHandling } from '../_lib/http.js';
import { AI_RATE_LIMIT, consumeRateLimit } from '../_lib/rateLimit.js';
import { claimAiUsage, recordAiUsage, requireFeature } from '../_lib/entitlements.js';
import { callAnthropic, parseJsonResponse } from '../_lib/anthropic.js';
import { validateMarketReport } from '../_lib/validation.js';
import { serviceClient } from '../_lib/supabase.js';

const DISCLAIMER =
  'Educational information only. This is not investment advice and not a recommendation to buy or sell anything.';

const SYSTEM_PROMPT = [
  'You are a market summariser with web search. Search for the most recent',
  'trading session’s close, current housing-market conditions, and commodities.',
  '',
  'Respond with a single JSON object and nothing else: no prose, no markdown fences.',
  'Schema:',
  '{"as_of": string, "stock_market": string, "stocks_to_watch": [{"ticker": string, "note": string}],',
  ' "housing_market": string, "commodities": string}',
  '',
  'Rules:',
  '- Base everything on real search results. Never state a figure you did not find.',
  '- "stocks_to_watch" is 4-6 entries that are genuinely in the news, with one',
  '  sentence each on WHY they are notable. It is not a list of picks.',
  '- Describe what happened and why. Never recommend buying, selling, or holding',
  '  anything, and never predict a price.',
  '- Do not narrate your search process.',
].join('\n');

export default withErrorHandling(
  'ai.marketReport',
  async (req: VercelRequest, res: VercelResponse) => {
    if (!methodGuard(req, res, ['POST'])) return;
    noStore(res);

    const user = await requireUser(req);
    await consumeRateLimit(user.id, AI_RATE_LIMIT);

    const entitlement = await requireFeature(user.id, 'ai_market_reports');
    const claim = await claimAiUsage(user.id, entitlement.tier, 'market_report');

    const model = aiModels().report;
    const startedAt = Date.now();

    try {
      const result = await callAnthropic({
        model,
        maxTokens: 4000,
        system: SYSTEM_PROMPT,
        enableWebSearch: true,
        content: [
          {
            type: 'text',
            text: 'Give me the current market picture: stocks, housing, and commodities.',
          },
        ],
      });

      const parsed = parseJsonResponse<Record<string, unknown>>(result.text);
      const { value } = validateMarketReport(parsed);

      const { data: saved, error } = await serviceClient()
        .from('market_reports')
        .insert({
          user_id: user.id,
          as_of: value.asOf,
          stock_market: value.stockMarket,
          stocks_to_watch: value.stocksToWatch,
          housing_market: value.housingMarket,
          commodities: value.commodities,
          model,
          disclaimer: DISCLAIMER,
        })
        .select('id, generated_at')
        .single<{ id: string; generated_at: string }>();

      if (error) throw error;

      await recordAiUsage({
        userId: user.id,
        operation: 'market_report',
        month: claim.month,
        tier: entitlement.tier,
        model,
        countsTowardAllowance: false,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: Date.now() - startedAt,
        outcome: 'ok',
      });

      ok(res, {
        report: {
          id: saved.id,
          generatedAt: saved.generated_at,
          ...value,
          disclaimer: DISCLAIMER,
        },
      });
    } catch (caught) {
      await claim.release();
      await recordAiUsage({
        userId: user.id,
        operation: 'market_report',
        month: claim.month,
        tier: entitlement.tier,
        model,
        countsTowardAllowance: false,
        durationMs: Date.now() - startedAt,
        outcome: 'error',
        errorCode: caught instanceof Error ? caught.name : 'unknown',
      });
      throw caught;
    }
  },
);
