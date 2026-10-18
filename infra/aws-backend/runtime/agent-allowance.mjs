import {DynamoDBClient,GetItemCommand,UpdateItemCommand} from '@aws-sdk/client-dynamodb';
import {ApiError} from './common.mjs';
export const AGENT_WINDOWS=Object.freeze([{name:'minute',key:'m',duration:60000,limit:6},{name:'day',key:'d',duration:86400000,limit:100}].map(Object.freeze));
const client=new DynamoDBClient({maxAttempts:2}),send=c=>client.send(c,{abortSignal:AbortSignal.timeout(4000)});
const table=()=>process.env.STUDIO_AGENT_USAGE_TABLE||(()=>{throw new ApiError(503,'agent_not_configured','Agent Usage Controls Are Not Configured.');})();
const windows=(user,now)=>AGENT_WINDOWS.map(w=>({...w,id:user.id+':'+w.key+Math.floor(now/w.duration),resetsAt:(Math.floor(now/w.duration)+1)*w.duration}));
export async function readAgentAllowance(user,{send:request=send,now=Date.now()}={}){
 const TableName=table(),read=await Promise.all(windows(user,now).map(async w=>{const result=await request(new GetItemCommand({TableName,Key:{id:{S:w.id}},ConsistentRead:true,ProjectionExpression:'requests'}));const used=result.Item?Number(result.Item.requests?.N):0;if(!Number.isSafeInteger(used)||used<0)throw new ApiError(503,'allowance_unavailable','Odesa Allowance Could Not Be Checked.');return {name:w.name,limit:w.limit,used,remaining:Math.max(0,w.limit-used),resetsAt:w.resetsAt};}));
 const exhausted=read.filter(w=>w.remaining===0),retryAt=exhausted.length?Math.max(...exhausted.map(w=>w.resetsAt)):null;
 return {version:1,checkedAt:now,minute:Object.fromEntries(Object.entries(read[0]).filter(([k])=>k!=='name')),day:Object.fromEntries(Object.entries(read[1]).filter(([k])=>k!=='name')),allowed:!exhausted.length,retryAt};
}
// Admission retains its existing limits and conditional increments. Status
// reads never call this path, consume a request, or change/reset a counter.
export async function agentAllowance(user,{send:request=send,now=Date.now()}={}){
 const TableName=table();
 for(const w of windows(user,now))try{await request(new UpdateItemCommand({TableName,Key:{id:{S:w.id}},UpdateExpression:'SET expiresAt = :ttl ADD requests :one',ConditionExpression:'attribute_not_exists(requests) OR requests < :limit',ExpressionAttributeValues:{':ttl':{N:String(Math.floor(now/1000)+172800)},':one':{N:'1'},':limit':{N:String(w.limit)}}}));}
 catch(error){if(error.name!=='ConditionalCheckFailedException')throw error;throw Object.assign(new ApiError(429,'agent_limit',(w.name==='day'?'Daily':'Minute')+' Odesa Limit Reached. This Window Resets At '+new Date(w.resetsAt).toISOString()+'.'),{quota:{version:1,window:w.name,limit:w.limit,checkedAt:now,resetsAt:w.resetsAt},retryAfterSeconds:Math.max(1,Math.ceil((w.resetsAt-now)/1000))});}
}
