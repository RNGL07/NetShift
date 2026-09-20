#!/usr/bin/env bash
#
# Fails if anything that must stay server-side appears in the built client
# bundle.
#
# The danger this guards against is mundane: someone adds `VITE_` to a secret's
# name to "make it work", or imports a server module from a component, and the
# service-role key ships to every browser. That is invisible in code review and
# catastrophic in production, so it is checked mechanically on every build.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -d dist ]]; then
  echo "No dist/ directory. Run 'npm run build' first." >&2
  exit 1
fi

# Names that must never appear in client code. The anon key and Supabase URL
# are deliberately absent: both are meant to be public, and row-level security
# rather than key secrecy is what protects the data.
FORBIDDEN_NAMES=(
  'SUPABASE_SERVICE_ROLE_KEY'
  'STRIPE_SECRET_KEY'
  'STRIPE_WEBHOOK_SECRET'
  'ANTHROPIC_API_KEY'
  'service_role'
)

# Value shapes that indicate a real credential was inlined.
FORBIDDEN_PATTERNS=(
  'sk_live_'
  'sk_test_'
  'rk_live_'
  'whsec_'
  'sk-ant-'
)

failed=0

echo "==> Scanning dist/ for server-only names"
for name in "${FORBIDDEN_NAMES[@]}"; do
  if grep -rlF "$name" dist/ 2>/dev/null | head -5 | grep -q .; then
    echo "  FAIL: '$name' appears in the client bundle:" >&2
    grep -rlF "$name" dist/ | sed 's/^/    /' >&2
    failed=1
  else
    echo "  ok: $name"
  fi
done

echo "==> Scanning dist/ for credential shapes"
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  if grep -rlF "$pattern" dist/ 2>/dev/null | head -5 | grep -q .; then
    echo "  FAIL: a value matching '$pattern' appears in the client bundle:" >&2
    grep -rlF "$pattern" dist/ | sed 's/^/    /' >&2
    failed=1
  else
    echo "  ok: $pattern"
  fi
done

echo "==> Checking that no client module imports from api/"
if grep -rn "from '.*\.\./api/" src/ --include='*.ts' --include='*.tsx' 2>/dev/null | grep -q .; then
  echo "  FAIL: client code imports from api/:" >&2
  grep -rn "from '.*\.\./api/" src/ --include='*.ts' --include='*.tsx' | sed 's/^/    /' >&2
  failed=1
else
  echo "  ok: no client module imports server code"
fi

echo "==> Checking that no secret is committed to the repo"
if git ls-files | grep -E '^\.env($|\.)' | grep -v '\.example$' | grep -q .; then
  echo "  FAIL: an .env file is tracked by git:" >&2
  git ls-files | grep -E '^\.env($|\.)' | grep -v '\.example$' | sed 's/^/    /' >&2
  failed=1
else
  echo "  ok: no .env file is tracked"
fi

# .env.example must contain placeholders, never real values.
if [[ -f .env.example ]]; then
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    # A placeholder like `sk_test_your-key` is fine; a 24+ character tail is not.
    if grep -E "${pattern}[A-Za-z0-9]{24,}" .env.example >/dev/null 2>&1; then
      echo "  FAIL: .env.example appears to contain a real credential ($pattern)" >&2
      failed=1
    fi
  done
  echo "  ok: .env.example holds placeholders only"
fi

if [[ $failed -ne 0 ]]; then
  echo
  echo "Secret scan FAILED." >&2
  exit 1
fi

echo
echo "No secrets found in the client bundle."
