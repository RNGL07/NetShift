/**
 * Server-side environment access.
 *
 * Nothing here is ever bundled into the browser: these names have no `VITE_`
 * prefix, so Vite will not expose them even if a client module imported this
 * file by accident. `requireEnv` throws a deliberately vague error because the
 * message can reach a user, and "STRIPE_SECRET_KEY is not set" is a detail
 * about the deployment that a caller has no business learning.
 */

export class ConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Server configuration error: ${variable} is not set.`);
    this.name = 'ConfigurationError';
    this.variable = variable;
  }
}

export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) throw new ConfigurationError(name);
  return value;
}

export function readEnvNumber(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readEnvBoolean(name: string, fallback = false): boolean {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/** True in a Vercel production deployment. */
export function isProduction(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
}

/** The public origin, used for Stripe return URLs. */
export function appUrl(): string {
  const explicit = readEnv('APP_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = readEnv('VERCEL_PROJECT_PRODUCTION_URL') ?? readEnv('VERCEL_URL');
  if (vercel) return `https://${vercel.replace(/\/$/, '')}`;
  return 'http://localhost:5173';
}

// ---------------------------------------------------------------------------
// AI configuration
// ---------------------------------------------------------------------------

/**
 * Model names are configurable so a model can be swapped without a code
 * change. The defaults are the current Claude models; an operator can point
 * these at a cheaper model for parsing and a stronger one for explanations.
 */
export function aiModels() {
  return {
    extraction: readEnv('ANTHROPIC_EXTRACTION_MODEL') ?? 'claude-sonnet-5',
    explanation: readEnv('ANTHROPIC_EXPLANATION_MODEL') ?? 'claude-sonnet-5',
    report: readEnv('ANTHROPIC_REPORT_MODEL') ?? 'claude-sonnet-5',
  };
}

/**
 * Maximum accepted size for a single page, in bytes.
 *
 * Vercel limits a function's request body to 4.5 MB and pages arrive
 * base64-encoded (4/3 inflation), so a per-page cap above ~3.3 MB could never
 * be reached anyway — the platform would reject the request first, with an
 * HTML error the client cannot parse.
 *
 * This is not the limit on what a user may upload. The browser shrinks a large
 * photo and renders a large PDF to page images before sending, so the file on
 * disk can be far bigger than this; what this bounds is one page of what
 * actually arrives.
 */
export function maxDocumentBytes(): number {
  return readEnvNumber('NETSHIFT_MAX_DOCUMENT_BYTES', 3 * 1024 * 1024);
}

/**
 * Maximum combined decoded size of all pages in one request.
 *
 * Below the per-page cap times the page count on purpose: the real ceiling is
 * the platform's 4.5 MB body limit, which the encoded payload has to fit
 * inside. This is the server's own backstop against a client that ignores it.
 */
export function maxDocumentTotalBytes(): number {
  return readEnvNumber('NETSHIFT_MAX_DOCUMENT_TOTAL_BYTES', 4 * 1024 * 1024);
}

/**
 * Maximum number of pages accepted in one request.
 *
 * A pay stub is one or two pages and a wage scale rarely more than a few, so
 * this is generous for real documents while keeping one allowance-spending
 * request from becoming an unbounded upload. Kept at or above the client's own
 * page cap, or the browser would build requests the server then rejects.
 */
export function maxDocumentPages(): number {
  return readEnvNumber('NETSHIFT_MAX_DOCUMENT_PAGES', 8);
}

/** Environment slice handed to `resolveAiLimits`, so limits stay configurable. */
export function aiLimitEnv(): Record<string, string | undefined> {
  return {
    NETSHIFT_FREE_MONTHLY_DOCUMENT_PARSES: readEnv('NETSHIFT_FREE_MONTHLY_DOCUMENT_PARSES'),
    NETSHIFT_FREE_MONTHLY_AI_EXPLANATIONS: readEnv('NETSHIFT_FREE_MONTHLY_AI_EXPLANATIONS'),
    NETSHIFT_FREE_MONTHLY_MARKET_REPORTS: readEnv('NETSHIFT_FREE_MONTHLY_MARKET_REPORTS'),
    NETSHIFT_PRO_MONTHLY_DOCUMENT_PARSES: readEnv('NETSHIFT_PRO_MONTHLY_DOCUMENT_PARSES'),
    NETSHIFT_PRO_MONTHLY_AI_EXPLANATIONS: readEnv('NETSHIFT_PRO_MONTHLY_AI_EXPLANATIONS'),
    NETSHIFT_PRO_MONTHLY_MARKET_REPORTS: readEnv('NETSHIFT_PRO_MONTHLY_MARKET_REPORTS'),
  };
}
