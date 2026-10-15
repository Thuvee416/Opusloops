import {AUTOMATION,SEND_AUTOMATION,sendKey,scheduleEnvelope} from './automation.js';
import {DEVICE_TYPES,deviceAutomationSpecs,deviceParameters} from './devices.js';
export const deviceKey=(id,key)=>JSON.stringify(['device',id,key]);
export const automationChannels=p=>[...p.tracks,...(p.returns||[])];
export function automationTargets(track,returns=[]){return [...Object.entries(AUTOMATION).map(([key,spec])=>({key,paramKey:key,owner:track,spec,specs:AUTOMATION,fallback:track[key],label:key==='volume'?'Volume':'Pan',envelope:track.automation?.[key],enabled:true})),...sendTargets(track,returns),...(track.devices||[]).flatMap((d,i)=>{const specs=deviceAutomationSpecs(d.type);return Object.entries(specs).map(([paramKey,spec])=>({key:deviceKey(d.id,paramKey),paramKey,owner:d,device:d,spec,specs,fallback:deviceParameters(d)[paramKey],label:`${i+1}. ${DEVICE_TYPES[d.type].name} · ${paramKey}${d.enabled?'':' (bypassed)'}`,envelope:d.automation?.[paramKey],enabled:d.enabled}));})];}
export function automationTargetFor(track,key,returns=[]){return automationTargets(track,returns).find(t=>t.key===key);}
export function scheduleTarget(mixer,target,start,length,time,spb,sampleRate){if(target.sendId){const send=mixer.sends.get(target.sendId),pre=target.pre();if(!send)return;for(const name of ['pre','post'])if((name==='pre')===pre)scheduleEnvelope(send[name].gain,target.envelope,start,length,time,spb,target.fallback,sampleRate);else send[name].gain.setValueAtTime(0,time);}else if(target.device)mixer.chain.schedule(target.device.id,target.paramKey,target.envelope,start,length,time,spb,target.fallback);else scheduleEnvelope(target.key==='volume'?mixer.gain.gain:mixer.pan.pan,target.envelope,start,length,time,spb,target.fallback,sampleRate);}

// Reading targets must not create sends in a project. This owner adapter creates
// the optional send only when an envelope is actually edited or recorded.
function sendTargets(track,returns){if(!Array.isArray(track.slots))return [];return returns.map(r=>{
 const setting=()=>track.sends?.[r.id],owner={get automation(){return setting()?.automation;},set automation(value){track.sends??={};track.sends[r.id]??={amount:0,pre:false};track.sends[r.id].automation=value;}};
 return {key:sendKey(r.id),paramKey:'amount',owner,spec:SEND_AUTOMATION.amount,specs:SEND_AUTOMATION,fallback:setting()?.amount??0,label:'Send → '+r.name,envelope:setting()?.automation?.amount,enabled:true,sendId:r.id,pre:()=>setting()?.pre??false};
});}
