import {newReturn} from './routing.js';
import {newDrumRack} from './drums.js';
import {newSampler} from './sampler.js';
import {validateProject,makeTrack,uid} from './model.js';
import {DEVICE_TYPES,newDevice} from './devices.js';
import {newSynth} from './instruments.js';
import {editTrack,editScene} from './management.js';
import {editArrangementTime,duplicateArrangementTime} from './time-edit.js';
// A capability contract, never executable code supplied by the model.
export const agentActions={
 command:'{name:play|pause|stop|seek|launch_scene|view|save_project|export_wav,args?:{beat?,scene?,view?:session|arrangement}} runtime operation; use alone without project edits',
 project:'{name?,bpm?,master?,transport?:{loopEnabled,loopStart,loopEnd,metronome}}',
 track:'{id,changes:{name?,volume?(linear 0..1),pan?(-1..1),mute?,solo?,output?}}',
 add_track:'{name,ref? (unique $alias for subsequent actions),preset? (Init|Warm bass|Soft pad|Bright pluck)}',
 manage_track:'{id,action:rename|color|move|duplicate|delete,value?}',
 scene:'{index,action:rename|insert|duplicate|delete|move,value?}',
 device:'{trackId,type?,deviceId?,remove?,enabled?,params?} add/update/remove an effect on a track or return',
 instrument:'{trackId,preset?,kind?:poly|drums|sampler,sampleClipId?,params?} presets for poly; sampler copies audio from an existing clip',
 add_return:'{name,ref?} create a return with wet reverb',
 midi_effects:'{trackId,effectsJSON:JSON-encoded array of complete MIDI effect objects from session}',
 drum_pad:'{trackId,pitch,changes:{name?,source?,level?,pan?,tune?,decay?,choke?,mute?,solo?}}',
 send:'{trackId,returnId,amount,pre?}',
 automation:'{trackId,key:volume|pan,points:[{beat,value}],enabled:true}',
 midi:'{ref?,clipId?,trackId?,scene?,name?,beats,notes:[{pitch,start,duration,velocity}]} replaces notes or creates MIDI clip',
 clip:'{id,changes:{name?,beats?,sourceBpm?,audioEdit?,warp?,launch?}}',
 region:'{id?,trackId?,clipId?,start?,length?,offset?,active?,remove?} add/update/delete Arrangement clip',
 time:'{operation:insert|delete|duplicate,start,length,trackIds?} beats are zero-based; omit trackIds for whole song',
 locators:'{items:[{id?,name,beat}]} replace song section markers'
};
const fail=m=>{throw new Error(m);};
function assign(target,changes,allowed){if(!changes||typeof changes!=='object'||Array.isArray(changes))fail('Expected changes object');for(const [k,v] of Object.entries(changes)){if(!allowed.includes(k))fail('Unsupported parameter: '+k);target[k]=structuredClone(v);}}
export function applyAgentActions(source,actions){
 if(!Array.isArray(actions)||actions.length>80)fail('Use at most 80 actions per request.');let p=structuredClone(source);const aliases=new Map(),resolve=id=>aliases.get(id)||id,remember=(ref,id)=>{if(ref!==undefined){if(typeof ref!=='string'||!/^\$[a-zA-Z][a-zA-Z0-9_-]{0,30}$/.test(ref)||aliases.has(ref))fail('Use a unique $alias');aliases.set(ref,id);}};
 for(const a of actions){if(!a||!Object.hasOwn(agentActions,a.type))fail('Unsupported action: '+a?.type);const x=typeof a.args==='string'?JSON.parse(a.args):structuredClone(a.args);if(!x||typeof x!=='object'||Array.isArray(x))fail('Invalid action arguments');
 if(a.type==='command'){if(actions.length!==1||!['play','pause','stop','seek','launch_scene','view','save_project','export_wav'].includes(x.name))fail('Use one supported runtime command at a time.');if(x.name==='seek'&&(!Number.isFinite(x.args?.beat)||x.args.beat<0||x.args.beat>16384))fail('Invalid seek beat');if(x.name==='launch_scene'&&(!Number.isInteger(x.args?.scene)||x.args.scene<0||x.args.scene>=p.scenes))fail('Invalid scene');if(x.name==='view'&&!['session','arrangement'].includes(x.args?.view))fail('Invalid view');}
 for(const key of ['id','trackId','returnId','deviceId','clipId','sampleClipId'])if(x[key])x[key]=resolve(x[key]);if(x.trackIds)x.trackIds=x.trackIds.map(resolve);
 const track=id=>[...p.tracks,...p.returns||[]].find(t=>t.id===id)||fail('Unknown track: '+id);
 if(a.type==='project'){const {transport,...rest}=x;assign(p,rest,['name','bpm','master']);if(transport)assign(p.transport,transport,['loopEnabled','loopStart','loopEnd','metronome','launchQuantization','followActionsEnabled']);}
 if(a.type==='track')assign(track(x.id),x.changes,['name','volume','pan','mute','solo','output']);
 if(a.type==='add_track'){const t=makeTrack(x.name,p.tracks.length);t.slots=Array(p.scenes).fill(null);if(x.preset)t.instrument=newSynth(x.preset);p.tracks.push(t);remember(x.ref,t.id);}
 if(a.type==='add_return'){p.returns??=[];const t=newReturn(x.name);p.returns.push(t);remember(x.ref,t.id);}
 if(a.type==='midi_effects')track(x.trackId).midiEffects=typeof x.effectsJSON==='string'?JSON.parse(x.effectsJSON):x.effects;
 if(a.type==='drum_pad'){const pad=track(x.trackId).instrument?.pads?.find(v=>v.pitch===x.pitch)||fail('Unknown drum pad');assign(pad,x.changes,['name','source','level','pan','tune','decay','choke','mute','solo']);}
 if(a.type==='manage_track')p=editTrack(p,x.id,x.action,x.action==='move'?Number(x.value):x.value).project;
 if(a.type==='scene')p=editScene(p,x.index,x.action,x.action==='move'?Number(x.value):x.value).project;
 if(a.type==='device'){const t=track(x.trackId);t.devices??=[];let d;if(x.deviceId){d=t.devices.find(d=>d.id===x.deviceId)||fail('Unknown device');}else{d=newDevice(x.type);t.devices.push(d);}if(x.remove){t.devices=t.devices.filter(v=>v!==d);}else{if(x.enabled!==undefined)d.enabled=x.enabled;if(x.params)assign(d.params,x.params,Object.keys(DEVICE_TYPES[d.type].params));}}
 if(a.type==='instrument'){const t=track(x.trackId);if(x.kind==='drums')t.instrument=newDrumRack();else if(x.kind==='sampler'){t.instrument=newSampler();const c=p.clips[x.sampleClipId];if(c?.kind!=='audio')fail('Sampler needs an audio clip');t.instrument.data=c.data;t.instrument.name=c.name;}else if(x.kind==='poly'||x.preset)t.instrument=newSynth(x.preset||'Init');if(!t.instrument)fail('Choose an instrument first');if(x.params)assign(t.instrument,x.params,Object.keys(t.instrument).filter(k=>!['type','data','pads'].includes(k)));}
 if(a.type==='send'){if(!(p.returns||[]).some(t=>t.id===x.returnId))fail('Unknown return');const t=track(x.trackId);t.sends??={};t.sends[x.returnId]={amount:x.amount,pre:x.pre??false};}
 if(a.type==='automation'){if(!['volume','pan'].includes(x.key))fail('Unsupported automation target');const t=track(x.trackId);t.automation??={};t.automation[x.key]={enabled:x.enabled??true,points:x.points.map(v=>({...v,curve:v.curve??'linear'}))};}
 if(a.type==='midi'){let c;if(x.clipId){c=p.clips[x.clipId];if(c?.kind!=='midi')fail('Choose a MIDI clip');}else{const t=track(x.trackId);if(!Number.isInteger(x.scene)||x.scene<0||x.scene>=p.scenes)fail('Choose a valid scene');if(t.slots[x.scene])fail('Destination slot is occupied');c={id:uid(),kind:'midi',name:x.name||'Agent MIDI',sourceBpm:p.bpm,beats:x.beats,notes:[]};p.clips[c.id]=c;t.slots[x.scene]=c.id;remember(x.ref,c.id);}c.notes=x.notes;c.beats=x.beats;if(x.name)c.name=x.name;}
 if(a.type==='clip'){const c=p.clips[x.id]||fail('Unknown clip');assign(c,x.changes,['name','beats','sourceBpm','audioEdit','warp','launch']);}
 if(a.type==='region'){const old=p.arrangement.find(v=>v.id===x.id);if(x.remove){if(!old)fail('Unknown region');p.arrangement=p.arrangement.filter(v=>v!==old);}else if(old){const {id,...changes}=x;assign(old,changes,['trackId','clipId','start','length','offset','active']);}else{if(x.id)fail('Unknown region');p.arrangement.push({id:uid(),trackId:x.trackId,clipId:x.clipId,start:x.start,length:x.length,offset:x.offset??0,...(x.active===undefined?{}:{active:x.active})});}}
 if(a.type==='time'){if(!['insert','delete','duplicate'].includes(x.operation))fail('Invalid time operation');p=x.operation==='duplicate'?duplicateArrangementTime(p,x.start,x.length,x.trackIds??null):editArrangementTime(p,x.operation,x.start,x.length,x.trackIds??null);}
 if(a.type==='locators')p.locators=x.items.map(v=>({...v,id:v.id||uid()}));
 }
 validateProject(p);if(p.arrangement.some(r=>r.start+r.length>16384))fail('Arrangement exceeds the timeline limit');return p;
}
function withoutMedia(v){if(Array.isArray(v))return v.map(withoutMedia);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='data').map(([k,x])=>[k,withoutMedia(x)]));return v;}
export function agentContext(p){
 // Never upload encoded media. Bounds keep accidental giant MIDI sessions out of prompts.
 const clips=Object.values(p.clips).map(({data,...c})=>({...c,...(c.notes?.length>256?{notes:c.notes.slice(0,256),notesTruncated:true}:{}),...(data?{audioBytes:Math.floor(data.length*.75)}:{})}));
 return {project:{...withoutMedia(p),clips:Object.fromEntries(clips.map(c=>[c.id,withoutMedia(c)]))},capabilities:agentActions,effects:Object.fromEntries(Object.entries(DEVICE_TYPES).map(([k,v])=>[k,{name:v.name,params:v.params}]))};
}
