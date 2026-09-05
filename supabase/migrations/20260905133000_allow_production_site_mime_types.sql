update storage.buckets
set allowed_mime_types = array[
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/manifest+json',
  'image/png',
  'image/svg+xml'
]
where id = 'opusloops-production';
