-- ---------------------------------------------------------------------------
-- A minimal stand-in for the parts of a Supabase database that the migrations
-- depend on: the `auth` and `storage` schemas, the three PostgREST roles, and
-- `auth.uid()`.
--
-- This is for local testing only and is never applied to a real project — a
-- Supabase database already provides all of it. Its purpose is to make
-- `scripts/db-test.sh` able to run the real migrations and the real RLS
-- policies on a plain PostgreSQL, so the policies are executed rather than
-- merely eyeballed.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create schema if not exists storage;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- PostgREST sets `request.jwt.claim.sub` to the signed-in user's id. Reading it
-- with `true` for missing_ok is what makes the function return null (rather
-- than error) for an anonymous request.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

-- Returns the directory components of an object path, so a policy can compare
-- the first segment against auth.uid().
create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end;
$$;

grant usage on schema public, auth, storage to anon, authenticated, service_role;
