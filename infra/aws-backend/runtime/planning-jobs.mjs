import {randomUUID,createHash} from 'node:crypto';
import {DynamoDBClient,GetItemCommand,PutItemCommand,UpdateItemCommand} from '@aws-sdk/client-dynamodb';
import {InvokeCommand} from '@aws-sdk/client-lambda';
import {ApiError,lambda,uuid} from './common.mjs';
import {studioAgent,agentAllowance,validatePlanningRequest} from './studio-agent.mjs';

export const PLAN_DEADLINE_MS=150000,PLAN_RETENTION_SECONDS=900,PLAN_MODEL_BUDGET_MS=100000;
const terminal=new Set(['succeeded','failed','cancelled','expired']);
const dynamo=new DynamoDBClient({maxAttempts:2});
const encode=value=>typeof value==='number'?{N:String(value)}:typeof value==='boolean'?{BOOL:value}:{S:String(value)};
const item=row=>Object.fromEntries(Object.entries(row).filter(([,v])=>v!==undefined).map(([k,v])=>[k,encode(v)]));
const decode=row=>row?Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v.S??(v.N!==undefined?Number(v.N):v.BOOL)])):null;
const table=()=>process.env.STUDIO_AGENT_PLANS_TABLE||(()=>{throw new ApiError(503,'agent_not_configured','Queued Planning Is Not Available Yet.');})();
const send=command=>dynamo.send(command,{abortSignal:AbortSignal.timeout(4000)});
export const planningStore={
 async read(id){return decode((await send(new GetItemCommand({TableName:table(),Key:{id:{S:id}},ConsistentRead:true}))).Item);},
 async create(row){try{await send(new PutItemCommand({TableName:table(),Item:item(row),ConditionExpression:'attribute_not_exists(id)'}));return true;}catch(error){if(error.name==='ConditionalCheckFailedException')return false;throw error;}},
 async patch(id,expected,changes,remove=[]){
  const names={},values={},condition=[],set=[],del=[];let i=0;
  for(const [key,value]of Object.entries(expected)){const n='#c'+i,v=':c'+i++;names[n]=key;values[v]=encode(value);condition.push(n+' = '+v);}
  for(const [key,value]of Object.entries(changes)){const n='#v'+i,v=':v'+i++;names[n]=key;values[v]=encode(value);set.push(n+' = '+v);}
  for(const key of remove){const n='#r'+i++;names[n]=key;del.push(n);}
  try{return decode((await send(new UpdateItemCommand({TableName:table(),Key:{id:{S:id}},ConditionExpression:condition.join(' AND '),UpdateExpression:(set.length?'SET '+set.join(', '):'')+(del.length?' REMOVE '+del.join(', '):''),ExpressionAttributeNames:names,ExpressionAttributeValues:values,ReturnValues:'ALL_NEW'}))).Attributes);}catch(error){if(error.name==='ConditionalCheckFailedException')return null;throw error;}
 }
};
export const isPlannerEvent=event=>event?.source==='opusloops.agent-planner'&&event.version===1&&event.requestContext===undefined&&event.rawPath===undefined;
const errorData=error=>error instanceof ApiError?{code:error.code,message:error.message,status:error.status,...(error.quota?{quota:error.quota}:{})}:{code:'planning_unavailable',message:'Planning Could Not Finish. No Project Changes Were Applied.',status:503};
const expired=()=>new ApiError(410,'planning_expired','This Planning Request Has Expired. Run The Request Again.');

