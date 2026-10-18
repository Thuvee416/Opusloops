import {SELECTION_KEYS,selectionIntent,detailPanelIntent} from './studio-selection.js';
import {editRegionCrossfade} from './region-crossfade.js';
import {editRegionFades,sliceRegion,fitRegionFades} from './region-fades.js';
import {MIDI_DELIVERY_KEYS,midiDeliveryOptions} from './midi-delivery.js';
import {editRegionGroup} from './arrangement.js';
import {DELIVERY_KEYS,deliveryOptions} from './delivery-options.js';
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
 command:'{name:select|show_panel|play|pause|stop|seek|launch_scene|launch_clip|stop_track|stop_clips|view|save_project|export_wav|export_stems|export_midi,args?:{beat?,scene? (zero-based),trackId?,view?:session|arrangement,source?:auto|session|arrangement,sampleRate?:44100|48000|88200|96000,bitDepth?:16|24|32 (32=float),normalize?:boolean,dither?:none|triangular (none for float),includeTail?:boolean,range?:{start,length} (zero-based Arrangement beats),channel?:master|track:ID|return:ID (WAV only)}} runtime operation; select uses its own args {target:track,trackId} to show track/return devices (preserving clip content selection), {target:clip,trackId,scene? (zero-based),clipId?} for a Session clip, or {target:regions,ids:[REGION IDs],primaryId?} for Arrangement selection. Clip selection needs either scene or clipId; repeated slots need explicit scene. Region selection reveals the selected range and its primary clip editor. show_panel uses {panel:clip|devices|recording|returns}. These are view changes, not project edits or playback. Region creation supports ref aliases for later selection; ids/primaryId resolve those aliases. launch_clip presses a trigger/toggle Session slot; launch_scene and clip stops wait for quantized activation. Gate/repeat clip holds remain manual. Session export snapshots active clips from their beginnings for four bars, excluding Arrangement automation; auto prefers Arrangement. Defaults: 44.1 kHz/24-bit, no normalization/dither, tails included. Range forces Arrangement and cannot combine with Session source. export_stems downloads an aligned ZIP of all tracks and returns before the master bus; each file obeys mute/solo, crossfade and independent normalization/dither. Channel selection is WAV-only. export_midi uses its own args: source clip or arrangement (default arrangement), clipId for a full clip loop, optional owning trackId for clip effects, trackIds for chosen Arrangement tracks, range for Arrangement only, applyEffects boolean (default false). MIDI ignores mixer mute/solo and excludes audio, instruments, audio effects and automation. A processed shared clip requires an explicit owning trackId. Do not pass audio encoding/rate/tail settings to MIDI. Combine up to eight after project edits, or stop/pause before edits',
 region_crossfade:'{leftId,rightId (ordered audio Arrangement REGION IDs on same track),action?:create|remove,start?,length?,boundary?} create/resize a complementary linear crossfade over zero-based start/length; for adjacent clips the overlap must cover their join. Extends outgoing audio to start+length and starts incoming audio at start, preserving source phase and outer boundaries. Requires unused source material inside loop boundaries, no other overlapping fades. Remove joins at boundary (default overlap midpoint), clears the paired fades, and preserves outer edges. Invalid requests reject atomically',
 region_fades:'{ids:[existing Arrangement REGION IDs],fadeIn? (beats),fadeOut? (beats)} set audio/generated-loop region edge fades. Durations are independent, 0..each region length; 0 clears an edge. Linear fades cannot overlap each other or cross source-loop boundaries; values outside those bounds reject atomically. Excludes MIDI. Does not change source clips, source offsets, mixer automation or Session playback; one atomic Undo. Split/time-cropped fades retain original gain segments; setting a duration resets that edge to a full 0-to-1 or 1-to-0 fade',
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
 midi:'{ref?,clipId?,trackId?,scene?,name? (display name: include any exact user-provided clip name),beats,notes:[{pitch,start,duration,velocity}]} replaces notes or creates MIDI clip',
 clip:'{id,changes:{name?,beats?,sourceBpm?,audioEdit?,warp?,launch?}}',
 region_group:'{ids:[existing Arrangement region IDs],action:move|duplicate|delete|active|trim,delta? (beats),trackOffset? (move/duplicate only),edge?:start|end (trim only)} trim moves all chosen starts or ends by one shared quarter-beat-snapped delta; positive moves right, negative left. Shorten starts by 1 beat: edge=start,delta=+1. Shorten ends by 1 beat: edge=end,delta=-1. Negative start delta extends earlier; positive end delta extends later. Starts preserve original ends and source timing. Clamp together at timeline/minimum length boundaries, reject overlaps atomically. Does not alter source clips or track automation',
 region:'{id?,ref? (unique alias for a NEW region),trackId?,clipId?,start?,length?,offset?,active?,remove?} add/update/delete Arrangement clip',
 time:'{operation:insert|delete|duplicate,start,length,trackIds?} beats are zero-based; omit trackIds for whole song',
 locators:'{items:[{id?,name,beat}]} replace song section markers'
};
const fail=m=>{throw new Error(m);};
function assign(target,changes,allowed){if(!changes||typeof changes!=='object'||Array.isArray(changes))fail('Expected changes object');for(const [k,v] of Object.entries(changes)){if(!allowed.includes(k))fail('Unsupported parameter: '+k);target[k]=structuredClone(v);}}
export function applyAgentActions(source,actions,{aliases=new Map(),observations=[]}={}){
 if(!Array.isArray(actions)||actions.length>80)fail('Use at most 80 actions per request.');let p=structuredClone(source);const resolve=id=>aliases.get(id)||id,remember=(ref,id)=>{if(ref!==undefined){if(typeof ref!=='string'||!/^\$[a-zA-Z][a-zA-Z0-9_-]{0,30}$/.test(ref)||aliases.has(ref))fail('Use a unique $alias');aliases.set(ref,id);}};
 for(const a of actions){if(!a||!Object.hasOwn(agentActions,a.type))fail('Unsupported action: '+a?.type);const x=typeof a.args==='string'?JSON.parse(a.args):structuredClone(a.args);if(!x||typeof x!=='object'||Array.isArray(x))fail('Invalid action arguments');
 if(a.type==='command'){
  if(actions.length!==1||!['select','show_panel','play','pause','stop','seek','launch_scene','launch_clip','stop_track','stop_clips','view','save_project','export_wav','export_stems','export_midi'].includes(x.name))fail('Use one supported runtime command at a time.');
  if(x.name==='seek'&&(!Number.isFinite(x.args?.beat)||x.args.beat<0||x.args.beat>16384))fail('Invalid seek beat');
  if(['launch_scene','launch_clip'].includes(x.name)&&(!Number.isInteger(x.args?.scene)||x.args.scene<0||x.args.scene>=p.scenes))fail('Invalid scene');
  if(['launch_clip','stop_track'].includes(x.name)){
   const t=p.tracks.find(t=>t.id===resolve(x.args?.trackId));if(!t)fail('Choose an existing regular track.');x.args.trackId=t.id;
   if(x.name==='launch_clip'){const c=p.clips[t.slots[x.args.scene]];if(!c)fail('The requested Session slot is empty.');if(['gate','repeat'].includes(c.launch?.mode))fail('Gate/repeat clips require a held gesture. Choose a trigger/toggle clip or change its launch mode explicitly.');}
  }
  if(x.name==='view'&&!['session','arrangement'].includes(x.args?.view))fail('Invalid view');
  const keys={select:SELECTION_KEYS,show_panel:['panel'],seek:['beat'],launch_scene:['scene'],launch_clip:['trackId','scene'],stop_track:['trackId'],view:['view'],export_wav:[...DELIVERY_KEYS,'channel'],export_stems:DELIVERY_KEYS,export_midi:MIDI_DELIVERY_KEYS}[x.name]||[];
  const invalidArgs=x.args!==undefined&&(!x.args||typeof x.args!=='object'||Array.isArray(x.args));
  const unexpected=[...Object.keys(x).filter(k=>!['name','args'].includes(k)).map(k=>'command.'+k),...(!invalidArgs&&x.args?Object.keys(x.args).filter(k=>!keys.includes(k)).map(k=>'command.args.'+k):[])];
  if(invalidArgs||unexpected.length)fail('Unsupported runtime argument. '+(invalidArgs?'command.args must be an object. ':'Unexpected fields: '+unexpected.join(', ')+'. ')+x.name+' accepts '+(keys.join(', ')||'no arguments')+' inside command.args.'+(x.name==='export_wav'?' Select a WAV track with command.args.channel="track:ID" (or "track:$alias"), never trackId.':''));
  if(x.name==='select')selectionIntent(p,x.args);
  if(x.name==='show_panel')detailPanelIntent(x.args);
  if(x.name==='export_midi')midiDeliveryOptions(p,x.args??{});
  if(['export_wav','export_stems'].includes(x.name))deliveryOptions(p,x.args??{},x.name==='export_wav'?'wav':'stems');
 }

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
 if(a.type==='region_crossfade'){if(Object.keys(x).some(k=>!['leftId','rightId','action','start','length','boundary'].includes(k)))fail('Unsupported crossfade argument');const result=editRegionCrossfade(p,x);p.arrangement=result.arrangement;observations.push(result.observation);}
 if(a.type==='region_fades'){if(Object.keys(x).some(k=>!['ids','fadeIn','fadeOut'].includes(k)))fail('Unsupported Arrangement fade argument');const {ids,...patch}=x;p.arrangement=editRegionFades(p,ids,patch);observations.push({type:'region_fades',count:ids.length,...patch});}
 if(a.type==='region_group'){const allowed=['ids','action',...(x.action==='trim'?['edge','delta']:['move','duplicate'].includes(x.action)?['delta','trackOffset']:[])];if(Object.keys(x).some(k=>!allowed.includes(k)))fail('Unsupported Arrangement group argument');const result=editRegionGroup(p,x.ids,x.action,{delta:x.delta,edge:x.edge,trackOffset:x.trackOffset});if(result.trim)observations.push({type:'region_trim',count:x.ids.length,...result.trim});p.arrangement=result.arrangement;p.clips=result.clips;}
 if(a.type==='region'){if(Object.keys(x).some(k=>!['id','ref','trackId','clipId','start','length','offset','active','remove'].includes(k)))fail('Unsupported Arrangement region argument');if(x.ref!==undefined&&(x.id||x.remove))fail('Assign a region ref only when creating a new region.');const old=p.arrangement.find(v=>v.id===x.id);if(x.remove){if(!old)fail('Unknown region');p.arrangement=p.arrangement.filter(v=>v!==old);}else if(old){const {id,...changes}=x;const resized=sliceRegion(old,0,changes.length??old.length);assign(resized,changes,['trackId','clipId','start','length','offset','active']);const fitted=fitRegionFades(resized,p.clips[resized.clipId]);Object.assign(old,fitted);if(!fitted.fades)delete old.fades;}else{if(x.id)fail('Unknown region');const created={id:uid(),trackId:x.trackId,clipId:x.clipId,start:x.start,length:x.length,offset:x.offset??0,...(x.active===undefined?{}:{active:x.active})};p.arrangement.push(created);remember(x.ref,created.id);}}
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
