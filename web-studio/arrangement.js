import {sliceRegion,fitRegionFades} from './region-fades.js';
import {uid,canPlace,validateProject,mod,REGION_MIN_BEATS} from './model.js';
export function editRegion(original,action,delta,trackId=original.trackId){
  const next={...original};delta=Math.round(delta*4)/4;
  if(action==='move'){next.start=Math.max(0,original.start+delta);next.trackId=trackId;}
  if(action==='end')next.length=Math.max(REGION_MIN_BEATS,original.length+delta);
  if(action==='start'){
    const shift=Math.max(-original.start,Math.min(delta,original.length-REGION_MIN_BEATS));
    next.start=original.start+shift;next.length=original.length-shift;next.offset=original.offset+shift;
    // Source offset can wrap backwards; the caller normalizes by clip length.
  }
  if(next.start+next.length>16384)throw new Error('The region exceeds the timeline limit.');
  return action==='move'?next:sliceRegion(original,next.start-original.start,next.length,{offset:next.offset});
}

export function copyRegion(project,sourceId,start,trackId){
 const source=project.arrangement.find(r=>r.id===sourceId);
 if(!source)throw new Error('Select an existing region to duplicate.');
 if(!Number.isFinite(start)||start<0||start*4%1!==0||start+source.length>16384)throw new Error('Choose a valid destination within the timeline.');
 if(!project.tracks.some(t=>t.id===trackId))throw new Error('Choose an existing destination track.');
 const region={...structuredClone(source),id:uid(),start,trackId};
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


function selectedGroup(project,ids){
 if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error('Select distinct existing Arrangement clips.');
 const selected=new Set(ids),regions=project.arrangement.filter(r=>selected.has(r.id));
 if(regions.length!==selected.size)throw new Error('Select existing Arrangement clips.');
 return {selected,regions};
}
export function planRegionTrim(project,ids,edge,delta){
 const {selected,regions}=selectedGroup(project,ids);
 if(!['start','end'].includes(edge)||!Number.isFinite(delta))throw new Error('Choose a start/end edge and a finite trim amount.');
 const minimum=REGION_MIN_BEATS;
 const lower=edge==='start'?-Math.min(...regions.map(r=>r.start)):Math.max(...regions.map(r=>minimum-r.length));
 const upper=edge==='start'?Math.min(...regions.map(r=>r.length-minimum)):16384-Math.max(...regions.map(r=>r.start+r.length));
 const shift=Math.max(lower,Math.min(upper,Math.round(delta*4)/4));
 const next=regions.map(r=>fitRegionFades(edge==='start'?sliceRegion(r,shift,r.length-shift,{offset:shift===0?r.offset:mod(r.offset+shift,project.clips[r.clipId].beats)}):sliceRegion(r,0,r.length+shift),project.clips[r.clipId]));
 if(next.some(r=>r.start<0||r.length<minimum||r.start+r.length>16384))throw new Error('Keep every trimmed clip within the timeline.');
 // Resizing can make selected clips collide with one another as well as neighbors.
 const all=[...project.arrangement.filter(r=>!selected.has(r.id)),...next].sort((a,b)=>a.trackId===b.trackId?a.start-b.start:a.trackId<b.trackId?-1:1);
 for(let i=1;i<all.length;i++)if(all[i-1].trackId===all[i].trackId&&all[i-1].start+all[i-1].length>all[i].start+1e-7)throw new Error('Selected clip edges would overlap another clip.');
 return next;
}

export function planRegionGroup(project,ids,delta=0,trackOffset=0,copy=false){
 const {selected,regions}=selectedGroup(project,ids);
 if(!Number.isFinite(delta)||!Number.isInteger(trackOffset))throw new Error('Choose a valid group destination.');
 delta=Math.max(-Math.min(...regions.map(r=>r.start)),Math.round(delta*4)/4);
 const next=regions.map(r=>{const index=project.tracks.findIndex(t=>t.id===r.trackId)+trackOffset;if(index<0||index>=project.tracks.length)throw new Error('Keep every selected clip within the available tracks.');const n={...r,start:r.start+delta,trackId:project.tracks[index].id};if(n.start+n.length>16384)throw new Error('The group exceeds the timeline limit.');return n;});
 const others=copy?project.arrangement:project.arrangement.filter(r=>!selected.has(r.id));
 for(const r of next)if(others.some(o=>o.trackId===r.trackId&&o.start<r.start+r.length-1e-7&&o.start+o.length>r.start+1e-7))throw new Error('Selected clips would overlap another clip.');
 return next;
}
export function editRegionGroup(project,ids,action,{delta,trackOffset=0,edge}={}){
 const {selected,regions}=selectedGroup(project,ids);
 let next,trim,clips={...project.clips},selectedIds=[...selected];
 if(action==='trim'){const plan=planRegionTrim(project,ids,edge,delta),updates=new Map(plan.map(r=>[r.id,r]));next=project.arrangement.map(r=>updates.get(r.id)||r);const original=regions[0],changed=updates.get(original.id),appliedDelta=edge==='start'?changed.start-original.start:changed.length-original.length;trim={edge,requestedDelta:delta,appliedDelta,clamped:Math.abs(appliedDelta-Math.round(delta*4)/4)>1e-7};}
 else if(action==='delete') {next=project.arrangement.filter(r=>!selected.has(r.id));selectedIds=[];}
 else if(action==='active'){const active=regions.some(r=>r.active===false);next=project.arrangement.map(r=>selected.has(r.id)?{...r,active}:r);}
 else if(action==='move'||action==='duplicate'){
  const span=Math.max(...regions.map(r=>r.start+r.length))-Math.min(...regions.map(r=>r.start));
  const plan=planRegionGroup(project,ids,delta??(action==='duplicate'?Math.ceil(span*4)/4:0),trackOffset,action==='duplicate');
  if(action==='duplicate'){
   for(const r of plan){if(r.fades)r.fades=structuredClone(r.fades);const clip=structuredClone(project.clips[r.clipId]);clip.id=uid();clip.name=clip.name.slice(0,195)+' copy';clips[clip.id]=clip;r.id=uid();r.clipId=clip.id;}
   next=[...project.arrangement,...plan];selectedIds=plan.map(r=>r.id);
  }else{const updates=new Map(plan.map(r=>[r.id,r]));next=project.arrangement.map(r=>updates.get(r.id)||r);}
 }else throw new Error('Choose a supported group edit.');
 validateProject({...project,clips,arrangement:next});
 return {arrangement:next,clips,selectedIds,...(trim?{trim}:{})};
}
