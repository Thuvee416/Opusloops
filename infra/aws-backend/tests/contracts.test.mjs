import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateParts,CHUNK_BYTES } from '../runtime/storage.mjs';
import { verifyCallback } from '../runtime/callback.mjs';
import { stageOperation } from '../runtime/stems.mjs';
import { storagePolicy } from '../runtime/dispatch.mjs';
import { accessClaims,authenticate,client as cognito } from '../runtime/auth.mjs';
import { lambda } from '../runtime/common.mjs';

const user='11111111-1111-4111-8111-111111111111',job='22222222-2222-4222-8222-222222222222',attempt='33333333-3333-4333-8333-333333333333',nonce='44444444-4444-4444-8444-444444444444';
test('multipart completion checks every ordered part and its exact byte size',()=>{
  const parts=[{PartNumber:1,Size:CHUNK_BYTES,ETag:'part-1'},{PartNumber:2,Size:10,ETag:'part-2'}];
  assert.deepEqual(validateParts(parts,CHUNK_BYTES+10),parts.map(({PartNumber,ETag})=>({PartNumber,ETag})));
  for(const candidate of [parts.slice(0,1),parts.toReversed(),[{...parts[0],Size:2},parts[1]],[parts[0],{...parts[1],ETag:''}]])assert.throws(()=>validateParts(candidate,CHUNK_BYTES+10));
});
test('worker callback binds raw bytes, clock, job, attempt, and nonce',()=>{
  const master='test-master-'.repeat(5),timestamp='1700000000';
  const bytes=Buffer.from(JSON.stringify({jobId:job,attemptId:attempt,stage:'inspect'}));
  const token=createHmac('sha256',master).update(attempt).digest('hex');
  const signature=createHmac('sha256',token).update(`${timestamp}.${nonce}.`).update(bytes).digest('hex');
  const headers={'x-opusloops-job-id':job,'x-opusloops-attempt':attempt,'x-opusloops-nonce':nonce,'x-opusloops-timestamp':timestamp,'x-opusloops-signature':signature};
  assert.equal(verifyCallback(headers,bytes,master,1700000001).p_payload.jobId,job);
  assert.throws(()=>verifyCallback(headers,Buffer.from('{}'),master,1700000001));
  assert.throws(()=>verifyCallback(headers,bytes,master,1700001000));
  assert.throws(()=>verifyCallback({...headers,'x-opusloops-job-id':user},bytes,master,1700000001));
});
test('approval API preserves explicit boolean gates and trusted owner identity',()=>{
  const result=stageOperation({action:'approve-analysis',jobId:job,revision:2,userId:'attacker',inspectionManifestSha256:'a'.repeat(64),selection:{},confirmations:{files:true,roles:'true',reference:1,originalsUnchanged:false}},user);
  assert.equal(result.params.p_user_id,user);
  assert.equal(result.params.p_confirm_files,true);
  assert.equal(result.params.p_confirm_roles,false);
  assert.equal(result.params.p_confirm_reference,false);
  assert.throws(()=>stageOperation({action:'cancel',jobId:job,revision:-1},user));
});
test('worker storage credentials cannot read another project or write another attempt',()=>{
  const mapping=Object.fromEntries(['uploads','sources','artifacts'].map(kind=>[`opusloops-stem-${kind}`,`opusloops-${kind}-123456789012-us-east-1`]));
  const claim={userId:user,projectId:nonce,jobId:job,attemptId:attempt,stage:'render',runPrefix:`${user}/${nonce}/${job}`};
  const policy=storagePolicy(claim,mapping,'123456789012');
  assert.ok(JSON.stringify(policy).length<2048);
  assert.equal(policy.Statement.length,2);
  assert.match(policy.Statement[1].Resource,new RegExp(`/attempts/${attempt}/render/\\*$`));
  assert.ok(!JSON.stringify(policy).includes('s3:Delete'));
  assert.throws(()=>storagePolicy({...claim,runPrefix:'other/project'},mapping,'123456789012'));
});
test('Cognito claims from another pool/client cannot be treated as an account',()=>{
  const options={region:'us-east-1',pool:'test_pool',clientId:'test_client'};
  const make=claims=>`header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const claims={iss:'https://cognito-idp.us-east-1.amazonaws.com/test_pool',client_id:'test_client',token_use:'access',exp:Math.floor(Date.now()/1000)+1000};
  assert.equal(accessClaims(make(claims),options).client_id,'test_client');
  for(const invalid of [{...claims,client_id:'other'},{...claims,token_use:'id'},{...claims,exp:0},{...claims,iss:'https://attacker.example'}])assert.throws(()=>accessClaims(make(invalid),options));
});
test('sign-in validates with Cognito before resolving the immutable owner ID',async()=>{
  process.env.AWS_REGION='us-east-1';process.env.USER_POOL_ID='test_pool';process.env.USER_POOL_CLIENT_ID='test_client';
  const claims={iss:'https://cognito-idp.us-east-1.amazonaws.com/test_pool',client_id:'test_client',token_use:'access',sub:attempt,exp:Math.floor(Date.now()/1000)+1000};
  const token=`header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const originalCognito=cognito.send,originalLambda=lambda.send;const calls=[];
  try {
    cognito.send=async()=>{calls.push('verified');return {Username:user,UserAttributes:[{Name:'sub',Value:attempt}]};};
    lambda.send=async command=>{const payload=JSON.parse(Buffer.from(command.input.Payload));calls.push(payload.operation);assert.equal(payload.subject,attempt);return {Payload:Buffer.from(JSON.stringify({ok:true,value:{id:user,raw_app_meta_data:{opusloops:true}}}))};};
    assert.equal((await authenticate(token)).id,user);assert.deepEqual(calls,['verified','identity']);
    calls.length=0;cognito.send=async()=>{throw new Error('invalid signature');};
    await assert.rejects(authenticate(token));assert.deepEqual(calls,[]);
  } finally {cognito.send=originalCognito;lambda.send=originalLambda;}
});