export function createPlanningJobs({store=planningStore,allowance=agentAllowance,planner=studioAgent,now=()=>Date.now(),newId=randomUUID,checkIntervalMs=1500,invoke=async event=>{const r=await lambda.send(new InvokeCommand({FunctionName:process.env.STUDIO_AGENT_PLANNER_FUNCTION,InvocationType:'Event',Payload:Buffer.from(JSON.stringify(event))}),{abortSignal:AbortSignal.timeout(8000)});if(r.StatusCode!==202)throw new Error('Planning Start Was Not Confirmed');}}={}){
 const key=(owner,id)=>uuid(owner)+':'+uuid(id);
 const view=row=>({id:row.requestId,status:row.status,phase:row.phase,createdAt:row.createdAt,deadlineAt:row.deadlineAt,expiresAt:row.expiresAt,...(row.status==='succeeded'?{result:JSON.parse(row.resultJson)}:{}),...(row.status==='failed'?{error:JSON.parse(row.errorJson)}:{})});
 async function owned(owner,id){const row=await store.read(key(owner,id));if(!row||row.ownerId!==owner)throw new ApiError(404,'planning_not_found','Planning Request Not Found.');if(row.expiresAt<=Math.floor(now()/1000)){await store.patch(row.id,{nonce:row.nonce,status:row.status},{status:'expired',phase:'expired'},['payloadJson','resultJson']).catch(()=>{});throw expired();}return row;}
 async function status(user,id){let row=await owned(user.id,id);if(!terminal.has(row.status)&&now()>=row.deadlineAt){row=await store.patch(row.id,{nonce:row.nonce,status:row.status},{status:'failed',phase:'failed',finishedAt:now(),errorJson:JSON.stringify({code:'agent_timeout',message:'Planning Took Too Long. No Project Changes Were Applied. Run The Request Again.',status:504})},['payloadJson','resultJson'])??await owned(user.id,id);}return view(row);}
 async function submit(user,body){
  validatePlanningRequest(body);const requestId=uuid(body.planningRequestId),id=key(user.id,requestId),payloadJson=JSON.stringify({prompt:body.prompt,context:body.context,...(body.feedback?{feedback:body.feedback}:{})}),payloadHash=createHash('sha256').update(payloadJson).digest('hex');
  const existing=await store.read(id);
  const reuse=async row=>{if(row.ownerId!==user.id)throw new ApiError(404,'planning_not_found','Planning Request Not Found.');if(row.expiresAt<=Math.floor(now()/1000))throw expired();if(row.status==='cancelled'&&!row.payloadHash)return view(row);if(row.payloadHash!==payloadHash)throw new ApiError(409,'planning_request_changed','This Request ID Belongs To Different Planning Details. Run A New Request.');return status(user,requestId);};
  if(existing)return reuse(existing);
  let row={id,ownerId:user.id,requestId,nonce:newId(),status:'admitting',phase:'queued',payloadJson,payloadHash,createdAt:now(),deadlineAt:now()+PLAN_DEADLINE_MS,expiresAt:Math.floor(now()/1000)+PLAN_RETENTION_SECONDS};
  if(!await store.create(row))return reuse(await store.read(id));
  try{await allowance(user);}catch(error){await store.patch(id,{nonce:row.nonce,status:'admitting'},{status:'failed',phase:'failed',errorJson:JSON.stringify(errorData(error)),finishedAt:now()},['payloadJson']);throw error;}
  row=await store.patch(id,{nonce:row.nonce,status:'admitting'},{status:'queued',phase:'queued'});if(!row)return status(user,requestId);
  try{await invoke({source:'opusloops.agent-planner',version:1,ownerId:user.id,jobId:requestId,nonce:row.nonce});}
  catch(error){
   // Atomically stop an unstarted request. If a worker already claimed it, keep
   // observing that SAME request rather than pretending a lost ACK is terminal.
   const stopped=await store.patch(id,{nonce:row.nonce,status:'queued'},{status:'failed',phase:'failed',finishedAt:now(),errorJson:JSON.stringify({code:'planning_start_unconfirmed',message:'Planning Could Not Start. No Project Changes Were Applied. Please Try Again.',status:503})},['payloadJson']);
   if(stopped)return view(stopped);
  }
  return status(user,requestId);
 }
 async function cancel(user,requestId){
  const id=key(user.id,requestId);let row=await store.read(id);
  // A tombstone also cancels a POST still in transit/authentication, before its
  // admission row exists. It is owner-scoped and cannot cancel another account.
  if(!row){const tombstone={id,ownerId:user.id,requestId,nonce:newId(),status:'cancelled',phase:'cancelled',createdAt:now(),deadlineAt:now(),expiresAt:Math.floor(now()/1000)+PLAN_RETENTION_SECONDS,finishedAt:now()};if(await store.create(tombstone))return view(tombstone);row=await owned(user.id,requestId);}
  if(row.ownerId!==user.id)throw new ApiError(404,'planning_not_found','Planning Request Not Found.');if(row.expiresAt<=Math.floor(now()/1000))throw expired();
  for(let attempt=0;attempt<4;attempt++){if(['cancelled','failed','expired'].includes(row.status))return view(row);const stopped=await store.patch(id,{nonce:row.nonce,status:row.status},{status:'cancelled',phase:'cancelled',finishedAt:now()},['payloadJson','resultJson']);if(stopped)return view(stopped);row=await owned(user.id,requestId);}
  throw new ApiError(409,'planning_state_changed','Planning Changed While Canceling. This Browser Has Stopped The Request.');
 }
 async function run(event){
  if(!isPlannerEvent(event))throw new ApiError(400,'invalid_planner_event','Invalid Planning Worker Event.');const id=key(event.ownerId,event.jobId),nonce=uuid(event.nonce),row=await store.read(id);
  if(!row||row.ownerId!==event.ownerId||row.nonce!==nonce||row.status!=='queued')return {skipped:true};
  if(now()>=row.deadlineAt||row.expiresAt<=Math.floor(now()/1000)){await status({id:event.ownerId},event.jobId).catch(()=>{});return {expired:true};}
  const claimed=await store.patch(id,{nonce,status:'queued'},{status:'running',phase:'drafting',startedAt:now()});if(!claimed)return {skipped:true};
  const controller=new AbortController();let flight=null;
  const tick=()=>{if(flight)return;flight=Promise.resolve().then(()=>store.read(id)).then(current=>{if(!current||current.nonce!==nonce||current.status!=='running'||now()>=current.deadlineAt)controller.abort();}).catch(()=>{/* A transient observation failure is not terminal. */}).finally(()=>{flight=null;});};
  const timer=setInterval(tick,checkIntervalMs);
  try{
   const budgetMs=Math.max(1000,Math.min(PLAN_MODEL_BUDGET_MS,row.deadlineAt-now()-5000));
   const result=await planner(JSON.parse(claimed.payloadJson),{budgetMs,signal:controller.signal,onPhase:async phase=>{if(!['drafting','reviewing'].includes(phase))return;const changed=await store.patch(id,{nonce,status:'running'},{phase});if(!changed){controller.abort();throw new ApiError(409,'agent_cancelled','Planning Was Canceled.');}}});
   if(controller.signal.aborted||now()>=row.deadlineAt)throw new ApiError(504,'agent_timeout','Planning Took Too Long. No Project Changes Were Applied.');
   if(!result||typeof result.summary!=='string'||!Array.isArray(result.actions)||(result.question!==undefined&&(typeof result.question!=='string'||!result.question.trim()||result.actions.length))||(!result.question&&result.reviewed!==true))throw new ApiError(502,'invalid_agent_plan','Planning Did Not Return A Reviewed Plan. No Project Changes Were Applied.');
   const resultJson=JSON.stringify(result);if(Buffer.byteLength(resultJson)>180000)throw new ApiError(502,'invalid_agent_plan','The Plan Is Too Large. Request Fewer Changes At Once.');
   const saved=await store.patch(id,{nonce,status:'running'},{status:'succeeded',phase:'complete',finishedAt:now(),resultJson},['payloadJson']);return {completed:!!saved};
  }catch(error){const saved=await store.patch(id,{nonce,status:'running'},{status:'failed',phase:'failed',finishedAt:now(),errorJson:JSON.stringify(errorData(error))},['payloadJson','resultJson']);return {failed:!!saved};}
  finally{clearInterval(timer);if(flight)await flight;}
 }
 return {submit,status,cancel,run};
}
export const planningJobs=createPlanningJobs();
