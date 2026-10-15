import {validateWarp} from './warp.js';
import {validateFollow} from './follow-actions.js';
import {validReleaseVelocity,validNoteActivation} from './note-state.js';
import {validateMidiEffects} from './midi-effects.js';
import {validateLocators} from './locators.js';
import {validateAudioEdit} from './audio-edit.js';
import {validateClipLaunch} from './launch.js';
import {validateInstrument} from './instruments.js';
import {validateRouting} from './routing.js';
import {validateAutomation} from './automation.js';
import {defaultTransport,validateTransport} from './transport.js';
import {validateDevices} from './devices.js';
export const uid = () => globalThis.crypto.randomUUID();
export const palette = ['#d9a359','#8faed6','#b4a1d5','#91b5a3','#cf8f99','#aebd77','#8cbcc7','#c89a7e'];
export const quantize = (beat, grid=4) => Math.max(0,Math.ceil((beat-1e-7)/grid)*grid);
export const mod = (n,m) => ((n%m)+m)%m;
export function makeTrack(name,index=0) {return {id:uid(),name,color:palette[index%palette.length],volume:.7,pan:0,mute:false,solo:false,devices:[],slots:Array(4).fill(null)};}
export function emptyProject() {return {format:'opus-loops',version:1,name:'Untitled session',master:.8,bpm:120,transport:defaultTransport(),scenes:4,tracks:[makeTrack('Audio 1')],clips:{},arrangement:[]};}
export function trackLevel(tracks,track) {return track.mute || (tracks.some(t=>t.solo) && !track.solo) ? 0 : track.volume;}
export const isRegionActive=region=>region.active!==false;
export function segmentAt(project,trackId,beat) {return project.arrangement.find(s=>isRegionActive(s)&&s.trackId===trackId && beat>=s.start-1e-7 && beat<s.start+s.length-1e-7);}
export function arrangementSlices(project,trackId,start,length){
  return project.arrangement.filter(s=>isRegionActive(s)&&s.trackId===trackId&&s.start<start+length&&s.start+s.length>start).map(s=>{
    const from=Math.max(start,s.start),to=Math.min(start+length,s.start+s.length);
    return {clipId:s.clipId,delay:from-start,offset:s.offset+from-s.start,length:to-from};
  });
}
export function splitSegment(segment,at) {
  if(at<=segment.start || at>=segment.start+segment.length) throw new Error('Split point must be inside the clip.');
  const length=at-segment.start;
  return [{...segment,length},{...segment,id:uid(),start:at,length:segment.length-length,offset:segment.offset+length}];
}
export function canPlace(project,segment,ignoreId=segment.id) {return !project.arrangement.some(s=>s.id!==ignoreId && s.trackId===segment.trackId && s.start<segment.start+segment.length-1e-7 && s.start+s.length>segment.start+1e-7);}
export function validateProject(p) {
  const fail=()=>{throw new Error('This is not a valid OPUS LOOPS project.');};
  const num=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
  if(!p||!['looproom','opus-loops'].includes(p.format)||p.version!==1||typeof p.name!=='string'||p.name.length>120||!num(p.bpm,40,240)||!Number.isInteger(p.scenes)||p.scenes<1||p.scenes>32||!Array.isArray(p.tracks)||p.tracks.length<1||p.tracks.length>16||!p.clips||typeof p.clips!=='object'||!Array.isArray(p.arrangement)||p.arrangement.length>10000) fail();
  if(p.sceneNames!==undefined&&(!Array.isArray(p.sceneNames)||p.sceneNames.length!==p.scenes||p.sceneNames.some(name=>typeof name!=='string'||!name.trim()||name.length>80)))fail();
  if(p.sceneFollows!==undefined){if(!Array.isArray(p.sceneFollows)||p.sceneFollows.length!==p.scenes)fail();for(const f of p.sceneFollows)if(f!==null){validateFollow(f);if(!f||f.linked!==false)fail();}}
  if(p.master!==undefined&&!num(p.master,0,1))fail();
  if(p.transport!==undefined)validateTransport(p.transport);validateLocators(p.locators);
  const ids=new Set();
  for(const t of p.tracks){if(typeof t.id!=='string'||ids.has(t.id)||typeof t.name!=='string'||!/^#[0-9a-f]{6}$/i.test(t.color)||!num(t.volume,0,1)||!num(t.pan,-1,1)||typeof t.mute!=='boolean'||typeof t.solo!=='boolean'||!Array.isArray(t.slots)||t.slots.length!==p.scenes)fail();if(t.noStopSlots!==undefined&&(!Array.isArray(t.noStopSlots)||new Set(t.noStopSlots).size!==t.noStopSlots.length||t.noStopSlots.some(i=>!Number.isInteger(i)||i<0||i>=p.scenes)))fail();ids.add(t.id);validateInstrument(t.instrument);validateMidiEffects(t.midiEffects);validateAutomation(t.automation);if(t.devices!==undefined)validateDevices(t.devices);}
  validateRouting(p);
  if(Object.keys(p.clips).length>512)fail();
  for(const [id,c] of Object.entries(p.clips)){if(c.id!==id||typeof c.name!=='string'||c.name.length>200||!num(c.beats,.25,256)||!num(c.sourceBpm,40,240)||!['audio','midi','drums'].includes(c.kind))fail();
    validateClipLaunch(c.launch);validateFollow(c.follow);if(c.kind==='audio'){validateAudioEdit(c.audioEdit,c.beats);validateWarp(c.warp);}else if(c.audioEdit!==undefined||c.warp!==undefined)fail();
    if(c.midiChannel!==undefined&&(!Number.isInteger(c.midiChannel)||c.midiChannel<0||c.midiChannel>15))fail();
    if(c.kind==='audio' && (typeof c.data!=='string'||c.data.length>90000000))fail();
    if(c.kind==='midi' && (!Array.isArray(c.notes)||c.notes.length>4096||c.notes.some(n=>!validNoteActivation(n)||!validReleaseVelocity(n)||!num(n.pitch,0,127)||!num(n.start,0,c.beats)||!num(n.duration,1e-9,256)||!num(n.velocity,0,1))))fail();
    if(c.kind==='drums'&&!['full','sparse','hats'].includes(c.pattern))fail();
  }
  for(const t of p.tracks)for(const c of t.slots)if(c!==null&&!Object.hasOwn(p.clips,c))fail();
  const segments=new Set();
  for(const s of p.arrangement){if((s.active!==undefined&&typeof s.active!=='boolean')||typeof s.id!=='string'||segments.has(s.id)||!ids.has(s.trackId)||!Object.hasOwn(p.clips,s.clipId)||!num(s.start,0,16384)||!num(s.length,.0625,16384)||!num(s.offset,0,1e7)||!canPlace(p,s))fail();segments.add(s.id);}
  return p;
}
export function wav(buffer){
  const channels=buffer.numberOfChannels,frames=buffer.length,out=new ArrayBuffer(44+frames*channels*2),v=new DataView(out);
  const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,out.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,buffer.sampleRate,true);v.setUint32(28,buffer.sampleRate*channels*2,true);v.setUint16(32,channels*2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,out.byteLength-44,true);
  const arrays=Array.from({length:channels},(_,i)=>buffer.getChannelData(i));
  for(let f=0;f<frames;f++)for(let c=0;c<channels;c++){const n=Math.max(-1,Math.min(1,arrays[c][f]));v.setInt16(44+(f*channels+c)*2,n<0?n*32768:n*32767,true);}
  return out;
}
