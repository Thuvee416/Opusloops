import {emptyProject,makeTrack,uid,validateProject,AUDIO_MAX_BEATS} from './model.js';
import {isGroup} from './track-hierarchy.js';
import {setSlotActive} from './slot-metadata.js';
import {inspectMidi,importMidiProject} from './midi-file.js';

// Preparation never mutates the current set. UI and Odesa commit one candidate.
export function newProjectCandidate(preset,{empty=false,name='Untitled session'}={}){
 if(typeof empty!=='boolean'||typeof name!=='string'||!name.trim()||name.trim().length>120)throw new Error('Use a project name of 1–120 characters.');
 const next=!empty&&preset?structuredClone(validateProject(preset)):emptyProject();next.name=name.trim();return validateProject(next);
}
export function importBinding(project,revision){return {project:JSON.stringify(project),revision};}
export function assertImportCurrent(binding,project,revision){
 if(binding.project!==JSON.stringify(project)||binding.revision!==revision)throw new Error('The project changed while preparing the import. Nothing imported; choose the file again.');
}
export async function readAudioImport(file,decode,{signal,maxBytes=30*1024*1024}={}){
 if(!file)return null;signal?.throwIfAborted();
 if(!Number.isFinite(maxBytes)||maxBytes<=0||maxBytes>64*1024*1024)throw new Error('Invalid audio import size limit.');
 if(file.size>maxBytes)throw new Error(`Choose an audio file smaller than ${maxBytes/1024/1024} MB.`);
 const bytes=await file.arrayBuffer();signal?.throwIfAborted();if(bytes.byteLength>maxBytes)throw new Error('Audio file exceeds the import size limit.');
 const buffer=await decode(bytes.slice(0));signal?.throwIfAborted();
 if(!Number.isFinite(buffer.duration)||buffer.duration<=0||buffer.duration>300)throw new Error('Choose a nonempty audio clip shorter than five minutes.');
 return {name:file.name.replace(/\.[^.]+$/,'').slice(0,200)||'Audio Import',bytes,duration:buffer.duration,buffer};
}
export function prepareAudioImport(project,source,{trackId,scene,replace=false}={}){
 const p=structuredClone(project);
 if(!source||!(source.bytes instanceof ArrayBuffer)||!Number.isFinite(source.duration)||source.duration<=0||source.duration>300)throw new Error('Prepare a valid audio file before importing.');
 if(typeof replace!=='boolean'||scene!==undefined&&(!Number.isInteger(scene)||scene<0||scene>=p.scenes))throw new Error('Choose a valid Session scene.');
 if(scene!==undefined&&!trackId)throw new Error('Choose a track for the requested Session scene.');
 let track=trackId?p.tracks.find(t=>t.id===trackId):p.tracks.find(t=>!isGroup(t)&&t.slots.includes(null));
 if(trackId&&!track)throw new Error('The destination track no longer exists.');
 if(isGroup(track))throw new Error('Group tracks cannot contain audio clips. Choose a contained track.');
 if(!track){if(p.tracks.length>=16)throw new Error('Not enough track slots. Choose an empty clip slot or remove a track first.');track=makeTrack(`Audio ${p.tracks.length+1}`,p.tracks.length);track.slots=Array(p.scenes).fill(null);p.tracks.push(track);}
 scene??=track.slots.indexOf(null);
 if(scene<0)throw new Error('Choose an empty clip slot first.');
 if(track.slots[scene]&&!replace)throw new Error('The destination slot is occupied. Choose an empty slot or explicitly replace it.');
 const beats=Math.max(.25,source.duration*p.bpm/60),sourceBpm=p.bpm;
 if(source.duration<.0625||beats>AUDIO_MAX_BEATS)throw new Error('This audio is too short or long for a loop at this tempo.');
 let binary='';const bytes=new Uint8Array(source.bytes);for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
 const clip={id:uid(),name:source.name,kind:'audio',beats,sourceBpm,data:btoa(binary)};p.clips[clip.id]=clip;track.slots[scene]=clip.id;setSlotActive(track,scene,true);validateProject(p);
 return {next:p,selection:{trackId:track.id,clipId:clip.id,scene},clip};
}
export async function readMidiImport(file,{signal}={}){
 if(!file)return null;signal?.throwIfAborted();if(file.size>2*1024*1024)throw new Error('Choose a MIDI file smaller than 2 MB.');
 const bytes=await file.arrayBuffer();signal?.throwIfAborted();const inspection=inspectMidi(new Uint8Array(bytes));
 return {inspection,name:file.name.replace(/\.midi?$/i,'')};
}
export function prepareMidiImport(project,source,{replace=false,useTempo=false}={}){
 if(typeof replace!=='boolean'||typeof useTempo!=='boolean')throw new Error('MIDI import options must be boolean.');
 const next=importMidiProject(project,source.inspection,{replace,useTempo,name:source.name}),track=next.tracks[next.tracks.length-source.inspection.groups.length];
 return {next,selection:{trackId:track.id,clipId:track.slots[0],scene:0},warnings:source.inspection.warnings};
}
