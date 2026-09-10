do $$
declare denied boolean := false;
begin
  begin
    insert into auth.users(id,email) values('deadbeef-0000-4000-8000-000000000001','test@example.invalid');
  exception when sqlstate '55000' then denied := true;
  end;
  if not denied then raise exception 'Frozen source accepted an identity write'; end if;
end;
$$;
select 'ok - source fence rejects writes';
update private.opusloops_aws_cutover set frozen=false where singleton;
insert into auth.users(id,email) values('deadbeef-0000-4000-8000-000000000001','test@example.invalid');
delete from auth.users where id='deadbeef-0000-4000-8000-000000000001';
select 'ok - source write fence can be rolled back without restoring or deleting data';
