import {queuedPlanning} from './queued-planning.js';
export const STUDIO_API='https://2psb3vs3pl.execute-api.us-east-1.amazonaws.com';
const PRIVATE='opus.agent.session',SHARED='opusloops.auth.session.aws.v1',IGNORE='opus.agent.ignoreShared';
const authError=(message,code='session_missing',status=401)=>Object.assign(new Error(message),{code,status});
const signInMessage='Sign in with your OPUS account to use the agent.';
const changed=()=>authError('The signed-in account changed. This request was stopped.','session_changed',409);
const usable=s=>s&&typeof s.access_token==='string'&&s.access_token.length>0&&s.access_token.length<=8192;
const identity=r=>r?JSON.stringify([r.source,r.session.user?.id??null,r.session.refresh_token??r.session.access_token]):null;
const sameUser=(a,b)=>a===b;
const publicUser=user=>user?{id:user.id,email:typeof user.email==='string'?user.email:''}:null;
function canceled(signal){if(signal?.aborted)throw signal.reason??new DOMException('Canceled','AbortError');}
async function waitFor(promise,signal){
 canceled(signal);if(!signal)return promise;
 let listener;const abort=new Promise((_,reject)=>{listener=()=>reject(signal.reason??new DOMException('Canceled','AbortError'));signal.addEventListener('abort',listener,{once:true});});
 try{return await Promise.race([promise,abort]);}finally{signal.removeEventListener('abort',listener);}
}
// One account-bound transport for sign-in, renewal and every planning/repair call.
// Tokens remain in browser storage and are never returned as UI observations.
export function createAgentSession({privateStorage=globalThis.sessionStorage,sharedStorage=globalThis.localStorage,fetcher=globalThis.fetch,now=()=>Date.now(),onChange=()=>{},base=STUDIO_API,authTimeout=20000,planTimeout=90000}={}){
 let current=null,version=0,refreshing=null,volatile=null,locallySignedOut=false,initialized=false;
 const readText=(storage,key)=>{try{return storage.getItem(key);}catch{return null;}};
 const parse=text=>{try{const s=JSON.parse(text||'null');return usable(s)?s:null;}catch{return null;}};
 function read(){
  if(locallySignedOut)return null;
  if(volatile){const persisted=readText(volatile.source==='private'?privateStorage:sharedStorage,volatile.source==='private'?PRIVATE:SHARED);if(persisted===volatile.previous)return volatile.record;volatile=null;}
  const own=parse(readText(privateStorage,PRIVATE));if(own)return {source:'private',session:own};
  if(readText(privateStorage,IGNORE))return null;const shared=parse(readText(sharedStorage,SHARED));return shared?{source:'shared',session:shared}:null;
 }
 function publish(accountChanged=false){onChange({accountChanged,available:!!current,user:publicUser(current?.session.user)});}
 function sync(){const next=read(),different=identity(next)!==identity(current),updated=JSON.stringify(next)!==JSON.stringify(current);if(initialized&&different)version++;current=next;const first=!initialized;initialized=true;if(!first&&updated)publish(different);return current;}
 function assertLease(lease){sync();if(!current||lease.version!==version||lease.source!==current.source||!sameUser(lease.userId,current.session.user?.id))throw changed();return current;}
 function lease(){const record=sync();if(!record)throw authError(signInMessage);return {version,userId:record.session.user?.id,source:record.source};}
 function write(record,{accountChanged=false}={}){
  const storage=record.source==='private'?privateStorage:sharedStorage,key=record.source==='private'?PRIVATE:SHARED,previous=readText(storage,key),text=JSON.stringify(record.session);locallySignedOut=false;
  try{storage.setItem(key,text);volatile=null;}catch{volatile={source:record.source,previous,record};}
  current=record;initialized=true;if(accountChanged)version++;publish(accountChanged);
 }
 function invalidate(bound){try{const r=assertLease(bound),storage=r.source==='private'?privateStorage:sharedStorage;try{storage.removeItem(r.source==='private'?PRIVATE:SHARED);}catch{}try{privateStorage.removeItem(PRIVATE);privateStorage.setItem(IGNORE,'true');}catch{}current=null;volatile=null;locallySignedOut=true;version++;publish(true);}catch{} }
 async function raw(path,body,{token,signal,timeout=authTimeout}={}){
  canceled(signal);const controller=new AbortController(),abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
  try{
   const response=await fetcher(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
   let result=null;try{if(response.status!==204)result=await response.json();}catch{if(response.ok)throw authError('The agent service returned an invalid response.','invalid_response',502);}
   canceled(signal);if(timedOut)throw authError('The agent service took too long. Try again.','request_timeout',504);if(!response.ok){const error=authError(response.status===404?'The agent service is unavailable. Your session has not changed.':String(result?.message||'Agent service unavailable'),String(result?.code||'service_unavailable'),response.status);throw error;}return result;
  }catch(error){canceled(signal);if(timedOut)throw authError('The agent service took too long. Try again.','request_timeout',504);throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 function normalized(result,previous){
  const value={...result,refresh_token:result?.refresh_token??previous?.refresh_token};
  if(!usable(value)||typeof value.refresh_token!=='string'||!value.refresh_token||typeof value.user?.id!=='string'||!value.user.id||!Number.isFinite(value.expires_at)||value.expires_at<=now()/1000+30)throw authError('The sign-in service returned an invalid response. Try again.','invalid_session',502);
  return value;
 }
 async function refresh(bound){
  const starting=assertLease(bound),s=starting.session;if(!s.refresh_token||!s.user?.id){invalidate(bound);throw authError('Your sign-in has ended. Sign in again.');}
  if(refreshing?.version===bound.version)return refreshing.promise;
  const operation={version:bound.version,promise:null};
  operation.promise=(async()=>{
   try{
    const result=normalized(await raw('/auth/v1/token?grant_type=refresh_token',{refresh_token:s.refresh_token}),s);assertLease(bound);
    if(result.user.id!==bound.userId)throw changed();write({source:starting.source,session:result});return result;
   }catch(error){if([400,401,403].includes(error.status)){invalidate(bound);throw authError('Your sign-in has ended. Sign in again.','session_expired');}throw error;}
   finally{if(refreshing===operation)refreshing=null;}
  })();refreshing=operation;return operation.promise;
 }
 async function authorized(path,body,{signal,bound=lease(),timeout=planTimeout}={}){
  canceled(signal);let record=assertLease(bound),s=record.session;
  if(Number.isFinite(s.expires_at)&&s.expires_at<=now()/1000+60){await waitFor(refresh(bound),signal);record=assertLease(bound);s=record.session;}
  let result;
  try{result=await raw(path,body,{token:s.access_token,signal,timeout});}
  catch(error){canceled(signal);assertLease(bound);if(error.status!==401)throw error;await waitFor(refresh(bound),signal);const renewed=assertLease(bound).session;try{result=await raw(path,body,{token:renewed.access_token,signal,timeout});}catch(retryError){canceled(signal);assertLease(bound);if(retryError.status===401){invalidate(bound);throw authError('Your sign-in has ended. Sign in again.','session_expired');}throw retryError;}}
  canceled(signal);assertLease(bound);return result;
 }
 async function plan(body,{signal,bound=lease(),onProgress}={}){if(body.context?.planningTransport?.version!==1)return authorized('/functions/v1/studio-agent',body,{signal,bound});return queuedPlanning(body,{signal,now,request:(path,payload,options)=>authorized(path,payload,{...options,bound}),onProgress:state=>{assertLease(bound);onProgress?.(state);}});}
 async function signIn(email,password){
  sync();const expected=version;const result=normalized(await raw('/auth/v1/token?grant_type=password',{email,password}));sync();if(version!==expected)throw changed();
  try{privateStorage.removeItem(IGNORE);}catch{}write({source:'private',session:result},{accountChanged:true});return {user:publicUser(result.user)};
 }
 async function signOut(){
  const record=sync();if(!record)return {remote:false};const bound=lease(),s=record.session;invalidate(bound);
  try{await raw('/auth/v1/logout?scope=local',s.refresh_token?{refresh_token:s.refresh_token}:{},{token:s.access_token});return {remote:true};}catch{return {remote:false};}
 }
 function snapshot(){const r=sync();return {available:!!r,user:publicUser(r?.session.user),version};}
 sync();return {snapshot,lease,assertLease,plan,signIn,signOut,sync};
}
