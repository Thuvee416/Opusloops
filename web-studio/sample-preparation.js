import {trimSample} from './sampler.js';
export const sampleKey=(trackId,pitch)=>pitch===undefined?trackId:JSON.stringify([trackId,pitch]);
export function instrumentSamples(instrument){return instrument?.type==='sampler'?[[undefined,instrument]]:instrument?.type==='drums'?instrument.pads.filter(p=>p.source==='sample').map(p=>[p.pitch,p.sample]):[];}
// Build a complete candidate without publishing partial pad or track caches.
export async function prepareInstrumentSamples(ctx,trackId,instrument,cache){
 const prepared=new Map();
 for(const [pitch,s]of instrumentSamples(instrument)){
  if(!s?.data)continue;const id=sampleKey(trackId,pitch),old=cache.get(id),key=JSON.stringify([s.start,s.end,s.reverse]);
  if(old?.key===key&&old.data===s.data){prepared.set(id,old);continue;}
  const raw=old?.data===s.data?old.raw:await ctx.decodeAudioData(Uint8Array.from(atob(s.data),c=>c.charCodeAt(0)).buffer);
  if(!Number.isFinite(raw.duration)||raw.duration<=0||raw.duration>60)throw new Error('Sampler Samples Must Be 60 Seconds Or Shorter.');
  prepared.set(id,{key,data:s.data,raw,buffer:trimSample(ctx,raw,s)});
 }
 return prepared;
}
export function samplePreparationBinding(project){return {project,tracks:project.tracks.map(track=>({track,id:track.id,instrument:track.instrument,sources:instrumentSamples(track.instrument).map(([pitch,s])=>({pitch,s,data:s?.data,start:s?.start,end:s?.end,reverse:s?.reverse}))}))};}
export function samplesStillCurrent(binding,project){return binding.project===project&&binding.tracks.length===project.tracks.length&&binding.tracks.every((before,index)=>{
 const track=project.tracks[index];if(track!==before.track||track.id!==before.id||track.instrument!==before.instrument)return false;
 const sources=instrumentSamples(track.instrument);return sources.length===before.sources.length&&sources.every(([pitch,s],i)=>{const old=before.sources[i];return old.pitch===pitch&&old.s===s&&old.data===s?.data&&old.start===s?.start&&old.end===s?.end&&old.reverse===s?.reverse;});
});}
export function installInstrumentSamples(cache,trackId,prepared){
 const next=new Map(cache);next.delete(sampleKey(trackId));for(let pitch=36;pitch<52;pitch++)next.delete(sampleKey(trackId,pitch));
 for(const [key,value]of prepared)next.set(key,value);return next;
}
