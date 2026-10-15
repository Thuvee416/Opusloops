import {uid,canPlace,validateProject} from './model.js';
export function editRegion(original,action,delta,trackId=original.trackId){
  const next={...original};delta=Math.round(delta*4)/4;
  if(action==='move'){next.start=Math.max(0,original.start+delta);next.trackId=trackId;}
  if(action==='end')next.length=Math.max(.25,Math.round((original.length+delta)*4)/4);
  if(action==='start'){
    const shift=Math.max(-original.start,Math.min(delta,original.length-.25));
    next.start=original.start+shift;next.length=original.length-shift;next.offset=original.offset+shift;
    // Source offset can wrap backwards; the caller normalizes by clip length.
  }
  if(next.start+next.length>16384)throw new Error('The region exceeds the timeline limit.');
  return next;
}

export function copyRegion(project,sourceId,start,trackId){
 const source=project.arrangement.find(r=>r.id===sourceId);
 if(!source)throw new Error('Select an existing region to duplicate.');
 if(!Number.isFinite(start)||start<0||start*4%1!==0||start+source.length>16384)throw new Error('Choose a valid destination within the timeline.');
 if(!project.tracks.some(t=>t.id===trackId))throw new Error('Choose an existing destination track.');
 const region={...source,id:uid(),start,trackId};
 if(!canPlace(project,region))throw new Error('The duplicated region would overlap another clip.');
 const clip=structuredClone(project.clips[source.clipId]);clip.id=uid();clip.name=clip.name.slice(0,195)+' copy';region.clipId=clip.id;
 validateProject({...project,clips:{...project.clips,[clip.id]:clip},arrangement:[...project.arrangement,region]});
 return {region,clip};
}

export function navigateRegion(project,sourceId,direction){
 const source=project.arrangement.find(r=>r.id===sourceId);if(!source)return null;
 const ordered=trackId=>project.arrangement.filter(r=>r.trackId===trackId).sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
 if(direction==='first'||direction==='last'){const regions=ordered(source.trackId);return direction==='first'?regions[0]:regions.at(-1);}
 if(![-1,1].includes(direction))throw new Error('Choose a valid region navigation direction.');
 const trackIndex=project.tracks.findIndex(t=>t.id===source.trackId);if(trackIndex<0)return null;
 const distance=r=>source.start<r.start?r.start-source.start:source.start>=r.start+r.length?source.start-r.start-r.length:0;
 for(let i=trackIndex+direction;i>=0&&i<project.tracks.length;i+=direction){const regions=ordered(project.tracks[i].id);if(regions.length)return regions.sort((a,b)=>distance(a)-distance(b)||Math.abs(a.start-source.start)-Math.abs(b.start-source.start)||a.start-b.start)[0];}
 return source;
}
