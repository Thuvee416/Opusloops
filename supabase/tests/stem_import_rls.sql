begin;

select '1..8';

do $$
declare
  v_table text;
begin
  foreach v_table in array array['stem_import_jobs', 'stem_import_assets', 'stem_import_events'] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity
    ) then
      raise exception 'public.% must have RLS enabled', v_table;
    end if;
  end loop;
end;
$$;

select 'ok 1 - all public stem tables have RLS enabled';

do $$
declare
  v_bucket record;
begin
  for v_bucket in
    select id, public, file_size_limit from storage.buckets
    where id in ('opusloops-stem-uploads', 'opusloops-stem-sources', 'opusloops-stem-artifacts')
  loop
    if v_bucket.public or v_bucket.file_size_limit is null then
      raise exception 'stem bucket % is public or unlimited', v_bucket.id;
    end if;
  end loop;
  if (select count(*) from storage.buckets where id like 'opusloops-stem-%') <> 3 then
    raise exception 'expected exactly three managed stem buckets';
  end if;
  if (select file_size_limit from storage.buckets where id = 'opusloops-stem-uploads') <> 2147483648 then
    raise exception 'upload bucket must have the 2 GiB policy ceiling';
  end if;
end;
$$;

select 'ok 2 - three private stem buckets have explicit size ceilings';

do $$
declare
  v_table text;
begin
  foreach v_table in array array['stem_import_jobs', 'stem_import_assets', 'stem_import_events'] loop
    if has_table_privilege('anon', 'public.' || v_table, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || v_table, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || v_table, 'DELETE') then
      raise exception 'unsafe browser privilege on public.%', v_table;
    end if;
    if not has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') then
      raise exception 'authenticated lacks SELECT on public.%', v_table;
    end if;
  end loop;
end;
$$;

select 'ok 3 - browser roles are read-only and anonymous has no stem access';

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.create_stem_import(uuid,uuid,text,bigint,text)',
    'public.finalize_stem_upload(uuid,uuid,bigint,bigint,text)',
    'public.get_stem_job_for_finalize(uuid,uuid)',
    'public.get_stem_inspection_retry_source(uuid,uuid,bigint)',
    'public.retry_stem_inspection(uuid,uuid,bigint,bigint,text)',
    'public.retry_stem_proposal(uuid,uuid,bigint)',
    'public.repair_stem_render_proposal(uuid,uuid,bigint,text)',
    'public.retry_stem_render(uuid,uuid,bigint,text,text)',
    'public.approve_stem_analysis(uuid,uuid,bigint,text,jsonb,boolean,boolean,boolean,boolean)',
    'public.request_stem_proposal(uuid,uuid,bigint,text,text,numeric,text,jsonb,integer,integer,numeric)',
    'public.approve_stem_tempo(uuid,uuid,bigint,text,jsonb,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean)',
    'public.cancel_stem_import(uuid,uuid,bigint)',
    'public.get_stem_dispatch_payload(uuid,uuid)',
    'public.claim_stem_dispatch(uuid,uuid,uuid)',
    'public.get_stem_job_for_dispatch(uuid,uuid)',
    'public.record_stem_dispatch_unknown(uuid,uuid)',
    'public.get_stem_asset_for_signing(uuid,uuid,uuid)',
    'public.apply_stem_worker_callback(uuid,text,jsonb)',
    'public.claim_stem_retention(uuid,integer)',
    'public.complete_stem_retention_item(uuid,uuid)',
    'public.fail_stem_retention_item(uuid,uuid,text)'
  ] loop
    if has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception '% must be service-role-only', v_signature;
    end if;
  end loop;
  foreach v_signature in array array[
    'public.finalize_stem_upload_unchecked(uuid,uuid,bigint,bigint,text)',
    'public.apply_stem_worker_callback_unchecked(uuid,text,jsonb)',
    'private.opusloops_stem_retryable_inspection_job(uuid,uuid,bigint)'
  ] loop
    if has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception '% must be callable only by its owning wrapper', v_signature;
    end if;
  end loop;
end;
$$;

select 'ok 4 - stem mutation and signing RPCs are service-role-only';

do $$
begin
  if has_schema_privilege('anon', 'private', 'USAGE')
     or has_schema_privilege('authenticated', 'private', 'USAGE')
     or has_table_privilege('anon', 'private.stem_job_attempts', 'SELECT')
     or has_table_privilege('authenticated', 'private.stem_job_attempts', 'SELECT')
     or has_table_privilege('anon', 'private.stem_worker_nonces', 'SELECT')
     or has_table_privilege('authenticated', 'private.stem_worker_nonces', 'SELECT')
     or has_table_privilege('anon', 'private.stem_retention_items', 'SELECT')
     or has_table_privilege('authenticated', 'private.stem_retention_items', 'SELECT')
     or has_table_privilege('anon', 'private.stem_retention_scopes', 'SELECT')
     or has_table_privilege('authenticated', 'private.stem_retention_scopes', 'SELECT') then
    raise exception 'browser roles can inspect private worker state';
  end if;
end;
$$;

select 'ok 5 - attempts and callback nonces are private';

do $$
declare
  v_commands text[];
begin
  select array_agg(cmd order by cmd) into v_commands
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'Opusloops members can % stem %';
  if v_commands is distinct from array['INSERT', 'SELECT']::text[] then
    raise exception 'unexpected stem storage policies: %', v_commands;
  end if;
  if (select count(*) from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname = 'Opusloops workers can publish active stem objects'
        and cmd = 'INSERT') <> 1
     or exists (
       select 1 from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname like 'Opusloops%stem%'
         and cmd in ('UPDATE', 'DELETE')
     ) then
    raise exception 'worker Storage policy is not insert-only';
  end if;
end;
$$;

select 'ok 6 - storage grants only allocated upload, active worker insert, and owned reads';

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname like '%stem%')
      and p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=""%'
  ) then
    raise exception 'a public SECURITY DEFINER stem function lacks an empty search_path';
  end if;
end;
$$;

select 'ok 7 - public stem SECURITY DEFINER functions pin an empty search path';

do $$
declare
  v_signature text := 'public.get_stem_import_event_snapshot(uuid,bigint)';
begin
  if not has_function_privilege('authenticated', v_signature, 'EXECUTE')
     or has_function_privilege('anon', v_signature, 'EXECUTE')
     or has_function_privilege('service_role', v_signature, 'EXECUTE')
     or exists (
       select 1
       from pg_proc as procedure
       join pg_namespace as namespace on namespace.oid = procedure.pronamespace
       where namespace.nspname = 'public'
         and procedure.proname = 'get_stem_import_event_snapshot'
         and procedure.prosecdef
     ) then
    raise exception '% must be authenticated-only and SECURITY INVOKER', v_signature;
  end if;
end;
$$;

select 'ok 8 - atomic stem snapshots are authenticated-only and run as the caller';

rollback;
