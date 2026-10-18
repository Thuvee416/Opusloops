import {uid,validateProject,canPlace} from './model.js';

export function copyRegionSelection(project,ids){
 validateProject(project);
 const selected=new Set(ids),regions=project.arrangement.filter(r=>selected.has(r.id));
 if(!regions.length||regions.length!==selected.size)throw new Error('Select Arrangement clips to copy.');
 const start=Math.min(...regions.map(r=>r.start)),base=Math.min(...regions.map(r=>project.tracks.findIndex(t=>t.id===r.trackId)));
 const clips=Object.fromEntries([...new Set(regions.map(r=>r.clipId))].map(id=>[id,structuredClone(project.clips[id])]));
 return {format:'opus-region-clipboard',version:1,length:Math.max(...regions.map(r=>r.start+r.length))-start,regions:regions.map(r=>({...structuredClone(r),start:r.start-start,trackOffset:project.tracks.findIndex(t=>t.id===r.trackId)-base})),clips};
}

export function pasteRegionSelection(project,clipboard,start,trackId){
 if(!clipboard||clipboard.format!=='opus-region-clipboard'||clipboard.version!==1||!Array.isArray(clipboard.regions)||!clipboard.regions.length||!clipboard.clips||!Number.isFinite(clipboard.length)||clipboard.length<=0)throw new Error('Copy or cut Arrangement clips first.');
 if(!Number.isFinite(start)||start<0||start*4%1!==0||start+clipboard.length>16384)throw new Error('Choose a paste position on the quarter-beat grid within the timeline.');
 const base=project.tracks.findIndex(t=>t.id===trackId);if(base<0)throw new Error('Select a destination track.');
 if(Object.keys(project.clips).length+clipboard.regions.length>512)throw new Error('Pasting would exceed the 512-clip project limit.');
 const clips={...project.clips},regions=clipboard.regions.map(r=>{
  if(!Number.isInteger(r.trackOffset)||r.trackOffset<0||base+r.trackOffset>=project.tracks.length)throw new Error('Add enough destination tracks to preserve the copied track spacing.');
  if(!Number.isFinite(r.start)||r.start<0||r.start+r.length>clipboard.length+1e-7||!Object.hasOwn(clipboard.clips,r.clipId))throw new Error('The copied Arrangement clips are invalid.');
  const clip=structuredClone(clipboard.clips[r.clipId]);clip.id=uid();clips[clip.id]=clip;
  const {trackOffset,...source}=r;
  const region={...structuredClone(source),id:uid(),trackId:project.tracks[base+trackOffset].id,clipId:clip.id,start:start+r.start};
  if(region.start+region.length>16384)throw new Error('The copied clips exceed the timeline limit.');
  if(!canPlace(project,region))throw new Error('Pasted clips would overlap existing clips. Choose an empty destination.');
  return region;
 });
 const arrangement=[...project.arrangement,...regions];validateProject({...project,clips,arrangement});
 return {clips,arrangement,selectedIds:regions.map(r=>r.id),end:Math.ceil((start+clipboard.length)*4)/4};
}
