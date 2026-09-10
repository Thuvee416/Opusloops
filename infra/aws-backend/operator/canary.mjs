import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { hash } from 'bcryptjs';
import { CognitoIdentityProviderClient,AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client,GetObjectCommand,ListObjectVersionsCommand,DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { foundation,awsCli,awsOptions,migrationCall } from './aws.mjs';
import { importIdentities } from './import-identities.mjs';

const outputs=await foundation();
const stack=(await awsCli('cloudformation','describe-stacks','--stack-name','opusloops-aws-application')).Stacks[0];
const endpoint=stack.Outputs.find(row=>row.OutputKey==='ApiUrl').OutputValue;
const cognito=new CognitoIdentityProviderClient(awsOptions),s3=new S3Client(awsOptions);
const checks=[];
const users=await Promise.all([0,1].map(async()=>{
  const id=randomUUID(),password=randomBytes(24).toString('base64url');
  return {id,email:`migration-${id}@example.invalid`,password,encrypted_password:await hash(password,10),email_confirmed_at:new Date().toISOString()};
}));
const seeded=[],objects=[];
async function request(path,{method='POST',body,token,expected=200}={}) {
  const response=await fetch(endpoint+path,{method,headers:{Origin:'https://opusloops.com','Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  const data=await response.json().catch(()=>null);
  if(response.status!==expected)throw new Error(`Canary ${method} ${path.split('?')[0]} returned ${response.status} (${data?.code||'unknown'})`);
  return data;
}
try {
  const imported=await importIdentities(users,{canary:true});
  for(const binding of imported.bindings){await migrationCall('canary-user',binding);seeded.push(binding.id);}
  const sessions=[];
  for(const user of users) {
    const session=await request('/auth/v1/token?grant_type=password',{body:{email:user.email,password:user.password}});
    assert.equal(session.user.id,user.id);sessions.push(session);
  }
  checks.push('Existing bcrypt passwords and immutable owner IDs survive Cognito import');
  const token=sessions[0].access_token;
  const refreshed=await request('/auth/v1/token?grant_type=refresh_token',{body:{refresh_token:sessions[0].refresh_token}});
  assert.equal(refreshed.user.id,users[0].id);
  checks.push('Sign-in and refresh work through the native API');
  const profile=await request('/auth/v1/user',{method:'PUT',token,body:{data:{display_name:'AWS migration test'}}});
  assert.equal(profile.user_metadata.display_name,'AWS migration test');
  const projectId=randomUUID();
  const rows=await request('/rest/v1/rpc/sync_projects',{token,body:{p_changes:[{id:projectId,name:'Migration canary',schema_version:2,document:{id:projectId,schemaVersion:2,tempo:120},client_updated_at:new Date().toISOString(),deleted_at:null}]}});
  assert.equal(rows.length,1);assert.equal(rows[0].id,projectId);
  const others=await request('/rest/v1/rpc/sync_projects',{token:sessions[1].access_token,body:{p_changes:[]}});
  assert.deepEqual(others,[]);
  checks.push('Profile updates and project saves work; another account cannot see them');
  const bytes=randomBytes(8*1024*1024+257);
  const create=await request('/functions/v1/stem-import',{token,expected:201,body:{action:'create',projectId,file:{name:'migration-canary.zip',size:bytes.length,type:'application/zip'}}});
  objects.push(create.upload.objectName);
  const action=body=>request('/functions/v1/stem-import',{token,body:{jobId:create.job.id,...body}});
  const initial=await action({action:'upload-status'});assert.equal(initial.confirmedBytes,0);
  for(const partNumber of [1,2]) {
    const part=await action({action:'upload-part',partNumber});
    const result=await fetch(part.url,{method:'PUT',body:bytes.subarray((partNumber-1)*initial.chunkSize,partNumber*initial.chunkSize)});
    assert.equal(result.status,200);
    const resumed=await action({action:'upload-status'});
    assert.equal(resumed.confirmedBytes,Math.min(partNumber*initial.chunkSize,bytes.length));
  }
  const complete=await action({action:'upload-complete'});assert.equal(complete.confirmedBytes,bytes.length);assert.equal(complete.complete,true);
  const duplicate=await action({action:'upload-complete'});assert.equal(duplicate.complete,true);
  const downloaded=await s3.send(new GetObjectCommand({Bucket:outputs.UploadsBucket,Key:create.upload.objectName}));
  const received=await downloaded.Body.transformToByteArray();
  assert.equal(createHash('sha256').update(received).digest('hex'),createHash('sha256').update(bytes).digest('hex'));
  await request('/functions/v1/stem-import',{token:sessions[1].access_token,expected:404,body:{action:'upload-status',jobId:create.job.id}});
  checks.push('Multipart upload resumes from S3-confirmed bytes; completion is idempotent and checksum-correct');
  checks.push('Another account cannot obtain an upload session for the first account');
  await request('/auth/v1/logout',{token,body:{refresh_token:sessions[0].refresh_token},expected:204});
  await request('/auth/v1/token?grant_type=refresh_token',{body:{refresh_token:sessions[0].refresh_token},expected:401});
  checks.push('Sign-out revokes the refresh session');
  console.log(JSON.stringify({passed:checks.length,checks}));
} finally {
  for(const key of objects) {
    if(!key.startsWith(users[0].id+'/'))throw new Error('Canary cleanup scope mismatch');
    const versions=await s3.send(new ListObjectVersionsCommand({Bucket:outputs.UploadsBucket,Prefix:key}));
    const items=[...(versions.Versions||[]),...(versions.DeleteMarkers||[])].filter(row=>row.Key===key).map(({Key,VersionId})=>({Key,VersionId}));
    if(items.length)await s3.send(new DeleteObjectsCommand({Bucket:outputs.UploadsBucket,Delete:{Objects:items}}));
  }
  for(const id of seeded)await migrationCall('remove-canary',{id});
  for(const user of users)await cognito.send(new AdminDeleteUserCommand({UserPoolId:outputs.UserPoolId,Username:user.id})).catch(error=>{if(error.name!=='UserNotFoundException')throw error;});
  console.log(JSON.stringify({canaryCleanup:'complete',realUsersChanged:false}));
}
