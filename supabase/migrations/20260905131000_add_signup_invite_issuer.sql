create or replace function public.issue_opusloops_signup_invite(
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_invite_id uuid;
begin
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(v_email) > 254
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at <= pg_catalog.statement_timestamp()
     or p_expires_at > pg_catalog.statement_timestamp() + interval '30 days' then
    raise exception using errcode = '22023', message = 'Invalid invitation fields';
  end if;

  insert into private.opusloops_signup_invites (
    email_normalized,
    token_hash,
    expires_at
  ) values (
    v_email,
    p_token_hash,
    p_expires_at
  )
  returning id into v_invite_id;

  return v_invite_id;
end;
$$;

revoke all on function public.issue_opusloops_signup_invite(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.issue_opusloops_signup_invite(text, text, timestamptz)
  to service_role;

comment on function public.issue_opusloops_signup_invite(text, text, timestamptz) is
  'Issues an email-bound Opusloops invitation; callable only with server credentials.';
