import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { readFileSync } from 'node:fs';

// This Lambda has NO public URL/API integration. Only the AWS application role
// may invoke it. Cognito verification happens in that API, not in browser input.
const CLIENT_RPCS = new Set(['sync_projects', 'get_stem_import_event_snapshot']);
const SERVICE_RPCS = new Set([
  'reserve_opusloops_signup_invite', 'complete_opusloops_signup_invite',
  'create_stem_import', 'finalize_stem_upload', 'get_stem_job_for_finalize',
  'get_stem_inspection_retry_source', 'retry_stem_inspection', 'retry_stem_proposal',
  'repair_stem_render_proposal', 'retry_stem_render', 'approve_stem_analysis',
  'request_stem_proposal', 'approve_stem_tempo', 'cancel_stem_import',
  'get_stem_job_for_dispatch', 'claim_stem_dispatch', 'record_stem_dispatch',
  'record_stem_dispatch_error', 'record_stem_dispatch_unknown', 'get_stem_asset_for_signing',
  'apply_stem_worker_callback', 'claim_stem_retention', 'complete_stem_retention_item', 'fail_stem_retention_item',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code = '22023') => { throw Object.assign(new Error(message), { code }); };
let pool;
function databasePool() {
  if (!pool) {
    const host = process.env.DATABASE_HOST;
    if (!/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(host || '')) fail('Database host is not configured');
    const signer = new Signer({ hostname: host, port: 5432, username: 'opusloops_api', region: process.env.AWS_REGION });
    pool = new pg.Pool({ host, port: 5432, user: 'opusloops_api', database: 'opusloops',
      password: () => signer.getAuthToken(), max: 1, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
      ssl: { ca: readFileSync(new URL('./rds-ca.pem', import.meta.url), 'utf8'), rejectUnauthorized: true },
    });
    pool.on('error', () => {}); // A failed idle connection is replaced; never log credentials/queries.
  }
  return pool;
}

export function rpcKind(name) {
  if (CLIENT_RPCS.has(name)) return 'authenticated';
  if (SERVICE_RPCS.has(name)) return 'service_role';
  fail('Operation is not allowed', '42501');
}

function requireIdentity(identity) {
  if (!UUID.test(identity?.id || '')) fail('Account required', '42501');
  return identity.id.toLowerCase();
}

export async function executeOperation(client, event) {
  const operation = event?.operation;
  if (operation === 'pending-dispatches') {
    return (await client.query(`SELECT a.user_id,a.job_id FROM private.stem_job_attempts a
      JOIN public.stem_import_jobs j ON j.active_attempt_id=a.id
      WHERE a.state IN ('pending_dispatch','dispatching','reconcile_pending') AND a.external_job_id IS NULL
      AND (a.dispatch_claim_expires_at IS NULL OR a.dispatch_claim_expires_at<now())
      AND (a.reconcile_after IS NULL OR a.reconcile_after<now())
      ORDER BY a.created_at LIMIT 5`)).rows;
  }
  if (operation === 'identity') {
    if (typeof event.subject !== 'string' || event.subject.length > 128) fail('Identity is invalid');
    const result = await client.query("SELECT id,email,created_at,raw_user_meta_data,raw_app_meta_data,disabled_at FROM auth.users WHERE provider_subject=$1", [event.subject]);
    const user = result.rows[0];
    if (!user || user.disabled_at || user.raw_app_meta_data?.opusloops !== true) fail('Opusloops account required', '42501');
    return user;
  }
  if (operation === 'bind-identity') {
    // Only invoked after invite reservation + Cognito admin provisioning. Never
    // bind by email alone or overwrite a subject assigned to an existing owner.
    requireIdentity({ id: event.id });
    if (!UUID.test(event.subject || '') || typeof event.email !== 'string') fail('Identity is invalid');
    const result = await client.query(`INSERT INTO auth.users(id,provider_subject,email,raw_user_meta_data)
      VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET provider_subject=EXCLUDED.provider_subject
      WHERE auth.users.provider_subject IS NULL AND lower(auth.users.email)=lower(EXCLUDED.email)
      RETURNING id`, [event.id, event.subject, event.email, { display_name: event.displayName || '' }]);
    if (!result.rowCount) {
      const matched = await client.query('SELECT id FROM auth.users WHERE id=$1 AND provider_subject=$2 AND lower(email)=lower($3)', [event.id, event.subject, event.email]);
      if (!matched.rowCount) fail('Identity binding conflicts with an existing account', '42501');
    }
    return { id: event.id };
  }
  if (operation === 'profile') {
    const id = requireIdentity(event.identity);
    // Values must come from a verified Cognito GetUser response in the API.
    await client.query(`UPDATE auth.users SET email=$2,raw_user_meta_data=jsonb_build_object('display_name',$3::text),updated_at=now() WHERE id=$1`, [id, event.email, event.displayName]);
    return { updated: true };
  }
  if (operation === 'assets') {
    const id = requireIdentity(event.identity);
    if (!UUID.test(event.jobId || '')) fail('Job ID is invalid');
    const offset = Number(event.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail('Offset is invalid');
    await setIdentity(client, id);
    const result = await client.query('SELECT * FROM public.stem_import_assets WHERE user_id=$1 AND job_id=$2 ORDER BY created_at,asset_id LIMIT 500 OFFSET $3', [id, event.jobId, offset]);
    return result.rows;
  }
  if (operation === 'multipart') {
    const id=requireIdentity(event.identity);
    if (!UUID.test(event.jobId||'')) fail('Job ID is invalid');
    if (event.mode==='save') {
      if (typeof event.uploadId!=='string' || event.uploadId.length>2048) fail('Upload is invalid');
      await client.query('INSERT INTO private.aws_multipart_uploads(user_id,job_id,upload_id) VALUES($1,$2,$3) ON CONFLICT(user_id,job_id) DO NOTHING',[id,event.jobId,event.uploadId]);
    } else if (event.mode==='complete') {
      await client.query('UPDATE private.aws_multipart_uploads SET completed_at=now() WHERE user_id=$1 AND job_id=$2 AND upload_id=$3',[id,event.jobId,event.uploadId]);
    } else if(event.mode!=='get') fail('Upload operation is invalid');
    return (await client.query('SELECT upload_id,completed_at FROM private.aws_multipart_uploads WHERE user_id=$1 AND job_id=$2',[id,event.jobId])).rows[0]||null;
  }
  if (operation === 'remove-object') {
    if (!['opusloops-stem-uploads','opusloops-stem-sources','opusloops-stem-artifacts'].includes(event.bucket) || typeof event.key!=='string') fail('Object is invalid');
    await client.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2',[event.bucket,event.key]);
    return {removed:true};
  }
  if (operation === 'register-object') {
    const id = requireIdentity(event.identity);
    if (!['opusloops-stem-uploads', 'opusloops-stem-sources', 'opusloops-stem-artifacts'].includes(event.bucket)
        || typeof event.key !== 'string' || !event.key.startsWith(`${id}/`) || !Number.isSafeInteger(event.bytes) || event.bytes < 0) fail('Object binding is invalid');
    await client.query(`INSERT INTO storage.objects(bucket_id,name,owner_id,metadata)
      VALUES ($1,$2,$3,$4) ON CONFLICT(bucket_id,name) DO UPDATE SET metadata=EXCLUDED.metadata,updated_at=now()`,
    [event.bucket, event.key, id, { size: event.bytes, eTag: event.etag, mimetype: event.contentType }]);
    return { registered: true };
  }
  if (operation === 'rpc') {
    const role = rpcKind(event.name);
    const parameters = event.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) fail('Parameters are invalid');
    if (role === 'authenticated') await setIdentity(client, requireIdentity(event.identity));
    // Derive types/names from our owned schema, never from an HTTP request.
    const metadata = await client.query(`SELECT p.proargnames, ARRAY(SELECT format_type(t,NULL) FROM unnest(p.proargtypes) t) AS types
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [event.name]);
    if (metadata.rows.length !== 1) fail('Database operation is unavailable', '55000');
    const signature = metadata.rows[0];
    const keys = Object.keys(parameters);
    const bindings = keys.map((key, i) => {
      const index = signature.proargnames?.indexOf(key) ?? -1;
      if (!/^p_[a-z0-9_]+$/.test(key) || index < 0 || index >= signature.types.length) fail('Unknown operation parameter');
      return `"${key}" := $${i + 1}::${signature.types[index]}`;
    });
    const values = keys.map(key => {
      const value = parameters[key];
      const type = signature.types[signature.proargnames.indexOf(key)];
      return type === 'jsonb' || type === 'json' ? JSON.stringify(value) : value;
    });
    const result = await client.query(`SELECT to_jsonb(r) AS value FROM public."${event.name}"(${bindings.join(',')}) r`, values);
    return event.name === 'sync_projects' ? result.rows.map(row => row.value) : result.rows[0]?.value ?? null;
  }
  fail('Operation is not allowed', '42501');
}

async function setIdentity(client, id) {
  const result = await client.query('SELECT raw_app_meta_data FROM auth.users WHERE id=$1 AND disabled_at IS NULL', [id]);
  if (result.rows[0]?.raw_app_meta_data?.opusloops !== true) fail('Opusloops account required', '42501');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role','authenticated',true)",
    [JSON.stringify({ sub: id, role: 'authenticated', app_metadata: { opusloops: true } }), id]);
  await client.query('SET LOCAL ROLE authenticated');
}

export async function handler(event) {
  let client;
  try {
    client = await databasePool().connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='20s'");
    await client.query("SET LOCAL ROLE service_role");
    await client.query("SELECT set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claims','{\"role\":\"service_role\"}',true),set_config('request.jwt.claim.sub','',true)");
    const value = await executeOperation(client, event);
    await client.query('COMMIT');
    return { ok: true, value };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    const safeCode = /^(22023|42501|P0002|40001|55000|54000|23505)$/.test(error.code || '') ? error.code : 'XX000';
    return { ok: false, code: safeCode, message: safeCode === 'XX000' ? 'Database operation is temporarily unavailable' : error.message };
  } finally {
    client?.release();
  }
}
