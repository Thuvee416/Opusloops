import {mod,uid} from './model.js';
import {overdubDestination} from './midi-overdub.js';
// Transport scheduling stays on the audio clock, including the count-in boundary.
export async function beginOverdubPlayback(engine,destination,{countInBars=0,signal}={}){
 if(![0,1,2,4].includes(countInBars))throw new Error('Choose a supported overdub count-in.');overdubDestination(engine.project,destination.trackId,destination.scene,destination.clipId);signal?.throwIfAborted();await engine.prepare();signal?.throwIfAborted();const {trackId,clipId,scene}=destination,source=engine.project.clips[clipId],running=engine.playing;
 if(running&&countInBars)throw new Error('Stop playback before an overdub count-in.');
 if(engine.pending.size||engine.pendingScene||engine.gateHolds.size)throw new Error('Let queued launches settle before overdubbing.');
 const previewId='overdub-'+uid(),stage={trackId,clipId,previewId,clip:source};engine.inputOverdub=stage;
 try{
  let start,phase=0;
  const current=engine.active.get(trackId);
  if(running&&current?.clipId===clipId&&(engine.mode==='session'||engine.overrides.has(trackId))){start=engine.context.currentTime;phase=mod(engine.rawBeat()-current.start,source.beats);}
  else if(running){const beat=engine.launchBoundary(clipId);stage.event={clipId,slot:scene,beat,legato:false};engine.pending.set(trackId,stage.event);start=engine.origin+beat*60/engine.project.bpm;}
  else{const beat=engine.position+countInBars*4;engine.active.delete(trackId);stage.event={clipId,slot:scene,beat,legato:false};engine.pending.set(trackId,stage.event);await engine.play('session');signal?.throwIfAborted();start=engine.origin+beat*60/engine.project.bpm;}
  const spb=60/engine.project.bpm,clicks=Array.from({length:countInBars*4},(_,i)=>({time:start-(countInBars*4-i)*spb,accent:i%4===0}));return {start,phase,stage,clicks};
 }catch(error){if(engine.inputOverdub===stage)engine.inputOverdub=null;throw error;}
}
export function updateOverdubPlayback(engine,clip){const stage=engine.inputOverdub;if(!stage)return;const track=engine.project.tracks.find(t=>t.id===stage.trackId);stage.clip={...clip,id:stage.previewId};if(!track.instrument){const effective=engine.overdubEffectiveClip(stage.clip,track);engine.prepareClip(effective).catch(()=>{});}}
export function endOverdubPlayback(engine){const stage=engine.inputOverdub;if(!stage)return;engine.inputOverdub=null;if(stage.event&&engine.pending.get(stage.trackId)===stage.event)engine.pending.delete(stage.trackId);const time=engine.context.currentTime;engine.voiceSchedulers.get(engine.context)?.release(stage.trackId,time);const scheduler=engine.bufferSchedulers.get(engine.context);for(const [key,voice]of scheduler?.voices??[])if(JSON.parse(key)[0]===stage.trackId){try{voice.node.stop(time);}catch{}scheduler.voices.delete(key);}engine.buffers.delete(stage.previewId);}
