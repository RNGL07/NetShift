/**
 * Anthropic access.
 *
 * Every prompt is built **here, on the server**. The browser sends only the
 * document (or a small, validated set of figures) and never a prompt, a model
 * name, a tool list, or a token budget. That is the difference between this and
 * the prototype's `api/claude.js`, which forwarded whatever request body the
 * page supplied and was therefore an open, unauthenticated proxy to a paid API.
 *
 * Nothing here logs document bytes or extracted financial values.
 */

import { requireEnv } from './env.js';
import { ApiError, logServerError } from './http.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

export interface MessageRequest {
  model: string;
  maxTokens: number;
  system: string;
  content: ContentBlock[];
  /** Server-side web search, used only by the market report. */
  enableWebSearch?: boolean;
  temperature?: number;
}

export interface MessageResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
}

/** Timeout for a single call. A hung request must not hold a function open. */
const REQUEST_TIMEOUT_MS = 90_000;

export async function callAnthropic(request: MessageRequest): Promise<MessageResult> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: 'user', content: request.content }],
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.enableWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const aborted = error instanceof Error && error.name === 'AbortError';
    logServerError('anthropic.call', error, { model: request.model, aborted });
    throw new ApiError(
      'upstream_unavailable',
      aborted
        ? 'That took too long to process. Try a smaller or clearer file.'
        : 'The document service is unavailable right now. Please try again shortly.',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // The provider's message can contain request detail; it is logged, never
    // returned. The caller gets a category and a next step.
    let detail = '';
    try {
      detail = JSON.stringify(await response.json()).slice(0, 500);
    } catch {
      detail = `status ${response.status}`;
    }
    logServerError('anthropic.status', new Error(detail), {
      status: response.status,
      model: request.model,
    });

    if (response.status === 429) {
      throw new ApiError(
        'upstream_unavailable',
        'The document service is busy. Please try again in a minute.',
      );
    }
    if (response.status >= 500) {
      throw new ApiError(
        'upstream_unavailable',
        'The document service is having trouble. Please try again shortly.',
      );
    }
    throw new ApiError('extraction_failed', 'That document could not be processed.');
  }

  const payload = (await response.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };

  const text = (payload.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();

  if (!text) {
    throw new ApiError('extraction_failed', 'Nothing could be read from that document.');
  }

  return {
    text,
    inputTokens: payload.usage?.input_tokens ?? null,
    outputTokens: payload.usage?.output_tokens ?? null,
    stopReason: payload.stop_reason ?? null,
  };
}

/**
 * Parses a JSON object out of a model response.
 *
 * Models occasionally wrap JSON in prose or fences despite instruction, so the
 * first balanced object is extracted rather than the whole string being parsed.
 * A failure here is a `extraction_failed`, not a 500: it is a bad result, not a
 * broken server.
 */
export function parseJsonResponse<T>(text: string): T {
  const backtick = String.fromCharCode(96);
  const triple = backtick.repeat(3);
  const cleaned = text.split(`${triple}json`).join('').split(triple).join('').trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new ApiError('extraction_failed', 'The document could not be read in a usable format.');
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    throw new ApiError('extraction_failed', 'The document could not be read in a usable format.');
  }
}
