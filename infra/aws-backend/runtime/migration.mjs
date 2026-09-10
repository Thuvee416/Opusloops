// Temporary, IAM-only migration Lambda. Never grant the app permission to invoke
// it. Database password is supplied in memory by the signed-in operator over
// Lambda's TLS API, never stored in config, files, logs, or return values.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const TABLES = [
  'auth.users', 'public.projects', 'public.stem_import_jobs', 'public.stem_import_assets',
  'public.stem_import_events', 'private.opusloops_signup_invites', 'private.stem_job_attempts',
  'private.stem_worker_nonces', 'private.stem_retention_items', 'private.stem_retention_scopes',
  'storage.objects',
];
const quote = value => `"${value.replaceAll('"', '""')}"`;
const qualified = table => table.split('.').map(quote).join('.');
const canonical = value => JSON.stringify(value, function(key, item) {
  return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item;
});

export async function verifySnapshot(client, snapshot) {
  const results = {};
  for (const table of TABLES) {
    const rows = snapshot.tables[table];
    const [schema, name] = table.split('.');
    const columns = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND is_generated=\'NEVER\' ORDER BY ordinal_position', [schema, name])).rows.map(row=>row.column_name);
    const keys = columns.filter(key=>rows.length && rows.every(row=>key in row));
    const target = keys.length ? (await client.query(`SELECT ${keys.map(quote).join(',')} FROM ${qualified(table)}`)).rows : [];
    // Let PostgreSQL normalize timestamps/numerics just as it did on restore.
    const expected = keys.length ? (await client.query(`SELECT ${keys.map(quote).join(',')} FROM jsonb_populate_recordset(NULL::${qualified(table)},$1::jsonb)`, [JSON.stringify(rows)])).rows : [];
    const digest = values => createHash('sha256').update(values.map(canonical).sort().join('\n')).digest('hex');
    const count = Number((await client.query(`SELECT count(*) AS count FROM ${qualified(table)}`)).rows[0].count);
    const sourceHash = digest(expected), targetHash = digest(target);
    results[table] = { rows: count, sha256: targetHash, matched: count === rows.length && sourceHash === targetHash };
  }
  return { ok: Object.values(results).every(row=>row.matched), tables: results };
}

