begin;

-- A newly authenticated Cognito subject never becomes a legacy owner merely
-- because it has the same email. The migration/admin API must bind it explicitly.
insert into auth.users (id, provider_subject, email, raw_app_meta_data)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'cognito-subject-a', 'fixture@example.invalid', '{"opusloops":true}');

do $$
begin
  if exists (select 1 from pg_roles where rolname in ('anon','authenticated','service_role') and (rolsuper or rolbypassrls or rolcanlogin)) then
    raise exception 'runtime roles gained login or RLS bypass';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name in ('encrypted_password','refresh_token')) then
    raise exception 'credentials must remain with Cognito, not the app registry';
  end if;
  begin
    insert into auth.users (id, provider_subject) values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'cognito-subject-a');
    raise exception 'one Cognito subject acquired multiple legacy identities';
  exception when unique_violation then null;
  end;
end;
$$;

set local role authenticated;
do $$
begin
  begin
    update auth.users set provider_subject='attacker', raw_app_meta_data='{"opusloops":true}';
    raise exception 'browser role could change identity binding or membership';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from auth.users;
    raise exception 'browser role could enumerate accounts';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$
begin
  if (select count(*) from auth.users where provider_subject='cognito-subject-a') <> 1 then
    raise exception 'trusted API could not resolve Cognito identity';
  end if;
end;
$$;
reset role;

select 'ok - native identity registry preserves owner IDs and isolates credentials';
rollback;
