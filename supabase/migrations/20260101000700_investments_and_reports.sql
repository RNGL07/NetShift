-- ---------------------------------------------------------------------------
-- 0007 — Investments, the market-price cache, generated reports, and alerts.
-- ---------------------------------------------------------------------------

create table if not exists public.investment_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind public.investment_account_kind not null default 'brokerage',
  -- Used for cash-like accounts; holdings-based accounts leave it null.
  balance numeric(14, 2) check (balance is null or balance >= 0),
  institution text,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A cash account carries a balance; a holdings account does not.
  constraint investment_accounts_cash_has_balance
    check (kind <> 'cash' or balance is not null)
);

create index if not exists investment_accounts_user_idx
  on public.investment_accounts (user_id, sort_order) where archived_at is null;

drop trigger if exists investment_accounts_set_updated_at on public.investment_accounts;
create trigger investment_accounts_set_updated_at
  before update on public.investment_accounts
  for each row execute function public.set_updated_at();

create table if not exists public.holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references public.investment_accounts (id) on delete cascade,
  ticker text not null default '',
  -- For 401(k) funds with no exchange-traded symbol.
  name text,
  shares numeric(18, 6) not null default 0 check (shares >= 0),
  cost_basis numeric(14, 2) check (cost_basis is null or cost_basis >= 0),
  -- Always wins over a fetched price; the user knows their own fund.
  manual_price numeric(14, 4) check (manual_price is null or manual_price >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A holding needs something to identify it by.
  constraint holdings_needs_identifier
    check (length(trim(ticker)) > 0 or (name is not null and length(trim(name)) > 0))
);

create index if not exists holdings_account_idx on public.holdings (account_id, sort_order);
create index if not exists holdings_user_ticker_idx on public.holdings (user_id, ticker);

drop trigger if exists holdings_set_updated_at on public.holdings;
create trigger holdings_set_updated_at
  before update on public.holdings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- market_prices — a shared cache
--
-- Shared rather than per-user: VOO's closing price is the same for everyone,
-- and caching it once keeps NetShift well inside a free provider's limits.
-- Readable by any signed-in user, written only by the service role.
-- ---------------------------------------------------------------------------

create table if not exists public.market_prices (
  ticker text primary key,
  price numeric(14, 4) not null check (price >= 0),
  currency text not null default 'USD',
  source text not null default 'stooq',
  -- The trading day the price is for, which is not the same as when it was
  -- fetched — that distinction is what lets the UI say "Friday's close".
  as_of_date date,
  fetched_at timestamptz not null default now(),
  -- Set when a lookup failed, so a bad ticker is not retried on every load.
  last_error text,
  last_error_at timestamptz
);

comment on table public.market_prices is
  'Shared price cache from a non-LLM market-data source. Written only by the service role.';

create index if not exists market_prices_fetched_idx on public.market_prices (fetched_at desc);

-- ---------------------------------------------------------------------------
-- market_reports — AI-generated, Pro-only, clearly labelled as educational
-- ---------------------------------------------------------------------------

create table if not exists public.market_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  generated_at timestamptz not null default now(),
  as_of text,
  stock_market text,
  stocks_to_watch jsonb not null default '[]'::jsonb,
  housing_market text,
  commodities text,
  model text,
  -- Stored with the report so an old report cannot lose its disclaimer.
  disclaimer text not null default
    'Educational information only. This is not investment advice and not a recommendation to buy or sell anything.',
  created_at timestamptz not null default now(),
  constraint market_reports_watch_is_array check (jsonb_typeof(stocks_to_watch) = 'array')
);

create index if not exists market_reports_user_idx
  on public.market_reports (user_id, generated_at desc);

-- ---------------------------------------------------------------------------
-- ai_explanations — personalised paycheck explanations, Pro-only
-- ---------------------------------------------------------------------------

create table if not exists public.ai_explanations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  subject_kind text not null check (subject_kind in ('paycheck', 'audit', 'plan')),
  subject_id uuid,
  body text not null,
  model text,
  created_at timestamptz not null default now()
);

create index if not exists ai_explanations_user_subject_idx
  on public.ai_explanations (user_id, subject_kind, subject_id);

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payday_reminder boolean not null default true,
  audit_findings boolean not null default true,
  goal_milestones boolean not null default true,
  buffer_warnings boolean not null default true,
  product_updates boolean not null default false,
  channel text not null default 'in_app' check (channel in ('in_app', 'email', 'both', 'none')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.investment_accounts enable row level security;
alter table public.holdings enable row level security;
alter table public.market_prices enable row level security;
alter table public.market_reports enable row level security;
alter table public.ai_explanations enable row level security;
alter table public.notification_preferences enable row level security;

drop policy if exists "investment_accounts: owner all" on public.investment_accounts;
create policy "investment_accounts: owner all"
  on public.investment_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "holdings: owner all" on public.holdings;
create policy "holdings: owner all"
  on public.holdings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Shared reference data: read for everyone signed in, writes service-role only.
drop policy if exists "market_prices: signed-in users can read" on public.market_prices;
create policy "market_prices: signed-in users can read"
  on public.market_prices for select
  to authenticated
  using (true);

drop policy if exists "market_reports: owner all" on public.market_reports;
create policy "market_reports: owner all"
  on public.market_reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "ai_explanations: owner can read" on public.ai_explanations;
create policy "ai_explanations: owner can read"
  on public.ai_explanations
  for select using (auth.uid() = user_id);
drop policy if exists "ai_explanations: owner can delete" on public.ai_explanations;
create policy "ai_explanations: owner can delete"
  on public.ai_explanations
  for delete using (auth.uid() = user_id);
-- Inserts are service-role only, so an explanation always corresponds to a
-- real, entitlement-checked AI call.

drop policy if exists "notification_preferences: owner all" on public.notification_preferences;
create policy "notification_preferences: owner all"
  on public.notification_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