export async function restoreSnapshot(client, snapshot) {
  if (snapshot?.version !== 1 || snapshot.sourceProject !== 'heryvahetgzfalmuprbw'
      || !snapshot.tables || TABLES.some(table => !Array.isArray(snapshot.tables[table]))) throw new Error('invalid_snapshot');
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opusloops-aws-restore',0))");
    // A restore is allowed only before the API has ever been enabled. Even an
    // operator cannot accidentally replace a live AWS workspace with a snapshot.
    const state = await client.query('SELECT live_at FROM private.aws_migration_state WHERE singleton=true FOR UPDATE');
    if (state.rowCount !== 1 || state.rows[0].live_at) throw new Error('target_is_live');
    for (const table of TABLES) await client.query(`ALTER TABLE ${qualified(table)} DISABLE TRIGGER USER`);
    // Only the explicit, new AWS destination tables are replaced. Source tables
    // are never modified by this program. NO CASCADE or platform-wide truncation.
    await client.query(`TRUNCATE ${TABLES.map(qualified).join(',')},private.aws_multipart_uploads`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const table of TABLES) {
      const [schema, name] = table.split('.');
      const columns = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND is_generated=\'NEVER\' ORDER BY ordinal_position', [schema, name]);
      const permitted = columns.rows.map(row => row.column_name);
      const rows = snapshot.tables[table].map(row => Object.fromEntries(permitted.filter(key => key in row).map(key => [key, row[key]])));
      if (!rows.length) continue;
      // Preserve timestamps and approval-bearing JSON exactly. Extra source Auth
      // fields (including password hashes/tokens) cannot enter the app registry.
      const keys = permitted.filter(key => rows.every(row => key in row));
      if (!keys.length) throw new Error('snapshot_columns_missing');
      const list = keys.map(quote).join(',');
      await client.query(`INSERT INTO ${qualified(table)} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${qualified(table)},$1::jsonb)`, [JSON.stringify(rows)]);
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    for (const table of TABLES) await client.query(`ALTER TABLE ${qualified(table)} ENABLE TRIGGER USER`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function handler(event) {
  let client;
  try {
    if (!event || typeof event.password !== 'string' || event.password.length < 8) throw new Error('credentials_missing');
    client = new pg.Client({ host: process.env.DATABASE_HOST, database: 'opusloops', user: 'opusloops_admin',
      password: event.password, connectionTimeoutMillis: 15000,
      ssl: { ca: readFileSync(new URL('./rds-ca.pem', import.meta.url), 'utf8'), rejectUnauthorized: true },
    });
    await client.connect();
    await client.query("SET statement_timeout='90s'");
    if (event.action === 'bootstrap') {
      await client.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      return { ok: true, action: 'bootstrap' };
    }
    if (event.action === 'restore') {
      const bytes = gunzipSync(Buffer.from(event.snapshotGzip, 'base64'), { maxOutputLength: 32 * 1024 * 1024 });
      if (createHash('sha256').update(bytes).digest('hex') !== event.sha256) throw new Error('snapshot_hash_mismatch');
      await restoreSnapshot(client, JSON.parse(bytes));
      return { ok: true, action: 'restore' };
    }
    if (event.action === 'verify') {
      const bytes = gunzipSync(Buffer.from(event.snapshotGzip, 'base64'), { maxOutputLength: 32 * 1024 * 1024 });
      if (createHash('sha256').update(bytes).digest('hex') !== event.sha256) throw new Error('snapshot_hash_mismatch');
      const result = await verifySnapshot(client, JSON.parse(bytes));
      return { ...result, code: result.ok ? undefined : 'snapshot_verification_failed' };
    }
    if (event.action === 'canary-user') {
      if (!/^[0-9a-f-]{36}$/.test(event.id||'') || !/^[0-9a-f-]{36}$/.test(event.subject||'')) throw new Error('canary_invalid');
      const email = `migration-${event.id}@example.invalid`;
      await client.query(`INSERT INTO auth.users(id,provider_subject,email,raw_app_meta_data,raw_user_meta_data)
        VALUES ($1,$2,$3,'{"opusloops":true,"migration_canary":true}','{"display_name":"Migration test"}')`, [event.id,event.subject,email]);
      return { ok: true };
    }
    if (event.action === 'remove-canary') {
      if (!/^[0-9a-f-]{36}$/.test(event.id||'')) throw new Error('canary_invalid');
      await client.query('BEGIN');
      const found = await client.query("SELECT id FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'migration_canary'='true' FOR UPDATE", [event.id]);
      if(found.rowCount!==1)throw new Error('not_a_canary');
      await client.query('DELETE FROM storage.objects WHERE owner_id=$1',[event.id]);
      await client.query('DELETE FROM auth.users WHERE id=$1',[event.id]);
      // The normal hard-delete trigger enqueues retention records. The operator
      // has already removed this synthetic account's S3 versions explicitly.
      await client.query('DELETE FROM private.stem_retention_items WHERE user_id=$1',[event.id]);
      await client.query('DELETE FROM private.stem_retention_scopes WHERE user_id=$1',[event.id]);
      await client.query('COMMIT');
      return { ok: true };
    }
    if (event.action === 'activate') {
      const missing=await client.query("SELECT count(*) AS count FROM auth.users WHERE provider_subject IS NULL AND raw_app_meta_data->>'opusloops'='true'");
      if(Number(missing.rows[0].count)!==0)throw new Error('identity_migration_incomplete');
      await client.query('UPDATE private.aws_migration_state SET live_at=coalesce(live_at,now()) WHERE singleton=true');
      return { ok: true };
    }
    if (event.action === 'bind-users') {
      if (!Array.isArray(event.bindings) || event.bindings.length > 1000) throw new Error('bindings_invalid');
      await client.query('BEGIN');
      for (const binding of event.bindings) {
        if (!/^[0-9a-f-]{36}$/.test(binding.id || '') || !/^[0-9a-f-]{36}$/.test(binding.subject || '')) throw new Error('bindings_invalid');
        const result = await client.query('UPDATE auth.users SET provider_subject=$2 WHERE id=$1 AND (provider_subject IS NULL OR provider_subject=$2)', [binding.id, binding.subject]);
        if (result.rowCount !== 1) throw new Error('identity_binding_conflict');
      }
      await client.query('COMMIT');
      return { ok: true, bound: event.bindings.length };
    }
    if (event.action === 'runtime-user') {
      await client.query('CREATE ROLE opusloops_api LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS CONNECTION LIMIT 10');
      await client.query('GRANT rds_iam, authenticated, service_role TO opusloops_api');
      await client.query('GRANT CONNECT ON DATABASE opusloops TO opusloops_api');
      return { ok: true };
    }
    if (event.action === 'counts') {
      const counts = {};
      for (const table of TABLES) counts[table] = Number((await client.query(`SELECT count(*) AS count FROM ${qualified(table)}`)).rows[0].count);
      return { ok: true, counts };
    }
    throw new Error('action_invalid');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    // SQL errors can embed user documents. Report only a code, not detail/query.
    return { ok: false, code: error.code || (/^[a-z_]+$/.test(error.message) ? error.message : 'migration_failed') };
  } finally {
    await client?.end().catch(() => {});
  }
}
