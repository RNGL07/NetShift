-- ---------------------------------------------------------------------------
-- 0008 — Private document storage and full account deletion.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The documents bucket
--
-- Private, with a hard size cap and an allow-list of MIME types enforced by
-- Storage itself rather than only by the upload endpoint. Objects are laid out
-- as `<user_id>/<kind>/<uuid>.<ext>`, and every policy keys off that first
-- path segment — so one user's folder is unreachable from another's session
-- even if a path is guessed.
--
-- NetShift's default is to delete a source document as soon as extraction
-- succeeds. A document only persists when the user explicitly elects to keep it.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  10485760, -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "documents: owner can read own folder" on storage.objects;
create policy "documents: owner can read own folder"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "documents: owner can upload to own folder" on storage.objects;
create policy "documents: owner can upload to own folder"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "documents: owner can update own folder" on storage.objects;
create policy "documents: owner can update own folder"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "documents: owner can delete own folder" on storage.objects;
create policy "documents: owner can delete own folder"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Account deletion
--
-- Every user-owned table cascades from auth.users, so deleting the auth user
-- removes the rows. What does *not* cascade is Storage: objects would be left
-- orphaned in the bucket. This function deletes them first, then the auth user,
-- in one transaction.
--
-- It runs as the service role from `api/account/delete.ts` after the caller's
-- identity is verified — never from the browser.
-- ---------------------------------------------------------------------------

create or replace function public.delete_user_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_objects integer := 0;
  v_stubs integer := 0;
begin
  if p_user_id is null then
    raise exception 'delete_user_account requires a user id';
  end if;

  -- 1. Stored source documents.
  delete from storage.objects
   where bucket_id = 'documents'
     and (storage.foldername(name))[1] = p_user_id::text;
  get diagnostics v_objects = row_count;

  select count(*) into v_stubs from public.pay_stubs where user_id = p_user_id;

  -- 2. Detach the Stripe linkage before the cascade, so a late webhook for
  --    this customer cannot resurrect a row against a deleted user.
  update public.stripe_events set user_id = null where user_id = p_user_id;

  -- 3. The auth user. Everything user-owned cascades from here.
  delete from auth.users where id = p_user_id;

  return jsonb_build_object(
    'deleted', true,
    'storage_objects_removed', v_objects,
    'pay_stubs_removed', v_stubs
  );
end;
$$;

comment on function public.delete_user_account is
  'Deletes a user''s stored documents and then the auth user, which cascades to every owned row.';

revoke all on function public.delete_user_account(uuid) from public;
revoke all on function public.delete_user_account(uuid) from anon;
revoke all on function public.delete_user_account(uuid) from authenticated;
