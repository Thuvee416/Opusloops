import {validateProject} from './model.js';
import {liveMidiLocked} from './live-midi-edit.js';
import {sendKey,hasEnvelope} from './automation.js';
import {automationTargetFor} from './automation-targets.js';
const json=value=>JSON.stringify(value);
const fields=['volume','pan','mute','solo','crossfade','sends'];
const same=(a,b)=>json(a)===json(b);
function sendStructure(sends){return Object.fromEntries(Object.entries(sends??{}).flatMap(([id,send])=>{if(!send||typeof send!=='object'||Array.isArray(send))return [[id,send]];const {amount,pre,...rest}=send;return Object.keys(rest).length?[[id,rest]]:[];}));}
// Classify the complete snapshot, not an action label. Graph topology, envelopes,
// devices, source notes and all other project data must remain exactly unchanged.
export function mixerChanges(previous,next){
 if(!previous||!next||!Array.isArray(previous.tracks)||!Array.isArray(next.tracks)||next.tracks.length!==previous.tracks.length||next.returns?.length!==previous.returns?.length)return null;
 const changes=[],candidate={...next};
 for(const scope of ['tracks','returns']){
  if(!previous[scope])continue;
  candidate[scope]=next[scope].map((target,i)=>{
   const source=previous[scope][i],restored={...target};if(source.id!==target.id)return target;
   for(const key of fields){
    if(same(source[key],target[key])&&Object.hasOwn(source,key)===Object.hasOwn(target,key))continue;
    if(key==='sends'&&!same(sendStructure(source.sends),sendStructure(target.sends)))continue;
    changes.push({scope,id:source.id,key,present:Object.hasOwn(target,key),value:target[key]});
    if(Object.hasOwn(source,key))restored[key]=source[key];else delete restored[key];
   }
   return restored;
  });
 }
 for(const key of ['master','crossfade'])if(!same(previous[key],next[key])||Object.hasOwn(previous,key)!==Object.hasOwn(next,key)){
  changes.push({scope:'project',key,present:Object.hasOwn(next,key),value:next[key]});
  if(Object.hasOwn(previous,key))candidate[key]=previous[key];else delete candidate[key];
 }
 return same(previous,candidate)?changes:null;
}
function automationKeys(project,changes){
 const keys=[];
 for(const change of changes){
  if(change.scope==='project')continue;
  if(['volume','pan'].includes(change.key))keys.push({id:change.id,key:change.key});
  if(change.key==='sends'){
   const track=project[change.scope].find(t=>t.id===change.id);
   for(const id of new Set([...Object.keys(track.sends??{}),...Object.keys(change.value??{})]))if((track.sends?.[id]?.amount??0)!==(change.value?.[id]?.amount??0))keys.push({id:change.id,key:sendKey(id)});
  }
 }
 return keys;
}
export function applyLiveMixerSnapshot(engine,next,options){
 try{return applyMixerSnapshot(engine,next,options);}catch(error){error.agentEditsApplied=false;error.agentHistoryApplied=false;throw error;}
}
function applyMixerSnapshot(engine,next,{signal,current=()=>true,automationState}={}){
 signal?.throwIfAborted();
 if(liveMidiLocked(engine)||engine.midiEditPending)throw Error('Finish Recording Or Playback Preparation Before Restoring The Mix.');
 const project=engine.project,changes=mixerChanges(project,next);
 if(!changes?.length)throw Error('Only Mixer Values Can Change In A Live Mix Transaction.');
 validateProject(next);
 const affected=automationKeys(project,changes),beforeOverrides=engine.automationOverrides,overrides=new Set(beforeOverrides),beforeMaster=engine.masterVolume;
 if(automationState!==undefined){const target=new Set(automationState);for(const {id,key} of affected){const token=id+':'+key;overrides.delete(token);if(target.has(token))overrides.add(token);}}
 else if(engine.mode==='arrangement')for(const {id,key} of affected){const track=[...project.tracks,...project.returns??[]].find(t=>t.id===id);if(hasEnvelope(automationTargetFor(track,key,project.returns)?.envelope))overrides.add(id+':'+key);}
 const patches=changes.map(change=>{const owner=change.scope==='project'?project:project[change.scope].find(t=>t.id===change.id);return {owner,key:change.key,present:change.present,value:structuredClone(change.value),before:owner[change.key],existed:Object.hasOwn(owner,change.key)};});
 if(!current())throw Error('The Project Or History Changed Before The Mix Could Be Restored.');signal?.throwIfAborted();
 try{
  for(const p of patches){if(p.present)p.owner[p.key]=p.value;else delete p.owner[p.key];}
  engine.masterVolume=project.master??.8;engine.automationOverrides=overrides;
  engine.restoreAutomation(false,{notify:false});
 }catch(error){
  for(const p of patches){if(p.existed)p.owner[p.key]=p.before;else delete p.owner[p.key];}
  engine.masterVolume=beforeMaster;engine.automationOverrides=beforeOverrides;
  try{engine.restoreAutomation(false,{notify:false});}catch(restore){error.message+=' Audio Restoration Also Failed; Stop Playback Before Continuing. '+restore.message;}
  error.agentEditsApplied=false;error.agentHistoryApplied=false;throw error;
 }
 return {changes:changes.length};
}
