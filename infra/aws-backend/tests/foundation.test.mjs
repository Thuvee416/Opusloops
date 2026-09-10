import test from 'node:test';
import assert from 'node:assert/strict';
import { template } from '../foundation.mjs';
import { compileSchema } from '../database/compile.mjs';
import { rpcKind, executeOperation } from '../runtime/database.mjs';

test('the data foundation cannot expose PostgreSQL or delete durable data', () => {
  const db = template.Resources.Database;
  assert.equal(db.Properties.PubliclyAccessible,false);
  assert.equal(db.Properties.DeletionProtection,true);
  assert.equal(db.Properties.StorageEncrypted,true);
  assert.equal(db.Properties.ManageMasterUserPassword,true);
  assert.equal(db.DeletionPolicy,'Retain');
  assert.ok(!('MasterUserPassword' in db.Properties));
  for (const name of ['Uploads','Sources','Artifacts','Migration']) {
    const bucket = template.Resources[`${name}Bucket`];
    assert.equal(bucket.DeletionPolicy,'Retain');
    assert.ok(Object.values(bucket.Properties.PublicAccessBlockConfiguration).every(Boolean));
    assert.equal(bucket.Properties.VersioningConfiguration.Status,'Enabled');
  }
});
test('Cognito keeps app ownership server controlled and signup invitation only', () => {
  const pool = template.Resources.UserPool.Properties;
  assert.equal(pool.AdminCreateUserConfig.AllowAdminCreateUserOnly,true);
  assert.equal(pool.Schema.find(row=>row.Name==='opusloops_id').Mutable,false);
  assert.ok(!template.Resources.UserPoolClient.Properties.WriteAttributes.includes('custom:opusloops_id'));
  assert.deepEqual(pool.UserAttributeUpdateSettings.AttributesRequireVerificationBeforeUpdate,['email']);
});
test('native bootstrap is transactional, source guarded, and keeps historical migrations', async () => {
  const sql = await compileSchema();
  assert.match(sql,/^BEGIN;/);
  assert.match(sql,/expected an empty dedicated Opusloops AWS database/);
  assert.match(sql,/supabase_migrations/);
  assert.match(sql,/20260906223000_retry_extensible_wav_render.sql/);
  assert.match(sql,/aws_schema_migrations\(filename, sha256\)/);
  assert.match(sql,/COMMIT;\s*$/);
  assert.doesNotMatch(sql,/create extension (supabase_vault|pg_net)/i);
});
test('database bridge restricts service operations and rejects SQL-shaped names', () => {
  assert.equal(rpcKind('sync_projects'),'authenticated');
  assert.equal(rpcKind('create_stem_import'),'service_role');
  for (const name of ['private.sync_projects_unchecked','x";drop table public.projects;--','issue_opusloops_signup_invite']) {
    assert.throws(()=>rpcKind(name),{code:'42501'});
  }
});
test('database bridge will not bind users by email or accept client SQL',async () => {
  const client = {query:()=>{throw new Error('query must not run');}};
  await assert.rejects(executeOperation(client,{operation:'sql',sql:'select 1'}),{code:'42501'});
  await assert.rejects(executeOperation(client,{operation:'bind-identity',id:'not-a-uuid',subject:'anything',email:'x@example.com'}),{code:'42501'});
});
