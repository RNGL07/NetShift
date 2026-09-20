-- ---------------------------------------------------------------------------
-- 0009 — The legacy `netshift_data` key/value table and its migration path.
--
-- The prototype stored everything as JSON strings under a handful of keys:
--   paycheck-stubs, pay-ladder, pay-premiums, invest-accounts,
--   invest-live-prices, market-reports
-- Rather than drop that, this migration guarantees the table exists with
-- correct RLS, and adds a read-only view that the application's import flow
-- consumes. The table is never written to again by NetShift 2.x — it is kept
-- so existing users' data survives the upgrade, and is only removed once
-- `profiles.legacy_import_status` is no longer 'pending' for anyone.
--
-- Deliberately *not* done here: a bulk server-side transform. The legacy blobs
-- are unvalidated JSON typed by hand into a prototype; silently reshaping them
-- into the structured tables risks writing wrong financial figures a user
-- never sees. Instead the import runs client-side, shows the user exactly what
-- will be created, and writes only what they confirm.
-- ---------------------------------------------------------------------------

create table if not exists public.netshift_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

comment on table public.netshift_data is
  'Legacy key/value store from NetShift 1.x. Read-only in 2.x; retained until every user has run the import.';

create index if not exists netshift_data_user_idx on public.netshift_data (user_id);

drop trigger if exists netshift_data_set_updated_at on public.netshift_data;
create trigger netshift_data_set_updated_at
  before update on public.netshift_data
  for each row execute function public.set_updated_at();

alter table public.netshift_data enable row level security;

-- A 1.x database may already carry a permissive policy under this name.
drop policy if exists "netshift_data: owner all" on public.netshift_data;

-- Read and delete only. 2.x never writes here, and removing the write policy
-- makes that a property of the database rather than a convention.
drop policy if exists "netshift_data: owner can read" on public.netshift_data;
create policy "netshift_data: owner can read"
  on public.netshift_data for select
  using (auth.uid() = user_id);

drop policy if exists "netshift_data: owner can delete" on public.netshift_data;
create policy "netshift_data: owner can delete"
  on public.netshift_data for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- A summary the import screen can show before anything is written.
--
-- The legacy blobs were written by a prototype and are not guaranteed to be
-- valid JSON, so the item count goes through a function that catches a parse
-- failure rather than letting one malformed row fail the whole query.
-- ---------------------------------------------------------------------------

create or replace function public.safe_json_item_count(p_value text)
returns integer
language plpgsql
immutable
as $$
declare
  v_json jsonb;
begin
  if p_value is null or btrim(p_value) = '' then
    return 0;
  end if;
  begin
    v_json := p_value::jsonb;
  exception when others then
    return 0;
  end;
  if jsonb_typeof(v_json) = 'array' then
    return jsonb_array_length(v_json);
  end if;
  return 1;
end;
$$;

comment on function public.safe_json_item_count is
  'Counts items in a legacy JSON blob, returning 0 rather than raising on malformed input.';

create or replace view public.legacy_data_summary
with (security_invoker = true)
as
select
  d.user_id,
  d.key,
  length(coalesce(d.value, '')) as value_length,
  public.safe_json_item_count(d.value) as item_count,
  d.updated_at
from public.netshift_data d
where d.value is not null and d.value <> '';

comment on view public.legacy_data_summary is
  'Per-key summary of a user''s legacy data. security_invoker means it is subject to the caller''s RLS.';
