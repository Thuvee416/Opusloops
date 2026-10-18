// Region fades are linear and constrained to the source loop edges.
// Cropped ramp endpoints retain their gain, preserving sound through split/time edits.
const identity=()=>({start:0,end:0,from:1,to:1});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const regionFadeValue=(ramp,beat)=>!ramp?1:ramp.end===ramp.start?ramp.to:ramp.from+(ramp.to-ramp.from)*clamp((beat-ramp.start)/(ramp.end-ramp.start),0,1);
export const regionGainAt=(region,beat)=>regionFadeValue(region.fades?.in,beat)*regionFadeValue(region.fades?.out,beat);
export function validateRegionFades(region,clip){
 const fades=region.fades;if(fades===undefined)return;
 if(!fades||typeof fades!=='object'||Array.isArray(fades)||Object.keys(fades).some(k=>!['in','out'].includes(k)))throw new Error('Invalid Arrangement fades.');
 for(const edge of ['in','out']){
  const f=fades[edge];if(!f||Object.keys(f).length!==4||Object.keys(f).some(k=>!['start','end','from','to'].includes(k))||![f.start,f.end,f.from,f.to].every(Number.isFinite)||f.start<0||f.end<f.start||f.end>region.length+1e-7||f.from<0||f.from>1||f.to<0||f.to>1||f.start===f.end&&f.from!==f.to||edge==='in'&&f.from>f.to||edge==='out'&&f.from<f.to)throw new Error('Invalid Arrangement fade ramp.');
 }
 if(clip.kind==='midi')throw new Error('Arrangement fades require audio or generated loops.');
 const limits=regionFadeLimits(region,clip);if(fades.in.from<fades.in.to&&fades.in.end>limits.in+1e-7||fades.out.from>fades.out.to&&fades.out.start<region.length-limits.out-1e-7||fades.in.from<fades.in.to&&fades.out.from>fades.out.to&&fades.in.end>fades.out.start+1e-7)throw new Error('Fades cannot overlap or cross a source loop boundary.');
}
const isIdentity=f=>f.from===1&&f.to===1;
function install(region,fades){const next={...region};if(isIdentity(fades.in)&&isIdentity(fades.out))delete next.fades;else next.fades=fades;return next;}
export function regionFadeLimits(region,clip){
 const phase=((region.offset%clip.beats)+clip.beats)%clip.beats,end=((region.offset+region.length)%clip.beats+clip.beats)%clip.beats;
 return {in:Math.min(region.length,clip.beats-phase),out:Math.min(region.length,end<1e-7?clip.beats:end)};
}
export function fitRegionFades(region,clip){
 if(!region.fades)return region;const fades=structuredClone(region.fades),limits=regionFadeLimits(region,clip);
 if(fades.in.from<fades.in.to){fades.in.end=Math.min(fades.in.end,limits.in);fades.in.start=Math.min(fades.in.start,fades.in.end);}
 if(fades.out.from>fades.out.to){fades.out.start=Math.max(fades.out.start,region.length-limits.out);fades.out.end=Math.max(fades.out.start,fades.out.end);}
 for(const edge of ['in','out'])if(fades[edge].start===fades[edge].end&&fades[edge].from!==fades[edge].to)fades[edge]=identity();
 if(fades.in.from<fades.in.to&&fades.out.from>fades.out.to&&fades.in.end>fades.out.start){fades.in.end=fades.out.start;fades.in.start=Math.min(fades.in.start,fades.in.end);if(fades.in.end===fades.in.start)fades.in=identity();}
 return install(region,fades);
}
export function editRegionFades(project,ids,patch){
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!project.arrangement.some(r=>r.id===id)))throw new Error('Select existing distinct Arrangement region IDs.');
 if(!patch||!Object.keys(patch).length||Object.keys(patch).some(k=>!['fadeIn','fadeOut'].includes(k)))throw new Error('Choose fadeIn and/or fadeOut durations in beats.');
 const selected=new Set(ids);return project.arrangement.map(r=>{
  if(!selected.has(r.id))return r;if(project.clips[r.clipId].kind==='midi')throw new Error('Arrangement fades require audio or generated loops.');
  const fades=structuredClone(r.fades??{in:identity(),out:identity()});
  for(const [key,n]of Object.entries(patch)){
   if(!Number.isFinite(n)||n<0||n>r.length)throw new Error('Fade durations must be between zero and each selected region length.');
   fades[key==='fadeIn'?'in':'out']=!n?identity():key==='fadeIn'?{start:0,end:n,from:0,to:1}:{start:r.length-n,end:r.length,from:1,to:0};
  }
  const next=install(r,fades);validateRegionFades(next,project.clips[r.clipId]);return next;
 });
}
export function sliceRegion(region,from,length,changes={}){
 const next={...region,start:region.start+from,length,offset:region.offset+from,...changes};if(!region.fades)return next;
 const fades={};for(const edge of ['in','out']){
  const f=region.fades[edge],start=clamp(f.start-from,0,length),end=clamp(f.end-from,0,length);
  fades[edge]={start,end,from:regionFadeValue(f,from+start),to:regionFadeValue(f,from+end)};
  // Extending an outside edge carries that edge's fade to the new boundary.
  const duration=Math.min(length,f.end-f.start);
  if(duration&&edge==='in'&&from<0)fades.in={start:0,end:duration,from:f.from,to:f.to};
  if(duration&&edge==='out'&&from+length>region.length)fades.out={start:length-duration,end:length,from:f.from,to:f.to};
 }
 return install(next,fades);
}
export function scheduleRegionFades(ctx,source,target,region,origin,time,spb){
 const nodes=[];let previous=source;
 for(const f of Object.values(region.fades??{})){
  if(isIdentity(f))continue;const node=ctx.createGain(),begin=Math.max(0,time),start=origin+f.start*spb,end=origin+f.end*spb;
  node.gain.setValueAtTime(regionFadeValue(f,(begin-origin)/spb),begin);
  if(start>begin)node.gain.setValueAtTime(f.from,start);
  if(end>begin)node.gain.linearRampToValueAtTime(f.to,end);
  previous.connect(node);previous=node;nodes.push(node);
 }
 previous.connect(target);return nodes;
}
