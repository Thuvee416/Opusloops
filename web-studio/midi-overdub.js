import {MidiTake} from './input.js';
import {patchRecordQuantization,DEFAULT_RECORD_QUANTIZATION} from './record-quantization.js';
import {quantizeNote} from './note-quantize.js';
import {mod,validateProject} from './model.js';
import {isGroup} from './track-hierarchy.js';
// Keep the source immutable until Finish. Only this performance is quantized.
export class MidiOverdub {
 constructor(clip,bpm,start,{phase=0,quantization=DEFAULT_RECORD_QUANTIZATION,sampleRate=48000}={}){
  if(clip?.kind!=='midi'||!Array.isArray(clip.notes)||clip.notes.length>=4096||!Number.isFinite(phase)||phase<0||phase>=clip.beats)throw new Error('Choose a MIDI loop with room for more notes.');
  this.source=structuredClone(clip);this.phase=phase;this.quantization=Object.freeze(patchRecordQuantization(DEFAULT_RECORD_QUANTIZATION,quantization));this.input=new MidiTake(bpm,start,{sampleRate});this.refresh();
 }
 get held(){return this.input.held;}get limitReached(){return this.capacityLimited||this.input.limitReached;}get timeLimitReached(){return this.input.timeLimitReached;}
 on(key,pitch,velocity,time){if(this.closed)return false;if(this.held.has(key))this.off(key,time);if(this.source.notes.length+this.rawAdded.length+this.held.size>=4096){this.capacityLimited=true;return false;}return this.input.on(key,pitch,velocity,time);}
 off(key,time,velocity=0){if(this.closed)return;this.input.off(key,time,velocity);this.refresh();}
 fold(notes){const result=[];let boundarySplits=0,tailLimited=0;const capacity=4096-this.source.notes.length;
  for(const n of notes){let remaining=n.duration,start=mod(n.start,this.source.beats),first=true;
   while(remaining>1e-10){if(result.length>=capacity){tailLimited++;break;}const duration=Math.min(remaining,this.source.beats-start);if(duration<1e-9){remaining-=duration;start=0;continue;}const piece={...n,start,duration};if(remaining>duration+1e-10)delete piece.releaseVelocity;result.push(piece);if(!first)boundarySplits++;first=false;remaining-=duration;start=0;}
  }return {notes:result,boundarySplits,tailLimited};
 }
 refresh(){const unwrapped=this.input.notes.map(n=>({...n,start:n.start+this.phase})),raw=this.fold(unwrapped),quantized=this.quantization.enabled?unwrapped.map(n=>{const phase=mod(n.start,this.source.beats),cycle=n.start-phase;const q=quantizeNote({...n,start:phase},this.source.beats,{...this.quantization,strength:1}).note;return {...q,start:q.start+cycle};}):unwrapped,final=this.fold(quantized);
  this.rawAdded=raw.notes;this.added=final.notes;this.capacityLimited=!!(raw.tailLimited||final.tailLimited);this.rawClip={...structuredClone(this.source),notes:[...structuredClone(this.source.notes),...raw.notes]};this.clip={...structuredClone(this.source),notes:[...structuredClone(this.source.notes),...final.notes]};this.quantizationReport={...this.quantization,changed:JSON.stringify(this.rawAdded)!==JSON.stringify(this.added),noteCount:final.notes.length,boundarySplits:final.boundarySplits,tailLimited:Math.max(raw.tailLimited,final.tailLimited)};
 }
 finish(time){if(this.closed)return structuredClone(this.clip);this.input.finish(time);this.refresh();this.closed=true;return structuredClone(this.clip);}
}
export function overdubDestination(project,trackId,scene,clipId){const track=project.tracks.find(t=>t.id===trackId);if(!track||isGroup(track)||!Number.isInteger(scene)||scene<0||scene>=project.scenes)throw new Error('Choose the exact MIDI Session track and scene to overdub.');const id=track.slots[scene],clip=project.clips[id];if(clip?.kind!=='midi'||clipId!==undefined&&clipId!==id||clip.notes.length>=4096)throw new Error('Choose a MIDI Session clip with room for additional notes.');return {trackId,scene,clipId:id};}
export function applyMidiOverdub(project,clip,trackId,scene){const destination=overdubDestination(project,trackId,scene,clip?.id),source=project.clips[destination.clipId];if(JSON.stringify({...source,notes:[]})!==JSON.stringify({...clip,notes:[]})||clip.notes.length<source.notes.length||JSON.stringify(clip.notes.slice(0,source.notes.length))!==JSON.stringify(source.notes))throw new Error('Overdub must preserve the original clip and every existing note.');const next=structuredClone(project);next.clips[clip.id]=structuredClone(clip);validateProject(next);return {project:next,...destination,addedNotes:clip.notes.length-source.notes.length};}
