import {editEnvelope,validateAutomation} from './automation.js';
import {automationChannels,automationTargets,automationTargetFor,deviceKey} from './automation-targets.js';
import {sendKey} from './automation.js';

// Manual and agent edits resolve the same owner, ranges and parameter support.
export function editAutomationTarget(track,key,action,options={},returns=[]){
 const target=automationTargetFor(track,key,returns);
 if(!target)throw new Error('Choose an existing automatable parameter.');
 const {owner,paramKey,specs}=target;
 if(action==='remove'){
  const automation=structuredClone(owner.automation||{});delete automation[paramKey];
  if(Object.hasOwn(owner.automation||{},paramKey))owner.automation=automation;
 }else if(action==='replace'){
  if(options.enabled!==undefined&&typeof options.enabled!=='boolean')throw new Error('Automation enabled must be boolean.');
  if(!Array.isArray(options.points))throw new Error('Automation replacement requires points. Use zero-based beats and parameter units.');
  const points=options.points.map(p=>{
   if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['beat','value','curve'].includes(k)))throw new Error('Automation points accept beat, value and curve only.');
   return {...p,curve:p.curve===undefined?'linear':p.curve};
  });
  const automation={...structuredClone(owner.automation||{}),[paramKey]:{enabled:options.enabled??true,points}};
  validateAutomation(automation,specs);owner.automation=automation;
 }else owner.automation=editEnvelope(owner,paramKey,action,options,specs);
 const envelope=owner.automation?.[paramKey];
 return {type:'automation',trackId:track.id,trackName:track.name,key:target.key,label:target.label,action,enabled:envelope?.enabled??false,points:structuredClone(envelope?.points??[]),processorEnabled:target.enabled};
}

export function applyAutomationIntent(project,intent){
 const {trackId,key,deviceId,returnId,action='replace',...options}=intent;
 const fields={replace:['points','enabled'],set:['beat','value','curve','index'],delete:['index'],clear:[],enable:['enabled'],remove:[]}[action];
 if(!fields||Object.keys(options).some(k=>!fields.includes(k)))throw new Error('Unsupported automation action or arguments. Use replace(points,enabled?), set(beat,value,curve?,index?), delete(index), clear, enable(enabled) or remove.');
 const track=automationChannels(project).find(t=>t.id===trackId);
 if(!track){const available=automationChannels(project).map(t=>({trackId:t.id,name:t.name}));throw Object.assign(new Error('Unknown automation trackId '+JSON.stringify(trackId)+'. Use the exact current project.tracks or project.returns id, never its display name, track:ID channel selector or a $alias from a PREVIOUS request. Available: '+JSON.stringify(available)),{code:'automation_target',userMessage:'The plan used a track reference that is not in this session. Nothing was changed.',validationDetails:{requested:{trackId},available}});}
 if(typeof key!=='string'||!key||deviceId!==undefined&&returnId!==undefined)throw new Error('Choose one automation target: key volume/pan, deviceId plus parameter key, or returnId plus key amount.');
 if(deviceId!==undefined&&typeof deviceId!=='string'||returnId!==undefined&&typeof returnId!=='string')throw new Error('Automation deviceId and returnId must be actual IDs.');
 if(action==='enable'&&typeof options.enabled!=='boolean')throw new Error('Automation enable requires enabled true or false.');
 if(action==='replace'&&options.enabled!==undefined&&typeof options.enabled!=='boolean')throw new Error('Automation enabled must be boolean.');
 if(action==='set'&&(!Number.isFinite(options.beat)||!Number.isFinite(options.value)))throw new Error('Automation set requires finite beat and value.');
 if(['set','delete'].includes(action)&&options.index!==undefined&&(!Number.isInteger(options.index)||options.index<0))throw new Error('Automation point index must be a nonnegative integer.');
 if(action==='delete'&&options.index===undefined)throw new Error('Automation delete requires a zero-based point index.');
 if(returnId!==undefined&&key!=='amount')throw new Error('Send automation uses key amount.');
 if(deviceId===undefined&&returnId===undefined&&!['volume','pan'].includes(key))throw new Error('Track automation uses volume or pan. Effects need deviceId plus parameter key; sends need returnId plus key amount.');
 const targetKey=deviceId!==undefined?deviceKey(deviceId,key):returnId!==undefined?sendKey(returnId):key;
 if(!automationTargetFor(track,targetKey,project.returns)){const available=automationTargetContext(track,project.returns);throw Object.assign(new Error('Unsupported automation target on '+track.name+'. Available: '+JSON.stringify(available)),{code:'automation_target',userMessage:'This parameter cannot be automated on '+track.name+'. Nothing was changed.',validationDetails:{requested:{trackId,key,deviceId,returnId},available}});}
 return editAutomationTarget(track,targetKey,action,options,project.returns);
}

export function automationTargetContext(track,returns=[]){
 return automationTargets(track,returns).map(t=>({key:t.paramKey,...(t.device?{deviceId:t.device.id,deviceType:t.device.type}:{}),...(t.sendId?{returnId:t.sendId}:{}),label:t.label,min:t.spec.min,max:t.spec.max,processorEnabled:t.enabled,envelope:t.envelope??null}));
}
