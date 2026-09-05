alter function public.sync_projects(jsonb) set schema private;
alter function private.sync_projects(jsonb) rename to sync_projects_unchecked;

revoke all on function private.sync_projects_unchecked(jsonb)
  from public, anon, authenticated;

create function public.sync_projects(p_changes jsonb default '[]'::jsonb)
returns setof public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
begin
  if auth.uid() is null
     or coalesce((v_claims -> 'app_metadata' ->> 'opusloops')::boolean, false) is not true then
    raise exception using errcode = '42501', message = 'Opusloops account required';
  end if;

  return query
    select * from private.sync_projects_unchecked(p_changes);
end;
$$;

comment on function public.sync_projects(jsonb) is
  'Reconciles an invited Opusloops user project snapshot through the private atomic sync implementation.';

revoke all on function public.sync_projects(jsonb) from public, anon;
grant execute on function public.sync_projects(jsonb) to authenticated;
