const fail=()=>Object.assign(new Error('Odesa Allowance Could Not Be Checked.'),{code:'invalid_allowance'});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function validateAllowance(value){
 if(!value||value.version!==1||!integer(value.checkedAt))throw fail();
 const out={version:1,checkedAt:value.checkedAt};
 for(const[name,duration]of [['minute',60000],['day',86400000]]){const w=value[name];if(!w||!integer(w.limit)||w.limit<1||w.limit>1000000||!integer(w.used)||!integer(w.remaining)||w.remaining!==Math.max(0,w.limit-w.used)||!integer(w.resetsAt)||w.resetsAt<=value.checkedAt||w.resetsAt>value.checkedAt+duration)throw fail();out[name]={limit:w.limit,used:w.used,remaining:w.remaining,resetsAt:w.resetsAt};}
 const exhausted=['minute','day'].map(name=>out[name]).filter(w=>!w.remaining);out.allowed=!exhausted.length;out.retryAt=exhausted.length?Math.max(...exhausted.map(w=>w.resetsAt)):null;if(out.allowed!==value.allowed||out.retryAt!==value.retryAt)throw fail();return out;
}
export function validateQuotaWindow(value){if(!value||value.version!==1||!['minute','day'].includes(value.window)||!integer(value.limit)||value.limit<1||!integer(value.checkedAt)||!integer(value.resetsAt)||value.resetsAt<=value.checkedAt||value.resetsAt>value.checkedAt+(value.window==='day'?86400000:60000))throw fail();return {version:1,window:value.window,limit:value.limit,checkedAt:value.checkedAt,resetsAt:value.resetsAt};}
export function readAllowanceRequest(prompt){
 if(typeof prompt!=='string')return false;
 const subject='(?:(?:my|the|current)\\s+)?(?:Odesa\\s+)?(?:(?:daily|minute|remaining)\\s+)?(?:allowance|quota|usage|request limits?|request allowance)',query='(?:(?:please\\s+)?(?:show|check|refresh)\\s+'+subject+'|what(?:[\'’]s| is| are)\\s+'+subject+'|when\\s+(?:does|will)\\s+'+subject+'\\s+reset|how many\\s+(?:Odesa\\s+)?requests\\s+(?:do I have left|are left|remain|can I send|can I make))';
 return new RegExp('^'+query+'\\s*[?.!]?$','i').test(prompt.trim());
}
export function canSubmitAllowance(state,{busy=false,signedIn=true,localControl=false}={}){return !busy&&(!signedIn||localControl||!state.blocked&&state.phase!=='checking');}
const formatTime=(at,{locale,timeZone}={})=>new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short',...(timeZone?{timeZone}:{})}).format(new Date(at));
export function describeAllowance(state,options={}){
 const date=at=>formatTime(at,options);
 const a=state.allowance;
 if(state.blocked){const name=state.limited?.window??(a?.day.remaining===0?'day':'minute'),at=state.limited?.resetsAt??a?.retryAt;return {summary:(name==='day'?'Daily':'Minute')+' Limit Reached · 0 Of '+(state.limited?.limit??a[name].limit)+' Left',detail:'Next Reset: '+date(at),title:'Planning Attempts Include Repairs.'};}
 if(state.phase==='checking')return {summary:'Checking Allowance…',detail:'',title:''};
 if(state.phase==='unavailable')return {summary:'Allowance Unavailable',detail:'Refresh Or Submit To Check With The Server.',title:''};
 if(a)return {summary:a.day.remaining+' Of '+a.day.limit+' Daily Requests Left',detail:a.minute.remaining+' Of '+a.minute.limit+' Minute Requests Left',title:'Checked '+date(a.checkedAt)+'. Planning Attempts Include Repairs. Other Visits Can Use Requests.'};
 return {summary:'Sign In To Check Allowance',detail:'',title:''};
}
export function describeAllowanceReport(state,options={}){if(!state.allowance){const text=describeAllowance(state,options);return text.summary+(text.detail?'. '+text.detail:'');}return ['day','minute'].map(name=>{const w=state.allowance[name];return (name==='day'?'Daily':'Minute')+': '+w.remaining+' Of '+w.limit+' Requests Left. Resets '+formatTime(w.resetsAt,options)+'.';}).join('\n');}
function waitFor(promise,signal){if(!signal)return promise;if(signal.aborted)return Promise.reject(signal.reason??new DOMException('Canceled','AbortError'));let abort;const stopped=new Promise((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Canceled','AbortError'));signal.addEventListener('abort',abort,{once:true});});return Promise.race([promise,stopped]).finally(()=>signal.removeEventListener('abort',abort));}
export function createAllowanceController({auth,onChange=()=>{},now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let generation=0,observation=null,limited=null,observedAt=0,limitedAt=0,phase='idle',reading=null,timer=null;
 const age=(limit=false)=>Math.max(0,now()-(limit?limitedAt:observedAt)),remainingWait=()=>limited?limited.resetsAt-limited.checkedAt-age(true):observation?.retryAt?observation.retryAt-observation.checkedAt-age():0;
 const snapshot=()=>({phase,allowance:observation?structuredClone(observation):null,limited:limited?{...limited}:null,blocked:remainingWait()>0});
 const emit=()=>onChange(snapshot()),clear=()=>{if(timer!==null)clearTimer(timer);timer=null;};
 function schedule(bound){clear();const reference=limited??observation;if(!reference)return;let target;if(limited)target=limited.resetsAt;else if(!observation.allowed)target=observation.retryAt;else{const used=['minute','day'].map(k=>observation[k]).filter(w=>w.used>0);if(!used.length)return;target=Math.min(...used.map(w=>w.resetsAt));}const delay=target-reference.checkedAt-age(!!limited);if(delay<=0)return;const version=generation;timer=setTimer(()=>{timer=null;if(version===generation)refresh({bound}).catch(()=>{});},Math.max(250,delay+250));}
 function reset(){generation++;clear();reading?.controller.abort();reading=null;observation=null;limited=null;observedAt=0;limitedAt=0;phase='idle';emit();}
 async function refresh({bound=auth.lease(),signal}={}){
  auth.assertLease(bound);const key=JSON.stringify([bound.version,bound.userId,bound.source]);if(reading?.key===key)return waitFor(reading.promise,signal);
  const version=generation,controller=new AbortController(),operation={key,controller,promise:null};phase='checking';emit();
  operation.promise=Promise.resolve().then(()=>auth.allowance({bound,signal:controller.signal})).then(result=>{auth.assertLease(bound);if(version!==generation||controller.signal.aborted)throw new DOMException('Canceled','AbortError');observation=validateAllowance(result?.allowance);limited=null;observedAt=now();phase='ready';emit();schedule(bound);return snapshot();}).catch(error=>{if(version===generation&&!controller.signal.aborted){phase='unavailable';emit();schedule(bound);}throw error;}).finally(()=>{if(reading===operation)reading=null;});reading=operation;return waitFor(operation.promise,signal);
 }
 function observeLimit(error,{bound=auth.lease()}={}){auth.assertLease(bound);if(error?.code!=='agent_limit')return;try{const value=validateQuotaWindow(error.quota),serverNow=observation?observation.checkedAt+age():Math.abs(now()-value.checkedAt)<300000?now():value.checkedAt;limited=value;limitedAt=now()-Math.max(0,serverNow-value.checkedAt);phase='ready';emit();schedule(bound);}catch{} }
 async function ensure(options={}){let state;try{state=await refresh(options);}catch(error){if(options.signal?.aborted||['session_changed','session_expired','session_missing'].includes(error.code))throw error;state=snapshot();}if(state.blocked){const description=describeAllowance(state);throw Object.assign(new Error(description.summary+'. '+description.detail),{code:'agent_limit',status:429});}return state;}
 return {snapshot,refresh,ensure,observeLimit,reset,dispose:reset};
}
