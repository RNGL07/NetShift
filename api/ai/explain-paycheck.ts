/**
 * POST /api/ai/explain-paycheck — Pro only.
 *
 * Explains a paycheck in plain language. Two constraints shape this endpoint:
 *
 *  1. The figures are read from the *database*, not from the request body. A
 *     client that could supply its own numbers could ask the model to explain
 *     anything at all; reading the user's own rows through their own RLS-bound
 *     client means the explanation is always about a paycheck they own.
 *  2. The prompt forbids advice. This is educational software, and an LLM
 *     invited to comment on someone's finances will otherwise drift into
 *     recommending things NetShift is in no position to recommend.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth';
import { aiModels } from '../_lib/env';
import { ApiError, methodGuard, noStore, ok, withErrorHandling } from '../_lib/http';
import { AI_RATE_LIMIT, consumeRateLimit } from '../_lib/rateLimit';
import { claimAiUsage, recordAiUsage, requireFeature } from '../_lib/entitlements';
import { callAnthropic } from '../_lib/anthropic';
import { serviceClient } from '../_lib/supabase';

const SYSTEM_PROMPT = [
  'You explain one paycheck to the shift worker who earned it, in plain English.',
  '',
  'Style:',
  '- Short paragraphs and plain words. No jargon, no bullet-point walls.',
  '- Address the reader as "you". Around 150-250 words.',
  '- Explain what each part of the cheque is and why it is the size it is.',
  '',
  'Hard rules:',
  '- Use ONLY the figures given. Never invent, estimate, or extrapolate a number.',
  '- Never give tax, legal, investment, or financial advice, and never recommend',
  '  a course of action. Describe what happened; do not say what to do about it.',
  '- Never assert that the employer or payroll made an error. If something looks',
  '  inconsistent, say it may be worth checking and what to check.',
  '- If a figure is missing, say it is not on the stub rather than guessing.',
].join('\n');

interface StubRow {
  id: string;
  pay_date: string | null;
  gross_pay: number | null;
  net_pay: number | null;
  hours_worked: number | null;
  regular_hours: number | null;
  overtime_hours: number | null;
  double_time_hours: number | null;
  hourly_rate: number | null;
  federal_tax: number | null;
  state_tax: number | null;
  social_security: number | null;
  medicare: number | null;
  other_deductions_total: number | null;
  per_diem_amount: number | null;
}

function describe(stub: StubRow): string {
  const lines: string[] = [];
  const add = (label: string, value: number | string | null, prefix = '') => {
    if (value === null || value === undefined) return;
    lines.push(`${label}: ${prefix}${value}`);
  };

  add('Pay date', stub.pay_date);
  add('Gross pay', stub.gross_pay, '$');
  add('Net pay', stub.net_pay, '$');
  add('Total paid hours', stub.hours_worked);
  add('Regular hours', stub.regular_hours);
  add('Overtime hours', stub.overtime_hours);
  add('Double-time hours', stub.double_time_hours);
  add('Hourly rate', stub.hourly_rate, '$');
  add('Federal tax withheld', stub.federal_tax, '$');
  add('State tax withheld', stub.state_tax, '$');
  add('Social Security withheld', stub.social_security, '$');
  add('Medicare withheld', stub.medicare, '$');
  add('Other deductions', stub.other_deductions_total, '$');
  add('Per diem (not taxed)', stub.per_diem_amount, '$');

  return lines.join('\n');
}

export default withErrorHandling(
  'ai.explainPaycheck',
  async (req: VercelRequest, res: VercelResponse) => {
    if (!methodGuard(req, res, ['POST'])) return;
    noStore(res);

    const user = await requireUser(req);
    await consumeRateLimit(user.id, AI_RATE_LIMIT);

    const entitlement = await requireFeature(user.id, 'ai_explanations');

    const payStubId = (req.body as { payStubId?: unknown } | undefined)?.payStubId;
    if (typeof payStubId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payStubId)) {
      throw new ApiError('invalid_request', 'Choose a paycheck to explain.');
    }

    // Read through the caller's own client: RLS guarantees this is their stub,
    // so a guessed id from another account simply returns nothing.
    const { data: stub, error } = await user.db
      .from('pay_stubs')
      .select(
        'id, pay_date, gross_pay, net_pay, hours_worked, regular_hours, overtime_hours, double_time_hours, hourly_rate, federal_tax, state_tax, social_security, medicare, other_deductions_total, per_diem_amount',
      )
      .eq('id', payStubId)
      .maybeSingle<StubRow>();

    if (error || !stub) {
      throw new ApiError('not_found', 'That paycheck could not be found.');
    }
    if (stub.gross_pay === null && stub.net_pay === null) {
      throw new ApiError(
        'invalid_request',
        'That paycheck has no figures saved yet, so there is nothing to explain.',
      );
    }

    const claim = await claimAiUsage(user.id, entitlement.tier, 'explain_paycheck');
    const model = aiModels().explanation;
    const startedAt = Date.now();

    try {
      const result = await callAnthropic({
        model,
        maxTokens: 900,
        system: SYSTEM_PROMPT,
        content: [
          {
            type: 'text',
            text: `Explain this paycheck:\n\n${describe(stub)}`,
          },
        ],
      });

      // Stored so the user can re-read it without spending allowance again.
      await serviceClient().from('ai_explanations').insert({
        user_id: user.id,
        subject_kind: 'paycheck',
        subject_id: stub.id,
        body: result.text,
        model,
      });

      await recordAiUsage({
        userId: user.id,
        operation: 'explain_paycheck',
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
        explanation: result.text,
        payStubId: stub.id,
        disclaimer:
          'This is an explanation of your own figures, for education. It is not tax, payroll, or financial advice.',
      });
    } catch (caught) {
      await claim.release();
      await recordAiUsage({
        userId: user.id,
        operation: 'explain_paycheck',
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
