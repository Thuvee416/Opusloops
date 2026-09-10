create table private.aws_migration_state (
  singleton boolean primary key default true check(singleton),
  live_at timestamptz
);
insert into private.aws_migration_state(singleton) values(true);

create table private.aws_multipart_uploads (
  user_id uuid not null,
  job_id uuid not null,
  upload_id text not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(user_id,job_id),
  foreign key(user_id,job_id) references public.stem_import_jobs(user_id,id) on delete cascade
);
alter table private.aws_multipart_uploads enable row level security;
grant usage on schema private to service_role;
grant select,insert,update on private.aws_multipart_uploads to service_role;
create policy aws_multipart_service on private.aws_multipart_uploads to service_role using(true) with check(true);
