import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationTemplate } from '../application.mjs';
import { template as foundation } from '../foundation.mjs';
import { nativeJob } from '../runtime/lifecycle.mjs';
import { verifySnapshot } from '../runtime/migration.mjs';

test('native API has no database password or public database bridge', () => {
  const template=applicationTemplate({outputs:{MigrationBucket:'private-code',UserPoolId:'pool',UploadsBucket:'u',SourcesBucket:'s',ArtifactsBucket:'a',CallbackSecretArn:'secret'},account:'368310207026',region:'us-east-1',codeKey:'code.zip',image:`368310207026.dkr.ecr.us-east-1.amazonaws.com/opusloops/stem-worker@sha256:${'a'.repeat(64)}`,executionRole:'execution',taskRole:'task'});
  const env=template.Resources.ApiFunction.Properties.Environment.Variables;
  assert.equal(env.DATABASE_FUNCTION,'opusloops-aws-database');
  assert.ok(!JSON.stringify(template).includes('MasterUserPassword'));
  assert.ok(!JSON.stringify(template).includes('supabase.co'));
  const role=template.Resources.ApiRole.Properties.Policies[0].PolicyDocument.Statement;
  const invokes=role.find(row=>row.Action==='lambda:InvokeFunction');
  assert.ok(invokes.Resource.endsWith(':function:opusloops-aws-database'));
  assert.ok(!JSON.stringify(role).includes('opusloops-aws-migration'));
  const submit=role.find(row=>row.Action==='batch:SubmitJob');
  assert.equal(submit.Resource.length,5);
  assert.equal(template.Resources.InspectDefinition.Properties.RetryStrategy.Attempts,1);
});
test('S3 requires conditional final writes but permits multipart parts', () => {
  for(const bucket of ['Uploads','Sources','Artifacts']) {
    const statement=foundation.Resources[`${bucket}BucketPolicy`].Properties.PolicyDocument.Statement.find(row=>row.Sid==='RequireImmutableObjectCreation');
    assert.equal(statement.Effect,'Deny');
    assert.equal(statement.Condition.Null['s3:if-none-match'],'true');
    assert.equal(statement.Condition.Bool['s3:ObjectCreationOperation'],'true');
    assert.equal(foundation.Resources[`${bucket}Bucket`].Properties.NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled,true);
  }
});
test('native failure handling ignores legacy and unrelated job definitions', () => {
  process.env.BATCH_INSPECT_DEFINITION='native-definition';process.env.BATCH_JOB_QUEUE='queue';
  assert.equal(nativeJob({jobDefinition:'legacy',jobQueue:'queue'}),null);
  assert.equal(nativeJob({jobDefinition:'native-definition',jobQueue:'other'}),null);
  assert.throws(()=>nativeJob({jobDefinition:'native-definition',jobQueue:'queue',jobId:'not-uuid'}));
});
test('snapshot verification compares normalized contents, not just row counts', async () => {
  const source={tables:{}};
  const {TABLES}=await import('../runtime/migration.mjs');
  for(const name of TABLES)source.tables[name]=[{id:1,value:'original'}];
  const client={async query(sql){
    if(sql.startsWith('SELECT column_name'))return {rows:[{column_name:'id'},{column_name:'value'}]};
    if(sql.includes('count(*)'))return {rows:[{count:1}]};
    if(sql.includes('jsonb_populate_recordset'))return {rows:[{id:1,value:'original'}]};
    return {rows:[{id:1,value:'changed'}]};
  }};
  const result=await verifySnapshot(client,source);
  assert.equal(result.ok,false);
  assert.ok(Object.values(result.tables).every(row=>row.rows===1&&!row.matched));
});
