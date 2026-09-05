begin;

select '1..6';

do $$
declare
  v_invites_table oid;
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private'
      and c.relname = 'opusloops_signup_invites'
      and c.relrowsecurity
  ) then
    raise exception 'private.opusloops_signup_invites must have row level security enabled';
  end if;

  select c.oid into v_invites_table
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private'
    and c.relname = 'opusloops_signup_invites';

  if has_schema_privilege('anon', 'private', 'USAGE')
     or has_schema_privilege('authenticated', 'private', 'USAGE')
     or has_table_privilege('anon', v_invites_table, 'SELECT')
     or has_table_privilege('authenticated', v_invites_table, 'SELECT') then
    raise exception 'browser roles must not inspect the private invitation store';
  end if;
end;
$$;

select 'ok 1 - invitation hashes are private and protected by RLS';

do $$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'public.claim_opusloops_signup_invite(text,text)',
    'public.complete_opusloops_signup_invite(uuid,uuid)',
    'public.issue_opusloops_signup_invite(text,text,timestamp with time zone)',
    'public.revoke_opusloops_signup_invite(uuid)'
  ] loop
    if has_function_privilege('anon', function_signature, 'EXECUTE')
       or has_function_privilege('authenticated', function_signature, 'EXECUTE')
       or not has_function_privilege('service_role', function_signature, 'EXECUTE') then
      raise exception '% must be executable only by service_role', function_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'claim_opusloops_signup_invite',
        'complete_opusloops_signup_invite',
        'issue_opusloops_signup_invite',
        'revoke_opusloops_signup_invite'
      )
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=""%')
  ) then
    raise exception 'invitation functions must be SECURITY DEFINER with an empty search path';
  end if;
end;
$$;

select 'ok 2 - invitation functions are service-role-only and hardened';

set local role service_role;

do $$
declare
  v_id uuid;
  v_claim uuid;
begin
  v_id := public.issue_opusloops_signup_invite(
    ' Invite.Test@Example.com ',
    repeat('a', 64),
    statement_timestamp() + interval '1 hour'
  );

  v_claim := public.claim_opusloops_signup_invite(repeat('a', 64), 'other@example.com');
  if v_claim is not null then
    raise exception 'an invitation was accepted for the wrong email';
  end if;

  v_claim := public.claim_opusloops_signup_invite(repeat('a', 64), 'invite.test@example.com');
  if v_claim is distinct from v_id then
    raise exception 'the valid email-bound invitation was not claimed';
  end if;

  if public.claim_opusloops_signup_invite(repeat('a', 64), 'invite.test@example.com') is not null then
    raise exception 'a consumed invitation was replayed';
  end if;
end;
$$;

reset role;
select 'ok 3 - invitations are email-bound and single-use';

set local role service_role;

do $$
begin
  perform public.issue_opusloops_signup_invite(
    'expired@example.com',
    repeat('b', 64),
    statement_timestamp() + interval '100 milliseconds'
  );
end;
$$;

reset role;
select pg_catalog.pg_sleep(0.2);
set local role service_role;

do $$
begin
  if public.claim_opusloops_signup_invite(repeat('b', 64), 'expired@example.com') is not null then
    raise exception 'an expired invitation was accepted';
  end if;
end;
$$;

reset role;
select 'ok 4 - expired invitations cannot be claimed';

set local role service_role;

do $$
begin
  perform public.issue_opusloops_signup_invite(
    'not-an-email',
    repeat('c', 64),
    statement_timestamp() + interval '1 hour'
  );
  raise exception 'invalid invitation fields were accepted';
exception
  when invalid_parameter_value then null;
end;
$$;

reset role;
select 'ok 5 - invalid invitation fields are rejected';

set local role service_role;

do $$
declare
  v_id uuid;
begin
  v_id := public.issue_opusloops_signup_invite(
    'revoked@example.com',
    repeat('d', 64),
    statement_timestamp() + interval '1 hour'
  );
  if not public.revoke_opusloops_signup_invite(v_id) then
    raise exception 'an existing invitation could not be revoked';
  end if;
  if public.revoke_opusloops_signup_invite(v_id) then
    raise exception 'revoking an absent invitation reported success';
  end if;
  if public.claim_opusloops_signup_invite(repeat('d', 64), 'revoked@example.com') is not null then
    raise exception 'a revoked invitation was claimed';
  end if;
end;
$$;

reset role;
select 'ok 6 - revoked invitations cannot be used';

rollback;
