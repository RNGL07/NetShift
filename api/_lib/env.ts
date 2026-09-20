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
 * Maximum accepted upload size, in bytes.
 *
 * Kept in step with the client's cap. Vercel limits a function's request body
 * to 4.5 MB and the document arrives base64-encoded (4/3 inflation), so a cap
 * above ~3.3 MB could never be reached anyway — the platform would reject the
 * request first, with an HTML error the client cannot parse.
 */
export function maxDocumentBytes(): number {
  return readEnvNumber('NETSHIFT_MAX_DOCUMENT_BYTES', 3 * 1024 * 1024);
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
