begin;

select '1..10';

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
    'public.reserve_opusloops_signup_invite(text,text)',
    'public.complete_opusloops_signup_invite(uuid,uuid)',
    'public.release_opusloops_signup_invite(uuid)',
    'public.issue_opusloops_signup_invite(text,text,timestamp with time zone)',
    'public.revoke_opusloops_signup_invite(uuid)'
  ] loop
    if has_function_privilege('anon', function_signature, 'EXECUTE')
       or has_function_privilege('authenticated', function_signature, 'EXECUTE')
       or not has_function_privilege('service_role', function_signature, 'EXECUTE') then
      raise exception '% must be executable only by service_role', function_signature;
    end if;
  end loop;

  if to_regprocedure('public.claim_opusloops_signup_invite(text,text)') is not null then
    raise exception 'the non-resumable claim function must not remain callable';
  end if;
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'private'
      and tablename = 'opusloops_signup_invites'
      and indexname = 'opusloops_signup_invites_reserved_user_id_key'
      and indexdef like 'CREATE UNIQUE INDEX%WHERE (reserved_user_id IS NOT NULL)'
  ) then
    raise exception 'reserved user IDs need a partial uniqueness invariant';
  end if;
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'reserve_opusloops_signup_invite',
        'complete_opusloops_signup_invite',
        'release_opusloops_signup_invite',
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
  v_first jsonb;
  v_retry jsonb;
begin
  v_id := public.issue_opusloops_signup_invite(
    ' Invite.Test@Example.com ',
    repeat('a', 64),
    statement_timestamp() + interval '1 hour'
  );

  if public.reserve_opusloops_signup_invite(
    repeat('a', 64),
    'other@example.com'
  ) is not null then
    raise exception 'an invitation was accepted for the wrong email';
  end if;

  v_first := public.reserve_opusloops_signup_invite(
    repeat('a', 64),
    'invite.test@example.com'
  );
  v_retry := public.reserve_opusloops_signup_invite(
    repeat('a', 64),
    'invite.test@example.com'
  );
  if (v_first ->> 'inviteId')::uuid is distinct from v_id
     or (v_first ->> 'userId')::uuid is null
     or v_retry is distinct from v_first then
    raise exception 'same-input retries did not preserve deterministic reservation IDs';
  end if;
end;
$$;

reset role;
select 'ok 3 - email-bound reservations are deterministic across serialized retries';

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
  if public.reserve_opusloops_signup_invite(
    repeat('b', 64),
    'expired@example.com'
  ) is not null then
    raise exception 'an expired invitation was accepted';
  end if;
end;
$$;

reset role;
select 'ok 4 - expired invitations cannot be reserved';

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
  if public.reserve_opusloops_signup_invite(
    repeat('d', 64),
    'revoked@example.com'
  ) is not null then
    raise exception 'a revoked invitation was reserved';
  end if;
end;
$$;

reset role;
select 'ok 6 - revoked invitations cannot be used';

set local role service_role;

do $$
declare
  v_id uuid;
  v_first jsonb;
  v_second jsonb;
begin
  v_id := public.issue_opusloops_signup_invite(
    'retry@example.com',
    repeat('e', 64),
    statement_timestamp() + interval '1 hour'
  );
  v_first := public.reserve_opusloops_signup_invite(
    repeat('e', 64),
    'retry@example.com'
  );
  if not public.release_opusloops_signup_invite(v_id) then
    raise exception 'an incomplete invitation reservation was not released';
  end if;
  if public.release_opusloops_signup_invite(v_id) then
    raise exception 'an unclaimed invitation reported a release';
  end if;
  v_second := public.reserve_opusloops_signup_invite(
    repeat('e', 64),
    'retry@example.com'
  );
  if (v_second ->> 'inviteId')::uuid is distinct from v_id
     or (v_second ->> 'userId') is not distinct from (v_first ->> 'userId') then
    raise exception 'release did not clear and replace the reserved user ID';
  end if;
end;
$$;

reset role;
select 'ok 7 - explicit release clears the prior reserved user ID';

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'Complete@Example.com',
  '{"preserved":true}'::jsonb,
  '{}'::jsonb
);

insert into private.opusloops_signup_invites (
  id,
  email_normalized,
  token_hash,
  expires_at,
  consumed_at,
  reserved_user_id
) values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  'complete@example.com',
  repeat('f', 64),
  statement_timestamp() + interval '1 hour',
  statement_timestamp(),
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);

set local role service_role;

do $$
begin
  if not public.complete_opusloops_signup_invite(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) then
    raise exception 'a matching reserved Auth user was not completed';
  end if;
  if not public.complete_opusloops_signup_invite(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) then
    raise exception 'repeating the same completion was not idempotent';
  end if;
  if public.reserve_opusloops_signup_invite(
    repeat('f', 64),
    'complete@example.com'
  ) is not null then
    raise exception 'a completed invitation was reserved again';
  end if;
end;
$$;

reset role;

do $$
begin
  if not exists (
    select 1
    from auth.users
    where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and raw_app_meta_data @> '{"preserved":true,"opusloops":true}'::jsonb
  ) or not exists (
    select 1
    from private.opusloops_signup_invites
    where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      and reserved_user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and consumed_by = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and completed_at is not null
  ) then
    raise exception 'completion did not atomically grant membership and finalize the invite';
  end if;
end;
$$;

select 'ok 8 - completion atomically grants membership and is idempotent';

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data
) values (
  '77777777-7777-4777-8777-777777777777',
  'different@example.com',
  '{}'::jsonb,
  '{}'::jsonb
);

insert into private.opusloops_signup_invites (
  id,
  email_normalized,
  token_hash,
  expires_at,
  consumed_at,
  reserved_user_id
) values (
  '88888888-8888-4888-8888-888888888888',
  'bound@example.com',
  repeat('8', 64),
  statement_timestamp() + interval '1 hour',
  statement_timestamp(),
  '77777777-7777-4777-8777-777777777777'
);

set local role service_role;

do $$
begin
  if public.complete_opusloops_signup_invite(
    '88888888-8888-4888-8888-888888888888',
    '77777777-7777-4777-8777-777777777777'
  ) then
    raise exception 'completion accepted an Auth user with the wrong email';
  end if;
end;
$$;

reset role;

do $$
begin
  if exists (
    select 1
    from auth.users
    where id = '77777777-7777-4777-8777-777777777777'
      and raw_app_meta_data @> '{"opusloops":true}'::jsonb
  ) or exists (
    select 1
    from private.opusloops_signup_invites
    where id = '88888888-8888-4888-8888-888888888888'
      and completed_at is not null
  ) then
    raise exception 'failed completion left membership or finalization side effects';
  end if;
end;
$$;

select 'ok 9 - completion requires exact reserved user and normalized email';

delete from auth.users where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
set local role service_role;

do $$
begin
  if public.release_opusloops_signup_invite(
    'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) then
    raise exception 'deleting the completed Auth user made its invitation releasable';
  end if;
  if public.reserve_opusloops_signup_invite(
    repeat('f', 64),
    'complete@example.com'
  ) is not null then
    raise exception 'deleting the completed Auth user made its invitation reusable';
  end if;
end;
$$;

reset role;
select 'ok 10 - completed invitations remain final after Auth user deletion';

rollback;
