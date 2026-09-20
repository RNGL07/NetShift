/**
 * Test setup for the browser-environment suites.
 *
 * `api/**` runs under the node environment (see vitest.config.ts) where there
 * is no DOM, so the jest-dom matchers are only registered when one exists.
 */

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}
