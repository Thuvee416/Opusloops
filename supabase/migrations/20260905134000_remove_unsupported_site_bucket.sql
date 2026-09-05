set storage.allow_delete_query = 'true';

delete from storage.buckets
where id = 'opusloops-production';

reset storage.allow_delete_query;
