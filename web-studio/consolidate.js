import {uid,validateProject} from './model.js';
export const CONSOLIDATE_BYTES=30*1024*1024;
export function consolidationSource(project,regionId){const region=project.arrangement.find(r=>r.id===regionId),clip=project.clips[region?.clipId];if(!region||!clip||clip.kind==='midi')throw new Error('Select an audio or generated-loop Arrangement region.');if(region.length<.25||region.length>256)throw new Error('Consolidate a region between 0.25 and 256 beats.');if(Object.keys(project.clips).length>=512)throw new Error('The project has reached its 512-clip limit.');return {region,clip};}
// Float PCM preserves edited clip headroom; a 16-bit bounce could clip positive
// clip gain before it reaches the track's effects or fader.
export function floatWav(buffer){const channels=buffer.numberOfChannels,bytes=buffer.length*channels*4;if(bytes+44>CONSOLIDATE_BYTES)throw new Error('Consolidated audio must fit within 30 MB. Shorten the region.');const result=new ArrayBuffer(44+bytes),v=new DataView(result),text=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};text(0,'RIFF');v.setUint32(4,36+bytes,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,3,true);v.setUint16(22,channels,true);v.setUint32(24,buffer.sampleRate,true);v.setUint32(28,buffer.sampleRate*channels*4,true);v.setUint16(32,channels*4,true);v.setUint16(34,32,true);text(36,'data');v.setUint32(40,bytes,true);const data=Array.from({length:channels},(_,c)=>buffer.getChannelData(c));for(let i=0;i<buffer.length;i++)for(let c=0;c<channels;c++){const sample=data[c][i];if(!Number.isFinite(sample))throw new Error('Cannot consolidate non-finite audio.');v.setFloat32(44+(i*channels+c)*4,sample,true);}return result;}
export function installConsolidation(project,regionId,data){const {region,clip}=consolidationSource(project,regionId);if(typeof data!=='string'||!data.length||data.length>Math.ceil(CONSOLIDATE_BYTES/3)*4)throw new Error('Invalid consolidated audio.');const next=structuredClone(project),id=uid(),audio={id,name:(clip.name.slice(0,186)+' consolidated'),kind:'audio',beats:region.length,sourceBpm:project.bpm,data,...(clip.warp?.mode==='stretch'?{warp:{mode:'stretch',semitones:0}}:{})};next.clips[id]=audio;const replacement=next.arrangement.find(r=>r.id===regionId);replacement.clipId=id;replacement.offset=0;validateProject(next);return {project:next,clipId:id,regionId};}

// Expand only one source cycle at a time, enforcing the note cap before growing
// a large temporary array. All changes are installed after final validation.
export function consolidateMidiRange(project,trackId,start,end){
  if(!project.tracks.some(t=>t.id===trackId))throw new Error('Select an Arrangement track.');
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>16384||end-start<.25||end-start>256)throw new Error('Choose a range of 0.25–256 beats within beats 1–16385.');
  if(Object.keys(project.clips).length>=512)throw new Error('The project has reached its 512-clip limit.');
  const regions=project.arrangement.filter(r=>r.trackId===trackId&&r.start<end&&r.start+r.length>start).sort((a,b)=>a.start-b.start);
  if(!regions.length)throw new Error('The range contains no regions.');
  if(regions.some(r=>project.clips[r.clipId]?.kind!=='midi'))throw new Error('MIDI consolidation requires only MIDI regions in the selected range.');
  const channel=project.clips[regions[0].clipId].midiChannel??0;
  if(regions.some(r=>(project.clips[r.clipId].midiChannel??0)!==channel))throw new Error('MIDI regions must use the same MIDI channel to consolidate.');
  const notes=[];
  for(const r of regions){const clip=project.clips[r.clipId],from=Math.max(start,r.start),to=Math.min(end,r.start+r.length),offset=r.offset+from-r.start,stop=offset+to-from;
    for(let cycle=Math.floor(offset/clip.beats);cycle*clip.beats<stop;cycle++)for(const n of clip.notes){
      if(n.start>=clip.beats)continue;
      const on=cycle*clip.beats+n.start,off=Math.min(on+n.duration,(cycle+1)*clip.beats),a=Math.max(offset,on),b=Math.min(stop,off);
      if(b-a<1e-9)continue;
      if(notes.length===4096)throw new Error('The consolidated MIDI clip would exceed 4096 notes. Shorten the range.');
      notes.push({...n,...(r.active===false?{active:false}:{}),start:from-start+a-offset,duration:b-a});
    }
  }
  notes.sort((a,b)=>a.start-b.start||a.pitch-b.pitch);
  const next=structuredClone(project),clipId=uid(),regionId=uid(),covered=new Set(regions.map(r=>r.id));
  next.clips[clipId]={id:clipId,name:project.clips[regions[0].clipId].name.slice(0,186)+' consolidated',kind:'midi',beats:end-start,sourceBpm:project.bpm,midiChannel:channel,notes};
  next.arrangement=next.arrangement.flatMap(r=>{if(!covered.has(r.id))return [r];const parts=[];if(r.start<start)parts.push({...r,length:start-r.start});if(r.start+r.length>end)parts.push({...r,id:parts.length?uid():r.id,start:end,length:r.start+r.length-end,offset:r.offset+end-r.start});return parts;});
  next.arrangement.push({id:regionId,trackId,clipId,start,length:end-start,offset:0});
  validateProject(next);return {project:next,clipId,regionId};
}
