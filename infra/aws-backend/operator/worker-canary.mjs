import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { hash } from 'bcryptjs';
import { CognitoIdentityProviderClient,AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client,ListObjectVersionsCommand,DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { foundation,awsCli,awsOptions,migrationCall } from './aws.mjs';
import { importIdentities } from './import-identities.mjs';
import core from '../../../mobile/stem-import-core.js';

const outputs=await foundation();
const stack=(await awsCli('cloudformation','describe-stacks','--stack-name','opusloops-aws-application')).Stacks[0];
const endpoint=stack.Outputs.find(row=>row.OutputKey==='ApiUrl').OutputValue;
const image=stack.Outputs.find(row=>row.OutputKey==='WorkerImage').OutputValue;
if(image.endsWith('fa1d8ab2d8a12f943eb48332427bb626aafe3dd4cb74227f3d3a9237c2cee8cb'))throw new Error('Native worker image is not deployed yet');
const id=randomUUID(),projectId=randomUUID(),password=randomBytes(24).toString('base64url');
const user={id,email:`migration-${id}@example.invalid`,encrypted_password:await hash(password,10),email_confirmed_at:new Date().toISOString()};
const imported=await importIdentities([user],{canary:true});
await migrationCall('canary-user',imported.bindings[0]);
let token;
async function request(path,body,method='POST') {
  const response=await fetch(endpoint+path,{method,headers:{Origin:'https://opusloops.com','Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  const data=await response.json();
  if(!response.ok)throw new Error(`Worker canary API ${path.split('?')[0]} failed (${response.status}; ${data.code}; ${data.message})`);
  return data;
}
token=(await request('/auth/v1/token?grant_type=password',{email:user.email,password})).access_token;
await request('/rest/v1/rpc/sync_projects',{p_changes:[{id:projectId,name:'Synthetic AWS audio canary',schema_version:2,document:{id:projectId,schemaVersion:2,tempo:120},client_updated_at:new Date().toISOString(),deleted_at:null}]});
const fixture=await promisify(execFile)('python3',[new URL('synthetic-stems.py',import.meta.url).pathname],{encoding:'buffer',maxBuffer:16*1024*1024});
const bytes=fixture.stdout;
const created=await request('/functions/v1/stem-import',{action:'create',projectId,file:{name:'synthetic-16-bars.zip',size:bytes.length,type:'application/zip'}});
const jobId=created.job.id;
console.log(JSON.stringify({syntheticCanary:{userId:id,projectId,jobId},image}));
const action=body=>request('/functions/v1/stem-import',{jobId,...body});
await action({action:'upload-status'});
const part=await action({action:'upload-part',partNumber:1});
assert.equal((await fetch(part.url,{method:'PUT',body:bytes})).status,200);
await action({action:'upload-complete'});
await action({action:'finalize-upload',revision:created.job.revision});

async function waitFor(expected) {
  let previous='';
  for(let index=0;index<240;index++) {
    const snapshot=await request('/rest/v1/rpc/get_stem_import_event_snapshot',{p_job_id:jobId,p_after_sequence:0});
    const job=snapshot.job;
    if(job.status!==previous){console.log(JSON.stringify({workerStage:job.status}));previous=job.status;}
    if(job.status==='failed')throw new Error(`Synthetic worker failed (${job.error_code}; ${job.error_message})`);
    if(job.status===expected)return job;
    await setTimeout(5000);
  }
  throw new Error(`Synthetic worker did not reach ${expected} within 20 minutes`);
}
let job=await waitFor('awaiting_analysis_confirmation');
const selected=core.analysisSelection(job,core.normalizeJob(job).tracks.map(track=>({...track,included:true,gainDb:0,role:track.name.includes('Drums')?'drums':'bass'})));
// These approvals refer ONLY to generated test tones. No real user's gates are
// bypassed or granted by the operator's migration checks.
await action({action:'approve-analysis',revision:job.revision,inspectionManifestSha256:job.inspection_manifest_sha256,selection:selected,confirmations:{files:true,roles:true,reference:true,originalsUnchanged:true}});
job=await waitFor('awaiting_map_request');
const proposalId=`canary-${Date.now()}`;
const reviewedGrid={schema_version:'opusloops.tempo-grid-review.v1',analysis_sha256:job.analysis_sha256,attempt_id:job.analysis.attemptId,
  beats_seconds:Array.from({length:64},(_,i)=>i*0.5),downbeats_seconds:Array.from({length:16},(_,i)=>i*2),reviewed:true};
await action({action:'request-proposal',revision:job.revision,analysisSha256:job.analysis_sha256,proposalId,targetBpm:125,mode:'musical-4bar',reviewedGrid,meterNumerator:4,meterDenominator:4,firstDownbeatSeconds:0});
job=await waitFor('awaiting_tempo_confirmation');
const click=await action({action:'signed-download',assetId:job.proposal.clickAssetId});
const clickResponse=await fetch(click.signedUrl,{headers:{Range:'bytes=0-1023'}});
assert.equal(clickResponse.status,206);assert.ok((await clickResponse.arrayBuffer()).byteLength>0);
await action({action:'approve-tempo',revision:job.revision,proposalManifestSha256:job.proposal_manifest_sha256,
  approval:{proposalId,reviewedRegions:core.editedRegions(job.proposal.regions)},confirmations:{click:true,beatGrid:true,meterDownbeat:true,tempoOctave:true,flags:true,target:true,sharedMap:true,originalsUnchanged:true}});
job=await waitFor('ready');
const assets=await request(`/rest/v1/stem_import_assets?job_id=eq.${jobId}`,null,'GET');
const previews=assets.filter(asset=>asset.kind==='preview_segment');
assert.ok(previews.length>=2);
for(const preview of previews) {
  const signed=await action({action:'signed-download',assetId:preview.asset_id});
  const downloaded=await fetch(signed.signedUrl),audio=Buffer.from(await downloaded.arrayBuffer());
  assert.equal(downloaded.status,200);assert.equal(createHash('sha256').update(audio).digest('hex'),preview.sha256);
}
console.log(JSON.stringify({audioCanary:'passed',stages:['inspect','analyze','propose','render'],previewSegments:previews.length,rangePlayback:true,realUsersChanged:false}));
// Cleanup is deliberately after success. On failure retain only this synthetic
// account for diagnosis; never delete a running worker's destination underneath it.
const s3=new S3Client(awsOptions);
for(const Bucket of [outputs.UploadsBucket,outputs.SourcesBucket,outputs.ArtifactsBucket]) {
  const result=await s3.send(new ListObjectVersionsCommand({Bucket,Prefix:`${id}/`}));
  if(result.IsTruncated)throw new Error('Canary cleanup requires paginated review');
  const objects=[...(result.Versions||[]),...(result.DeleteMarkers||[])].map(({Key,VersionId})=>({Key,VersionId}));
  if(objects.some(row=>!row.Key.startsWith(`${id}/`)))throw new Error('Canary cleanup scope mismatch');
  if(objects.length)await s3.send(new DeleteObjectsCommand({Bucket,Delete:{Objects:objects}}));
}
await migrationCall('remove-canary',{id});
await new CognitoIdentityProviderClient(awsOptions).send(new AdminDeleteUserCommand({UserPoolId:outputs.UserPoolId,Username:id}));
console.log(JSON.stringify({audioCanaryCleanup:'complete'}));
