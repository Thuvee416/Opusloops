const fail=(message,code='invalid_response',status=502)=>Object.assign(new Error(message),{code,status});
const canceled=signal=>{if(signal?.aborted)throw signal.reason??new DOMException('Canceled','AbortError');};
const transient=error=>!error.status||[408,429,500,502,503,504].includes(error.status);
const states=new Set(['admitting','queued','running','succeeded','failed','cancelled','expired']);
const pause=(ms,signal)=>new Promise((resolve,reject)=>{canceled(signal);const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason??new DOMException('Canceled','AbortError'));}signal?.addEventListener('abort',abort,{once:true});});

// One immutable handle survives retries and transient observation failures.
// Server planning never edits a project; the normal client preflight/Undo path
// remains the only executor after the account/project/selection checks pass.
export async function queuedPlanning(body,{request,signal,onProgress=()=>{},now=()=>Date.now(),wait=pause,newId=()=>crypto.randomUUID(),timeout=180000,pollInterval=1500}={}){
 canceled(signal);const id=newId(),payload={...structuredClone(body),planningRequestId:id},deadline=now()+timeout;
 let job=null,terminal=false,complete=false,submitted=false,ambiguous=false,confirmedRejected=false,lastPhase=null;
 const progress=next=>{if(next.status==='succeeded')return;const phase=next.status==='running'?next.phase:next.status;if(phase!==lastPhase){lastPhase=phase;onProgress({status:next.status,phase,id});}};
 function envelope(response){const value=response?.planningJob;if(!value||value.id!==id||!states.has(value.status))throw fail('Odesa Returned An Invalid Planning Status. No Changes Were Applied.');return value;}
 try{
  for(let attempt=0;attempt<2;attempt++){
   canceled(signal);if(now()>=deadline)break;submitted=true;
   try{const response=await request('/functions/v1/studio-agent',payload,{signal,timeout:Math.max(1,Math.min(12000,deadline-now()))});canceled(signal);
    // Older servers and controlled test fixtures can still return an inline plan.
    if(response&&typeof response.summary==='string'&&Array.isArray(response.actions)){complete=true;return response;}
    job=envelope(response);break;
   }catch(error){canceled(signal);if(['agent_limit','agent_timeout','invalid_agent_plan','invalid_agent_request','agent_not_configured'].includes(error.code)){confirmedRejected=!ambiguous;throw error;}if(!transient(error)){confirmedRejected=!ambiguous&&error.status>=400&&error.status<500&&!['session_changed','session_expired','session_missing'].includes(error.code);throw error;}ambiguous=true;if(attempt===0)await wait(Math.min(1000,pollInterval),signal);}
  }
  while(now()<deadline){
   canceled(signal);
   if(job){
    if(job.status==='succeeded'){terminal=true;if(!job.result||typeof job.result.summary!=='string'||!Array.isArray(job.result.actions))throw fail('Odesa Did Not Return A Valid Plan. No Changes Were Applied.');complete=true;return job.result;}
    if(job.status==='failed'){terminal=true;throw fail(String(job.error?.message||'Planning Could Not Finish. No Changes Were Applied.'),String(job.error?.code||'planning_unavailable'),Number(job.error?.status)||503);}
    if(job.status==='cancelled'){terminal=true;throw new DOMException('Planning Was Canceled. No Changes Were Applied.','AbortError');}
    if(job.status==='expired'){terminal=true;throw fail('This Planning Request Has Expired. Run It Again.','planning_expired',410);}
    progress(job);await wait(Math.min(pollInterval,Math.max(1,deadline-now())),signal);
   }
   if(now()>=deadline)break;
   try{job=envelope(await request('/functions/v1/studio-agent-jobs',{action:'status',jobId:id},{signal,timeout:Math.max(1,Math.min(8000,deadline-now()))}));}
   catch(error){canceled(signal);if(!transient(error)&&!(ambiguous&&error.status===404))throw error;job=null;await wait(Math.min(pollInterval,Math.max(1,deadline-now())),signal);}
  }
  throw fail('Odesa Is Taking Too Long. This Browser Has Stopped The Request. No Project Changes Were Applied.','request_timeout',504);
 }finally{
  if(submitted&&!complete&&!terminal&&!confirmedRejected){
   // A fresh signal lets cancellation reach the server after the local waiter
   // aborts. The account transport still enforces the ORIGINAL account lease.
   Promise.resolve().then(()=>request('/functions/v1/studio-agent-jobs',{action:'cancel',jobId:id},{timeout:5000})).catch(()=>{});
  }
 }
}

export function planningStateFingerprint(studio={}){
 const data=Object.fromEntries(['view','playing','performanceMode','insertMarker','selection','selectedSession','selectedTracks','selectedRegion','selectedRegions','selectedScene','noteSelection','noteQuantization','foldedGroups','deviceTrackId','detailPanel','detailExpanded','delivery'].map(key=>[key,studio[key]??null]));
 data.recordingPreferences=Object.fromEntries(['mode','source','trackId','countInBars','audioConnected','recordQuantization'].map(key=>[key,studio.recording?.[key]??null]));
 return JSON.stringify(data,(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
}
