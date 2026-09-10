-- Run ONLY through the account-bound operator against the original dedicated
-- Opusloops project. Reversible write fence; it does not delete any source data.
begin;
select pg_advisory_xact_lock(hashtextextended('opusloops-aws-cutover',0));
create table if not exists private.opusloops_aws_cutover (
  singleton boolean primary key default true check(singleton),
  frozen boolean not null default false,
  changed_at timestamptz not null default now()
);
revoke all on private.opusloops_aws_cutover from public,anon,authenticated,service_role;
insert into private.opusloops_aws_cutover(singleton) values(true) on conflict do nothing;

create or replace function private.opusloops_aws_write_fence()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from private.opusloops_aws_cutover where singleton and frozen) then
    raise exception using errcode='55000',message='Opusloops is moving to AWS. Refresh the app and sign in again shortly.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.opusloops_aws_write_fence() from public,anon,authenticated,service_role;

-- Acquire locks before checking for active work. No upload, save, callback, or
-- identity mutation can race between the maintenance fence and final snapshot.
lock table auth.users,public.projects,public.stem_import_jobs,public.stem_import_assets,
  public.stem_import_events,private.opusloops_signup_invites,private.stem_job_attempts,
  private.stem_worker_nonces,private.stem_retention_items,private.stem_retention_scopes,
  storage.objects in share row exclusive mode;
do $$
declare target text;
begin
  if exists(select 1 from public.stem_import_jobs where status not in ('ready','failed','cancelled','deleted')) then
    raise exception 'Active stem work must finish before the migration fence';
  end if;
  foreach target in array array['auth.users','public.projects','public.stem_import_jobs','public.stem_import_assets',
    'public.stem_import_events','private.opusloops_signup_invites','private.stem_job_attempts',
    'private.stem_worker_nonces','private.stem_retention_items','private.stem_retention_scopes','storage.objects']
  loop
    execute format('drop trigger if exists opusloops_aws_write_fence on %s',target);
    execute format('create trigger opusloops_aws_write_fence before insert or update or delete on %s for each row execute function private.opusloops_aws_write_fence()',target);
  end loop;
end;
$$;
update private.opusloops_aws_cutover set frozen=true,changed_at=now() where singleton;
commit;
