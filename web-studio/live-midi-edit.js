import {validateProject} from './model.js';
import {processMidiClip} from './midi-effects.js';
import {keyedWindowNotes,prepareWindowNotes,voiceTail} from './voice-scheduler.js';
const signature=value=>JSON.stringify(value);
export function midiNoteChanges(previous,next){
 if(!next||Object.keys(previous.clips).length!==Object.keys(next.clips||{}).length)return null;
 const changes=[],clips={...next.clips};
 for(const [id,clip]of Object.entries(previous.clips)){const target=next.clips[id];if(!target)return null;if(signature(clip)===signature(target))continue;if(clip.kind!=='midi'||target.kind!=='midi'||signature({...clip,notes:null})!==signature({...target,notes:null}))return null;changes.push({id,notes:target.notes});clips[id]={...target,notes:clip.notes};}
 return signature(previous)===signature({...next,clips})?changes:null;
}
export function renderMidiBuffers(jobs,sampleRate,{signal}={}){
 if(!jobs.length)return Promise.resolve([]);
 return new Promise((resolve,reject)=>{
  signal?.throwIfAborted();const worker=new Worker(new URL('./midi-render-worker.js',import.meta.url),{type:'module'}),abort=()=>done(reject,new DOMException('MIDI Edit Cancelled.','AbortError')),done=(fn,value)=>{signal?.removeEventListener('abort',abort);worker.terminate();fn(value);};signal?.addEventListener('abort',abort,{once:true});
  worker.onmessage=({data})=>data.error?done(reject,new Error(data.error)):done(resolve,data.results);
  worker.onerror=e=>done(reject,new Error(e.message||'MIDI Sound Preparation Failed.'));
  worker.postMessage({jobs,sampleRate});
 });
}
export function liveMidiLocked(engine){return !engine.playing||!engine.context||engine.context.state!=='running'||engine.recording||engine.automationTake||engine.inputOverdub||engine.inputArrangement||engine.startPromise||engine.preparing;}
export async function applyLiveMidiNotes(engine,changes,{render=renderMidiBuffers,current=()=>true}={}){
 if(liveMidiLocked(engine)||engine.midiEditPending)throw new Error('Finish Recording Or Playback Preparation Before Editing MIDI.');
 if(!Array.isArray(changes)||!changes.length||new Set(changes.map(c=>c.id)).size!==changes.length)throw new Error('Choose Distinct MIDI Clip Sources To Edit.');
 const owner=engine.project,context=engine.context,generation=engine.playGeneration,original=new Map(),nextClips={...owner.clips};
 for(const change of changes){const clip=owner.clips[change.id];if(clip?.kind!=='midi')throw new Error('Only MIDI Notes Can Change During Playback.');original.set(change.id,signature(clip));nextClips[change.id]={...clip,notes:structuredClone(change.notes)};}
 const candidate={...owner,clips:nextClips};validateProject(candidate);
 const binding=signature([owner.bpm,owner.tracks.map(t=>[t.id,t.instrument,t.midiEffects,t.slots]),owner.arrangement]),jobs=[],native=[],base=[],effect=[];
 for(const change of changes){const clip=nextClips[change.id],tracks=owner.tracks.filter(t=>t.slots.includes(clip.id)||owner.arrangement.some(r=>r.trackId===t.id&&r.clipId===clip.id));
  if(tracks.some(t=>!t.instrument)){const key=signature([clip.id,clip.kind,clip.beats,owner.bpm,clip.notes]);jobs.push({key:'base:'+clip.id,clip,bpm:owner.bpm});base.push({id:clip.id,key});}
  for(const track of tracks){if(track.instrument)native.push({trackId:track.id,clipId:clip.id,before:keyedWindowNotes(prepareWindowNotes(owner.clips[clip.id],track.midiEffects,owner.bpm)),after:keyedWindowNotes(prepareWindowNotes(clip,track.midiEffects,owner.bpm))});else if(track.midiEffects?.length){const effective=processMidiClip(clip,track.midiEffects,owner.bpm),key=signature([track.id,clip.id]);jobs.push({key:'effect:'+key,clip:effective,bpm:owner.bpm});effect.push({key,version:signature([owner.bpm,effective])});}}
 }
 const tail=voiceTail(candidate,(id,pitch)=>engine.sampleBuffer(id,pitch));
 const assertCurrent=()=>{if(!current()||engine.project!==owner||engine.context!==context||engine.playGeneration!==generation||liveMidiLocked(engine)||signature([owner.bpm,owner.tracks.map(t=>[t.id,t.instrument,t.midiEffects,t.slots]),owner.arrangement])!==binding||[...original].some(([id,s])=>signature(owner.clips[id])!==s))throw new Error('Playback Or The MIDI Source Changed Before The Edit Was Ready. Nothing Was Applied.');};
 const controller=new AbortController();engine.midiEditAbort=controller;engine.midiEditPending=true;
 try{
  const rendered=await render(jobs,context.sampleRate,{signal:controller.signal}),buffers=new Map();assertCurrent();
  for(const item of rendered){const buffer=context.createBuffer(1,item.pcm.length,context.sampleRate);buffer.copyToChannel(item.pcm,0);buffers.set(item.key,buffer);}
  for(const b of base)if(!buffers.has('base:'+b.id))throw new Error('A MIDI Sound Buffer Was Not Prepared.');
  for(const e of effect)if(!buffers.has('effect:'+e.key))throw new Error('A MIDI Effect Buffer Was Not Prepared.');
  // Keep the already-scheduled lookahead intact. Changes become audible at its
  // next boundary, without seeking or rebuilding the mixer/audio context.
  if(engine.origin+engine.nextBeat*60/owner.bpm<context.currentTime+.005)engine.tick();assertCurrent();
  const boundary=engine.origin+engine.nextBeat*60/owner.bpm;
  for(const item of native)engine.voiceSchedulers.get(context)?.reviseClip(item.trackId,item.clipId,item.before,item.after,boundary);
  for(const change of changes)owner.clips[change.id].notes=nextClips[change.id].notes;
  for(const b of base)engine.buffers.set(b.id,{key:b.key,buffer:buffers.get('base:'+b.id)});
  for(const e of effect)engine.midiBuffers.set(e.key,{version:e.version,buffer:buffers.get('effect:'+e.key)});
  engine.instrumentTail=tail;return {boundary,clipIds:changes.map(c=>c.id)};
 }finally{engine.midiEditPending=false;if(engine.midiEditAbort===controller)engine.midiEditAbort=null;}
}
