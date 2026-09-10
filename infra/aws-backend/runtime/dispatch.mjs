import { BatchClient,SubmitJobCommand,ListJobsCommand } from '@aws-sdk/client-batch';
import { STSClient,AssumeRoleCommand } from '@aws-sdk/client-sts';
import { createHmac,randomUUID } from 'node:crypto';
import { rpc,workerSecret,bucketMap } from './common.mjs';

const batch=new BatchClient({maxAttempts:1,requestHandler:{requestTimeout:12000}});
const sts=new STSClient({});
export function storagePolicy(claim,mapping,account) {
  if(!/^\d{12}$/.test(account)||claim.runPrefix!==`${claim.userId}/${claim.projectId}/${claim.jobId}`
      || !/^[0-9a-f-]{36}$/.test(claim.attemptId)||!['inspect','analyze','propose','render'].includes(claim.stage))throw new Error('Invalid worker storage binding');
  const prefix=claim.runPrefix;
  const statements=[
    {Effect:'Allow',Action:'s3:GetObject',Resource:Object.values(mapping).map(bucket=>`arn:aws:s3:::${bucket}/${prefix}/*`)},
    {Effect:'Allow',Action:'s3:PutObject',Resource:`arn:aws:s3:::${mapping['opusloops-stem-artifacts']}/${prefix}/attempts/${claim.attemptId}/${claim.stage}/*`},
  ];
  if(claim.stage==='inspect')statements.push({Effect:'Allow',Action:'s3:PutObject',Resource:`arn:aws:s3:::${mapping['opusloops-stem-sources']}/${prefix}/sources/*`});
  return {Version:'2012-10-17',Statement:statements};
}
export async function dispatch(userId,jobId) {
  const pending={state:'pending',alreadyDispatched:false};
  let claim;
  const claimId=randomUUID();
  try {
    claim=await rpc('claim_stem_dispatch',{p_user_id:userId,p_job_id:jobId,p_claim_id:claimId});
    if(claim.alreadyDispatched)return {state:'submitted',stage:claim.stage,attemptId:claim.attemptId,alreadyDispatched:true};
    if(!claim.dispatchClaimed)return pending;
    const jobName=claim.dispatchJobName;
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(jobName))throw new Error('Invalid dispatch name');
    if(claim.reconcileRequired) {
      const result=await batch.send(new ListJobsCommand({jobQueue:process.env.BATCH_JOB_QUEUE,filters:[{name:'JOB_NAME',values:[jobName]}],maxResults:100}));
      const existing=(result.jobSummaryList||[]).filter(row=>row.jobName===jobName).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))[0];
      if(existing?.jobId) {
        await rpc('record_stem_dispatch',{p_attempt_id:claim.attemptId,p_claim_id:claimId,p_external_job_id:existing.jobId});
        return {state:'submitted',stage:claim.stage,attemptId:claim.attemptId,alreadyDispatched:true};
      }
    }
    const mapping=bucketMap();
    const assumed=await sts.send(new AssumeRoleCommand({RoleArn:process.env.WORKER_STORAGE_ROLE,RoleSessionName:`stem-${claim.attemptId}`,DurationSeconds:3600,
      Policy:JSON.stringify(storagePolicy(claim,mapping,process.env.AWS_ACCOUNT_ID))}));
    const credentials=assumed.Credentials;
    const master=await workerSecret();
    const payload={version:2,jobId:claim.jobId,userId:claim.userId,projectId:claim.projectId,attemptId:claim.attemptId,stage:claim.stage,revision:claim.revision,
      storage:{endpoint:`https://s3.${process.env.AWS_REGION}.amazonaws.com`,region:process.env.AWS_REGION,
        accessKeyId:credentials.AccessKeyId,secretAccessKey:credentials.SecretAccessKey,sessionToken:credentials.SessionToken,
        uploadBucket:'opusloops-stem-uploads',sourceBucket:'opusloops-stem-sources',artifactBucket:'opusloops-stem-artifacts',bucketMap:mapping,sourceKey:claim.sourceKey,runPrefix:claim.runPrefix},
      inputs:claim.inputs,callback:{url:`${process.env.API_URL}/worker/callback`,token:createHmac('sha256',master).update(claim.attemptId.toLowerCase()).digest('hex')}};
    const result=await batch.send(new SubmitJobCommand({jobName,jobQueue:process.env.BATCH_JOB_QUEUE,jobDefinition:process.env[`BATCH_${claim.stage.toUpperCase()}_DEFINITION`],
      parameters:{payload_base64:Buffer.from(JSON.stringify(payload)).toString('base64')}}));
    if(!result.jobId)throw new Error('Uncertain Batch response');
    await rpc('record_stem_dispatch',{p_attempt_id:claim.attemptId,p_claim_id:claimId,p_external_job_id:result.jobId});
    return {state:'submitted',stage:claim.stage,attemptId:claim.attemptId,alreadyDispatched:false};
  } catch(error) {
    if(claim?.attemptId) {
      // Conservatively reconcile any error that might follow a successful submit.
      // Never submit the same attempt again merely because a response was lost.
      await rpc('record_stem_dispatch_unknown',{p_attempt_id:claim.attemptId,p_claim_id:claimId}).catch(()=>{});
    }
    return pending;
  }
}
