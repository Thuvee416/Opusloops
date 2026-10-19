import {makeTrack,uid,validateProject,AUDIO_MAX_BEATS} from './model.js';
import {readAudioImport} from './project-import.js';
export const STEM_FILE_BYTES=64*1024*1024,STEM_TOTAL_BYTES=100*1024*1024,STEM_DECODED_BYTES=512*1024*1024,PORTABLE_PROJECT_BYTES=150*1024*1024;
export function stemImportRequest(project,files,start){
 if(!Array.isArray(files)||!files.length)throw Error('Choose At Least One Audio File.');
 if(project.tracks.length+files.length>16)throw Error(`This Set Has Room For ${16-project.tracks.length} New Tracks. Choose Fewer Files.`);
 if(Object.keys(project.clips).length+files.length>512||project.arrangement.length+files.length>10000)throw Error('The Import Would Exceed The Project Clip Or Region Limit.');
 if(!Number.isFinite(start)||start<0||start>=16384)throw Error('Choose An Import Start Within The Arrangement.');
 let total=0;for(const file of files){if(!Number.isFinite(file.size)||file.size<=0||file.size>STEM_FILE_BYTES)throw Error('Each Stem Must Be A Nonempty Audio File Up To 64 MB.');total+=file.size;}
 if(total>STEM_TOTAL_BYTES)throw Error('Choose At Most 100 MB Of Audio Per Import.');
 // Keep this batch importer within its conservative portable-project budget.
 if(new Blob([JSON.stringify(project)]).size+Math.ceil(total/3)*4+files.length*2048>PORTABLE_PROJECT_BYTES)throw Error('These Files Would Exceed The 150 MB Stem Import Project Budget. Choose Fewer Or Smaller Files.');
 return {start,count:files.length,totalBytes:total};
}
export async function readStemFiles(files,decode,{signal,check=()=>{},onProgress=()=>{}}={}){
 const sources=[];let memory=0;
 for(const [index,file]of files.entries()){
  signal?.throwIfAborted();check();onProgress({index,count:files.length,name:file.name,phase:'decoding'});
  const source=await readAudioImport(file,decode,{signal,maxBytes:STEM_FILE_BYTES});signal?.throwIfAborted();check();
  const bytes=source.buffer.length*source.buffer.numberOfChannels*4;if(!Number.isFinite(bytes)||bytes<=0||memory+bytes>STEM_DECODED_BYTES)throw Error('Decoded Stems Exceed The 512 MB Audio Memory Limit. Choose Fewer Or Shorter Files.');memory+=bytes;sources.push(source);
 }
 return sources;
}
export function prepareStemImport(project,sources,{start=0}={}){
 stemImportRequest(project,sources.map(s=>({size:s.bytes?.byteLength})),start);
 for(const source of sources){const beats=source.duration*project.bpm/60;if(!(source.bytes instanceof ArrayBuffer)||!Number.isFinite(source.duration)||source.duration<=0||source.duration>300||beats<.25||beats>AUDIO_MAX_BEATS||start+beats>16384)throw Error('Each Stem Must Fit The Timeline And Be Between 0.25 Beats And Five Minutes Long.');}
 const next=structuredClone(project),imports=[];
 for(const source of sources){const track=makeTrack(String(source.name||'Audio Stem').slice(0,40),next.tracks.length);track.slots=Array(next.scenes).fill(null);next.tracks.push(track);
  const bytes=new Uint8Array(source.bytes);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  const clip={id:uid(),name:String(source.name||'Audio Stem').slice(0,200),kind:'audio',beats:source.duration*next.bpm/60,sourceBpm:next.bpm,data:btoa(binary)};
  const region={id:uid(),clipId:clip.id,trackId:track.id,start,length:clip.beats,offset:0};next.clips[clip.id]=clip;next.arrangement.push(region);imports.push({trackId:track.id,clip,regionId:region.id,buffer:source.buffer});
 }
 validateProject(next);if(new Blob([JSON.stringify(next)]).size>PORTABLE_PROJECT_BYTES)throw Error('The Imported Set Would Exceed The Stem Import Project Size Budget.');return {next,imports};
}
