import { randomUUID } from 'node:crypto';
import { ApiError,db,rpc,uuid } from './common.mjs';
import { authenticate,tokenSession,getUser,updateUser,verifyEmail,signOut,createAccount } from './auth.mjs';
import { stemAction } from './stems.mjs';
import { callback } from './callback.mjs';
import { registerEvent,deleteRetainedObject } from './storage.mjs';
import { batchFailure,watchdog } from './lifecycle.mjs';

const origins=new Set(['https://opusloops.com','https://www.opusloops.com','https://main.d1zc92wmtmvg23.amplifyapp.com','http://127.0.0.1:4173','http://127.0.0.1:4174','http://localhost:4173']);
function response(status,body,origin='') {
  return {statusCode:status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    ...(origin?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,content-type,apikey,x-client-info','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS','Vary':'Origin'}:{})},body:status===204?'':JSON.stringify(body)};
}
async function retention() {
  const claimId=randomUUID();
  const claim=await rpc('claim_stem_retention',{p_claim_id:claimId,p_limit:20});
  let deleted=0,failed=0;
  for(const item of claim.items||[]) {
    try {
      if(typeof item.objectPath!=='string'||item.objectPath.split('/').length<4)throw new Error('Invalid retained object');
      uuid(item.itemId);uuid(item.objectPath.split('/')[0]);
      await deleteRetainedObject(item.bucket,item.objectPath);
      await rpc('complete_stem_retention_item',{p_claim_id:claimId,p_item_id:item.itemId});deleted++;
    } catch {
      failed++;
      await rpc('fail_stem_retention_item',{p_claim_id:claimId,p_item_id:item.itemId,p_error:'AWS storage cleanup could not complete'}).catch(()=>{});
    }
  }
  return {deleted,failed};
}
export async function handler(event) {
  // These events are delivered directly by IAM-authorized AWS services, never
  // deserialized from an HTTP body into the top-level Lambda envelope.
  if(event.source==='aws.s3'&&event['detail-type']==='Object Created')return registerEvent(event);
  if(event.source==='aws.events'&&event.action==='retention')return retention();
  if(event.source==='aws.events'&&event.action==='watchdog')return watchdog();
  if(event.source==='aws.batch'&&event['detail-type']==='Batch Job State Change')return batchFailure(event);
  const method=event.requestContext?.http?.method,path=event.rawPath||'';
  const headers=event.headers||{},origin=headers.origin||'';
  if(!method)return response(400,{code:'invalid_request',message:'Invalid request'});
  if(method==='GET'&&path==='/health')return response(200,{service:'opusloops',provider:'aws',version:1});
  let permittedOrigin='';
  try {
    const bytes=Buffer.from(event.body||'',event.isBase64Encoded?'base64':'utf8');
    if(path==='/worker/callback') {
      if(method!=='POST')throw new ApiError(405,'method_not_allowed','Use POST');
      return response(200,await callback(headers,bytes));
    }
    if(!origins.has(origin))throw new ApiError(403,'origin_denied','This origin is not enabled');
    permittedOrigin=origin;
    if(method==='OPTIONS')return response(204,null,origin);
    const limit=path==='/rest/v1/rpc/sync_projects'?4_300_000:path.startsWith('/auth/')||path.endsWith('create-opusloops-account')?4096:1_100_000;
    if(bytes.length>limit)throw new ApiError(413,'request_too_large','Request is too large');
    let body={};
    if(bytes.length) {
      try{body=JSON.parse(bytes.toString('utf8'));}catch{throw new ApiError(400,'invalid_request','Request JSON is invalid');}
      if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError(400,'invalid_request','Request must be an object');
    }
    if(method==='POST'&&path==='/auth/v1/token')return response(200,await tokenSession(body,event.queryStringParameters?.grant_type),origin);
    if(method==='POST'&&path==='/functions/v1/create-opusloops-account')return response(201,await createAccount(body),origin);
    const authorization=headers.authorization||'';
    if(!authorization.startsWith('Bearer '))throw new ApiError(401,'authentication_required','Sign in to continue');
    const user=await authenticate(authorization.slice(7));
    if(path==='/auth/v1/user'&&method==='GET')return response(200,await getUser(user),origin);
    if(path==='/auth/v1/user'&&method==='PUT')return response(200,await updateUser(user,body),origin);
    if(path==='/auth/v1/verify-email'&&method==='POST')return response(200,await verifyEmail(user,body),origin);
    if(path==='/auth/v1/logout'&&method==='POST'){await signOut(user,body);return response(204,null,origin);}
    if(path==='/rest/v1/rpc/sync_projects'&&method==='POST')return response(200,await rpc('sync_projects',{p_changes:body.p_changes},user),origin);
    if(path==='/rest/v1/rpc/get_stem_import_event_snapshot'&&method==='POST')return response(200,await rpc('get_stem_import_event_snapshot',{p_job_id:uuid(body.p_job_id),p_after_sequence:body.p_after_sequence||0},user),origin);
    if(path==='/rest/v1/stem_import_assets'&&method==='GET') {
      const jobId=event.queryStringParameters?.job_id;
      if(!jobId?.startsWith('eq.'))throw new ApiError(400,'invalid_request','Job filter is required');
      return response(200,await db({operation:'assets',identity:user,jobId:uuid(jobId.slice(3)),offset:Number(event.queryStringParameters?.offset||0)}),origin);
    }
    if(path==='/functions/v1/stem-import'&&method==='POST'){const result=await stemAction(user,body);return response(result.status,result.body,origin);}
    throw new ApiError(404,'not_found','Endpoint not found');
  } catch(error) {
    if(error instanceof ApiError)return response(error.status,{code:error.code,message:error.message},permittedOrigin);
    const authErrors={NotAuthorizedException:[401,'invalid_credentials','Email or password is incorrect'],UserNotFoundException:[401,'invalid_credentials','Email or password is incorrect'],TooManyRequestsException:[429,'rate_limited','Please wait and try again'],InvalidPasswordException:[400,'weak_password','Choose a stronger password'],AliasExistsException:[409,'account_exists','That email is already in use'],CodeMismatchException:[400,'invalid_code','Verification code is incorrect'],ExpiredCodeException:[400,'expired_code','Verification code has expired']};
    const [status,code,message]=authErrors[error.name]||[503,'service_unavailable','This service is temporarily unavailable'];
    return response(status,{code,message},permittedOrigin);
  }
}
