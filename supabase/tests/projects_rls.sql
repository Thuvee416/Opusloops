begin;

select '1..1';

do $$
declare
  expected_policies text[] := array['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
  actual_policies text[];
  v_internal_function oid;
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'projects'
      and c.relrowsecurity
  ) then
    raise exception 'public.projects must have row level security enabled';
  end if;

  select array_agg(cmd order by cmd)
  into actual_policies
  from pg_policies
  where schemaname = 'public'
    and tablename = 'projects'
    and roles = array['authenticated']::name[];

  if actual_policies is distinct from expected_policies then
    raise exception 'public.projects policies were %, expected %', actual_policies, expected_policies;
  end if;

  if has_table_privilege('anon', 'public.projects', 'SELECT')
     or has_table_privilege('anon', 'public.projects', 'INSERT')
     or has_table_privilege('anon', 'public.projects', 'UPDATE')
     or has_table_privilege('anon', 'public.projects', 'DELETE') then
    raise exception 'anon must not have project table privileges';
  end if;

  if has_table_privilege('authenticated', 'public.projects', 'SELECT')
     or has_table_privilege('authenticated', 'public.projects', 'INSERT')
     or has_table_privilege('authenticated', 'public.projects', 'UPDATE')
     or has_table_privilege('authenticated', 'public.projects', 'DELETE') then
    raise exception 'authenticated must use the atomic sync function, not direct table DML';
  end if;

  if not has_function_privilege('authenticated', 'public.sync_projects(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.sync_projects(jsonb)', 'EXECUTE') then
    raise exception 'sync_projects execution privilege must be authenticated-only';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'sync_projects'
      and p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
  ) then
    raise exception 'sync_projects must be SECURITY DEFINER with an empty search_path';
  end if;

  select p.oid into v_internal_function
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname = 'sync_projects_unchecked'
    and pg_get_function_identity_arguments(p.oid) = 'p_changes jsonb';

  if has_function_privilege('authenticated', v_internal_function, 'EXECUTE')
     or has_schema_privilege('authenticated', 'private', 'USAGE') then
    raise exception 'the unchecked sync implementation must remain private';
  end if;
end;
$$;

select 'ok 1 - projects RLS and atomic RPC privileges are correctly configured';

rollback;
