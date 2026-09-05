insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'opusloops-production',
  'opusloops-production',
  true,
  5242880,
  array[
    'text/html',
    'text/css',
    'application/javascript',
    'application/manifest+json',
    'image/png'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
