# Legacy prototype (reference only)

These are the files of the pre-2.0 NetShift prototype, kept here so the
original behaviour can be diffed against the rewritten application. **Nothing
in this folder is built, bundled, served, or deployed.**

| File            | Was                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `index.html`    | `public/index.html` — CDN React 18 + Babel Standalone + pdf.js, and a `window.storage` shim over `localStorage`. |
| `app.jsx`       | `public/app.jsx` — the entire 2,676-line single-component app.                                                   |
| `api-claude.js` | `api/claude.js` — an **unauthenticated** pass-through proxy to the Anthropic Messages API.                       |

## Why `api-claude.js` is not in `api/` any more

It forwarded any request body the browser sent straight to Anthropic with the
server's key attached, with no authentication, no allow-list of models, no size
limits, and no rate limiting. Anyone who found the URL could spend the key.
It is replaced by the purpose-built endpoints under `api/ai/`, each of which
authenticates the caller, checks entitlements and usage allowance, validates
input, and builds the prompt server-side.

## Where the behaviour went

| Prototype code                             | Now lives in                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `weekTotals`, `effRate`, `grossFromBucket` | `src/lib/calc/hours.ts`                                                                                                |
| `calculateHoursToPay`                      | `src/lib/calc/pay.ts` (`hoursToPay`)                                                                                   |
| `targetCalc` / `targetDailyBreakdown`      | `src/lib/calc/pay.ts` (`targetToHours`)                                                                                |
| `parseStubTextLocally`                     | `src/lib/parsing/paystub.ts`                                                                                           |
| `parseWageSheetTextLocally`                | `src/lib/parsing/wageSheet.ts`                                                                                         |
| `extractPdfTextLayer`                      | `src/lib/parsing/pdfText.ts`                                                                                           |
| `PAY_SCALE` / `PAY_SCALE_EFFECTIVE`        | `src/lib/data/exampleWageProfiles.ts`                                                                                  |
| `calculateGrowth`                          | `src/lib/calc/growth.ts`                                                                                               |
| investment account/holding maths           | `src/lib/calc/portfolio.ts`                                                                                            |
| `refreshLivePrices` (LLM web search)       | `api/prices.ts` (Stooq, no LLM)                                                                                        |
| `generateMarketReport`                     | `api/ai/market-report.ts` (Pro-only, server-built prompt)                                                              |
| `window.storage` key/value shim            | `src/services/*` over structured Supabase tables, with `src/features/legacy-import` migrating old `netshift_data` rows |
