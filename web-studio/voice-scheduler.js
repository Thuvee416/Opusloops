import {isNoteActive} from './note-state.js';
import {processMidiNotes,processMidiClip} from './midi-effects.js';
import {drumVoice,drumTail} from './drums.js';
import {synthVoice} from './instruments.js';
import {samplerVoice} from './sampler.js';
// Compile complete chains before testing time windows: pitch can affect note length.
export function prepareWindowNotes(clip,effects,bpm=120){if(effects?.some(d=>d.enabled&&d.type==='arpeggiator'))return processMidiClip(clip,effects,bpm).notes.map((note,index)=>({index,note}));const result=[];for(let index=0;index<clip.notes.length;index++){const notes=processMidiNotes(clip.notes[index],effects,bpm);if(result.length+notes.length>65536)throw new Error('Processed MIDI clip exceeds 65,536 notes. Reduce the chord chain or clip density.');for(const note of notes)result.push({index,note});}return result;}
// Half-open windows prevent note duplication at scheduler quantum and loop edges.
export function noteWindows(clip,offset,length,chase=false,effects,bpm=120,prepared){
 const events=[],end=offset+length,notes=prepared??prepareWindowNotes(clip,effects,bpm);
 for(let cycle=Math.floor(offset/clip.beats);cycle*clip.beats<end-1e-7;cycle++)for(const {index,note}of notes){
  if(note.start>=clip.beats)continue;const start=cycle*clip.beats+note.start,stop=Math.min(start+note.duration,(cycle+1)*clip.beats),inside=start>=offset-1e-7&&start<end-1e-7,held=chase&&start<offset&&stop>offset+1e-7;
  if(!inside&&!held)continue;const at=Math.max(offset,start);
  events.push({index,cycle,pitch:note.pitch,velocity:note.velocity,delay:at-offset,elapsed:at-start,duration:stop-at});
 }
 return events.sort((a,b)=>a.delay-b.delay||a.index-b.index);
}
export class VoiceScheduler {
 constructor(ctx,bpm,getSample=()=>null,onNode=()=>{}){this.ctx=ctx;this.bpm=bpm;this.getSample=getSample;this.onNode=onNode;this.cursors=new Map();this.sounding=new Map();this.prepared=new WeakMap();}
 preparedNotes(clip,track){let tracks=this.prepared.get(clip);if(!tracks){tracks=new Map();this.prepared.set(clip,tracks);}const key=JSON.stringify([clip.beats,clip.notes,track.midiEffects,this.bpm]),cached=tracks.get(track.id);if(cached?.key===key)return cached.notes;const notes=prepareWindowNotes(clip,track.midiEffects,this.bpm);tracks.set(track.id,{key,notes});return notes;}
 release(trackId,time){for(const voice of this.sounding.get(trackId)||[])voice.release(time);this.cursors.delete(trackId);}
 schedule(target,track,clip,time,offset,length,instance,limit=Infinity){const previous=this.cursors.get(track.id),continuous=previous?.instance===instance&&Math.abs(previous.endTime-time)<1e-6&&Math.abs(previous.endOffset-offset)<1e-6;if(!continuous)this.release(track.id,time);const spb=60/this.bpm,ctx=this.ctx,s=track.instrument;for(const n of noteWindows(clip,offset,length,!continuous,track.midiEffects,this.bpm,this.preparedNotes(clip,track))){const at=time+n.delay*spb,duration=Math.min(n.duration*spb,limit-at);if(duration<=1e-8)continue;const voice=s.type==='drums'?drumVoice(ctx,target,s,n.pitch,n.velocity,this.getSample(track.id,n.pitch),at,n.elapsed*spb,track.id):s.type==='sampler'?samplerVoice(ctx,target,s,this.getSample(track.id),n.pitch,n.velocity,at,duration,n.elapsed*spb):synthVoice(ctx,target,s,n.pitch,n.velocity,at,duration,n.elapsed*spb);if(!voice)continue;const set=this.sounding.get(track.id)||new Set();this.sounding.set(track.id,set);set.add(voice);const cleanup=voice.osc.onended;voice.osc.onended=()=>{set.delete(voice);cleanup?.();};this.onNode(voice.osc);}this.cursors.set(track.id,{instance,endTime:time+length*spb,endOffset:offset+length});}
}
export function voiceTail(project,getSample=()=>null){let tail=0;for(const t of project.tracks){const s=t.instrument;if(!s)continue;if(s.type==='drums'){tail=Math.max(tail,drumTail(s,pitch=>getSample(t.id,pitch)));continue;}if(s.type==='poly'||s.mode==='gate')tail=Math.max(tail,s.release+.005);else{const sample=getSample(t.id);if(!sample)continue;const ids=new Set([...t.slots,...project.arrangement.filter(r=>r.trackId===t.id).map(r=>r.clipId)]);for(const id of ids){const clip=project.clips[id];if(!clip?.notes)continue;const effective=processMidiClip({...clip,notes:clip.notes.map(n=>({...n,velocity:n.velocity??1}))},t.midiEffects,project.bpm??120);for(const voice of effective.notes)if(isNoteActive(voice)&&voice.velocity>0)tail=Math.max(tail,sample.duration/2**((voice.pitch-s.root+s.transpose+s.detune/100)/12));}}}return Math.min(30,tail);}
