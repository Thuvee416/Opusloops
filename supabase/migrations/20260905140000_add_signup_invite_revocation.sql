create or replace function public.revoke_opusloops_signup_invite(p_invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  with removed as (
    delete from private.opusloops_signup_invites
    where id = p_invite_id
    returning true
  )
  select coalesce(pg_catalog.bool_or(true), false)
  into v_deleted
  from removed;

  return v_deleted;
end;
$$;

revoke all on function public.revoke_opusloops_signup_invite(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_opusloops_signup_invite(uuid)
  to service_role;

comment on function public.revoke_opusloops_signup_invite(uuid) is
  'Revokes or cleans up one Opusloops invitation; callable only with server credentials.';
