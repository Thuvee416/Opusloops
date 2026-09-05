create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.opusloops_signup_invites (
  id uuid primary key default gen_random_uuid(),
  email_normalized text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint opusloops_signup_invites_email_normalized
    check (
      email_normalized = lower(btrim(email_normalized))
      and char_length(email_normalized) between 3 and 254
    ),
  constraint opusloops_signup_invites_token_hash
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint opusloops_signup_invites_expiry
    check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint opusloops_signup_invites_consumed_order
    check (consumed_at is null or consumed_at >= created_at)
);

alter table private.opusloops_signup_invites enable row level security;
revoke all on table private.opusloops_signup_invites from public, anon, authenticated;

create or replace function public.claim_opusloops_signup_invite(
  p_token_hash text,
  p_email text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  update private.opusloops_signup_invites
  set consumed_at = pg_catalog.statement_timestamp()
  where token_hash = p_token_hash
    and email_normalized = pg_catalog.lower(pg_catalog.btrim(p_email))
    and consumed_at is null
    and expires_at > pg_catalog.statement_timestamp()
  returning id into v_invite_id;

  return v_invite_id;
end;
$$;

create or replace function public.complete_opusloops_signup_invite(
  p_invite_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.opusloops_signup_invites
  set consumed_by = p_user_id
  where id = p_invite_id
    and consumed_at is not null
    and consumed_by is null;
end;
$$;

revoke all on function public.claim_opusloops_signup_invite(text, text) from public, anon, authenticated;
revoke all on function public.complete_opusloops_signup_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_opusloops_signup_invite(text, text) to service_role;
grant execute on function public.complete_opusloops_signup_invite(uuid, uuid) to service_role;

comment on table private.opusloops_signup_invites is
  'Email-bound, single-use invitation hashes for early-access account creation.';
comment on function public.claim_opusloops_signup_invite(text, text) is
  'Atomically consumes one unexpired email-bound Opusloops invitation.';
