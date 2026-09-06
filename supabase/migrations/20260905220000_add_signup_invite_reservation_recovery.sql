alter table private.opusloops_signup_invites
  add column if not exists reserved_user_id uuid,
  add column if not exists completed_at timestamptz;

-- Claims created before deterministic reservations cannot be proven safe to
-- reuse. Preserve their finality and give them a non-reusable identity.
update private.opusloops_signup_invites
set reserved_user_id = pg_catalog.gen_random_uuid(),
    completed_at = coalesce(completed_at, consumed_at)
where consumed_at is not null
  and reserved_user_id is null;

alter table private.opusloops_signup_invites
  drop constraint if exists opusloops_signup_invites_completion_order;
alter table private.opusloops_signup_invites
  drop constraint if exists opusloops_signup_invites_reservation_state;
alter table private.opusloops_signup_invites
  add constraint opusloops_signup_invites_reservation_state
    check (
      (
        consumed_at is null
        and reserved_user_id is null
        and consumed_by is null
        and completed_at is null
      )
      or (
        consumed_at is not null
        and reserved_user_id is not null
        and (
          (completed_at is null and consumed_by is null)
          or (completed_at is not null and completed_at >= consumed_at)
        )
      )
    );

create unique index if not exists opusloops_signup_invites_reserved_user_id_key
  on private.opusloops_signup_invites (reserved_user_id)
  where reserved_user_id is not null;

drop function if exists public.claim_opusloops_signup_invite(text, text);
drop function if exists public.reserve_opusloops_signup_invite(text, text);
drop function if exists public.complete_opusloops_signup_invite(uuid, uuid);

create function public.reserve_opusloops_signup_invite(
  p_token_hash text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite_id uuid;
  v_user_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  update private.opusloops_signup_invites
  set consumed_at = coalesce(consumed_at, pg_catalog.statement_timestamp()),
      reserved_user_id = coalesce(reserved_user_id, pg_catalog.gen_random_uuid())
  where token_hash = p_token_hash
    and email_normalized = pg_catalog.lower(pg_catalog.btrim(p_email))
    and expires_at > pg_catalog.statement_timestamp()
    and completed_at is null
    and consumed_by is null
  returning id, reserved_user_id into v_invite_id, v_user_id;

  if v_invite_id is null or v_user_id is null then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'inviteId', v_invite_id,
    'userId', v_user_id
  );
end;
$$;

create function public.complete_opusloops_signup_invite(
  p_invite_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_reserved_user_id uuid;
  v_consumed_by uuid;
  v_completed_at timestamptz;
  v_user_matched boolean;
begin
  select email_normalized, reserved_user_id, consumed_by, completed_at
  into v_email, v_reserved_user_id, v_consumed_by, v_completed_at
  from private.opusloops_signup_invites
  where id = p_invite_id
    and consumed_at is not null
  for update;

  if not found or v_reserved_user_id is distinct from p_user_id then
    return false;
  end if;
  if (v_completed_at is null and v_consumed_by is not null)
     or (v_completed_at is not null and v_consumed_by is distinct from p_user_id) then
    return false;
  end if;

  update auth.users
  set raw_app_meta_data = (
        case
          when pg_catalog.jsonb_typeof(raw_app_meta_data) = 'object' then raw_app_meta_data
          else '{}'::jsonb
        end
      ) || pg_catalog.jsonb_build_object('opusloops', true),
      updated_at = pg_catalog.statement_timestamp()
  where id = p_user_id
    and pg_catalog.lower(pg_catalog.btrim(email)) = v_email
  returning true into v_user_matched;

  if not coalesce(v_user_matched, false) then
    return false;
  end if;

  if v_completed_at is null then
    update private.opusloops_signup_invites
    set consumed_by = p_user_id,
        completed_at = pg_catalog.statement_timestamp()
    where id = p_invite_id;
  end if;

  return true;
end;
$$;

create or replace function public.release_opusloops_signup_invite(p_invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released boolean;
begin
  update private.opusloops_signup_invites
  set consumed_at = null,
      reserved_user_id = null
  where id = p_invite_id
    and consumed_at is not null
    and completed_at is null
    and consumed_by is null
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

revoke all on function public.reserve_opusloops_signup_invite(text, text)
  from public, anon, authenticated;
revoke all on function public.complete_opusloops_signup_invite(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.release_opusloops_signup_invite(uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_opusloops_signup_invite(text, text)
  to service_role;
grant execute on function public.complete_opusloops_signup_invite(uuid, uuid)
  to service_role;
grant execute on function public.release_opusloops_signup_invite(uuid)
  to service_role;

comment on function public.reserve_opusloops_signup_invite(text, text) is
  'Atomically reserves one Opusloops invitation and deterministic Auth user ID; same-input retries return the same IDs.';
comment on function public.complete_opusloops_signup_invite(uuid, uuid) is
  'Atomically verifies the reserved Auth user and grants Opusloops membership while finalizing its invitation.';
comment on function public.release_opusloops_signup_invite(uuid) is
  'Explicitly releases an incomplete Opusloops invitation and its reserved user ID for service-side reconciliation.';
