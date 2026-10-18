import {validateProject} from './model.js';
import {exportMidiClip} from './midi-file.js';
import {exportMidiArrangement} from './midi-arrangement.js';
import {processMidiClip} from './midi-effects.js';
import parseMidi from './vendor/midi-parser.js';

export const MIDI_DELIVERY_KEYS=['source','clipId','trackId','trackIds','range','applyEffects'];
const fail=message=>{throw new Error(message);};
// MIDI is note interchange: audio-render settings and mixer state do not apply.
export function midiDeliveryOptions(project,options={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!MIDI_DELIVERY_KEYS.includes(k)))fail('Unsupported MIDI export setting.');
 const value=structuredClone(options);if(value.source===undefined)value.source=value.clipId===undefined?'arrangement':'clip';if(value.applyEffects===undefined)value.applyEffects=false;
 if(!['clip','arrangement'].includes(value.source)||typeof value.applyEffects!=='boolean')fail('Choose clip or arrangement MIDI and whether to apply MIDI effects.');
 if(value.source==='clip'){
  if(value.range!==undefined||value.trackIds!==undefined)fail('Clip MIDI exports the complete clip loop; range and trackIds apply to Arrangement only.');
  if(typeof value.clipId!=='string'||!value.clipId)fail('Choose an existing MIDI clip.');
  if(value.trackId!==undefined&&(typeof value.trackId!=='string'||!value.trackId))fail('Choose a track that owns this MIDI clip.');
  const clip=project.clips[value.clipId];if(!clip||clip.kind!=='midi')fail('Choose an existing MIDI clip.');
  const owners=project.tracks.filter(t=>t.slots.includes(clip.id)||project.arrangement.some(r=>r.clipId===clip.id&&r.trackId===t.id));
  if(value.trackId!==undefined&&!owners.some(t=>t.id===value.trackId))fail('Choose a track that owns this MIDI clip.');
  if(value.applyEffects&&value.trackId===undefined){if(owners.length!==1)fail('Specify the owning trackId to apply MIDI effects to a shared or unassigned clip.');value.trackId=owners[0].id;}
 }else{
  if(value.clipId!==undefined||value.trackId!==undefined)fail('Use trackIds for Arrangement MIDI, or source clip with clipId.');
  if(!project.arrangement.length)fail('Record an Arrangement before exporting MIDI.');
  if(value.trackIds!==undefined&&(!Array.isArray(value.trackIds)||!value.trackIds.length||new Set(value.trackIds).size!==value.trackIds.length||value.trackIds.some(id=>typeof id!=='string'||!project.tracks.some(t=>t.id===id))))fail('Choose distinct existing regular track IDs for MIDI export.');
  if(value.range!==undefined){const r=value.range;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['start','length'].includes(k))||!Number.isFinite(r.start)||r.start<0||!Number.isFinite(r.length)||r.length<.0625||r.start+r.length>16384)fail('Choose a valid MIDI export range.');}
 }
 return value;
}
export function prepareMidiDelivery(project,options={}){
 validateProject(project);const settings=midiDeliveryOptions(project,options);
 const clip=project.clips[settings.clipId],track=project.tracks.find(t=>t.id===settings.trackId);
 const data=settings.source==='clip'?exportMidiClip(settings.applyEffects?processMidiClip(clip,track.midiEffects,project.bpm):clip,project.bpm):exportMidiArrangement(project,settings);
 // Measure the actual SMF. This does not use the deliberately bounded importer.
 const midi=parseMidi(data),channels=new Set();let noteCount=0,durationTicks=0,noteTracks=0;
 for(const events of midi.tracks){let ticks=0,notes=0;for(const event of events){ticks+=event.deltaTime;if(event.type==='noteOn'&&event.velocity>0){notes++;noteCount++;channels.add(event.channel+1);}}durationTicks=Math.max(durationTicks,ticks);if(notes)noteTracks++;}
 if(!noteCount)fail('The export contains no playable MIDI notes.');
 const name=(settings.source==='clip'?clip.name:project.name).replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,70)||'opus-loops';
 const filename=name+(settings.source==='arrangement'?'-arrangement':'')+'.mid';
 const description=`SMF ${midi.header.format}, ${midi.header.ticksPerBeat} ticks per beat, ${noteCount} notes, ${noteTracks} note tracks, MIDI effects ${settings.applyEffects?'applied':'excluded'}. Notes only; audio, instruments, mixer mute/solo, audio effects and automation excluded.`;
 return {data,filename,description,delivery:{format:'midi',settings,source:settings.source,smfFormat:midi.header.format,ticksPerBeat:midi.header.ticksPerBeat,durationTicks,noteCount,noteTracks,midiChannels:[...channels].sort((a,b)=>a-b),excluded:['audio','instruments','mixer mute/solo','audio effects','automation']}};
}
