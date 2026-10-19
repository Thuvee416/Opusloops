import {splitSegment,validateProject,REGION_MIN_BEATS} from './model.js';

// Plan all cuts before returning a candidate; source clips and track automation
// remain shared and unchanged. The caller commits the whole edit once.
export function splitRegions(project,ids,points){
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!project.arrangement.some(r=>r.id===id)))throw Error('Select Existing Arrangement Clips To Split.');
 if(!Array.isArray(points)||!points.length||points.some(p=>!Number.isFinite(p)||p<0||p>16384))throw Error('Choose Valid Split Positions Within The Timeline.');
 const cuts=[...new Set(points)].sort((a,b)=>a-b),selected=new Set(ids),splits=[];
 const arrangement=project.arrangement.flatMap(region=>{
  if(!selected.has(region.id))return [region];
  const inside=cuts.filter(at=>at>region.start&&at<region.start+region.length);
  if(!inside.length)return [region];
  const boundaries=[region.start,...inside,region.start+region.length];
  if(boundaries.some((at,i)=>i&&at-boundaries[i-1]<REGION_MIN_BEATS))throw Error('Keep At Least 1/16 Beat In Each Split Clip.');
  let tail=region;const parts=[];
  for(const at of inside){const [left,right]=splitSegment(tail,at);parts.push(left);tail=right;}parts.push(tail);
  splits.push({originalId:region.id,ids:parts.map(r=>r.id)});return parts;
 });
 if(!splits.length)throw Error('Place The Insert Marker Or Range Boundary Inside A Clip.');
 validateProject({...project,arrangement});
 const replacements=new Map(splits.map(s=>[s.originalId,s.ids]));
 return {arrangement,selectedIds:ids.flatMap(id=>replacements.get(id)??[id]),splits};
}

export function arrangementSplitTarget(project,{ids=[],range=null,trackIds=null,trackId,at}={}){
 if(range){
  const {start,length}=range;
  if(!Number.isFinite(start)||!Number.isFinite(length)||start<0||length<=0||start+length>16384)throw Error('Choose A Valid Arrangement Time Range.');
  if(trackIds!==null&&(!Array.isArray(trackIds)||!trackIds.length||trackIds.some(id=>!project.tracks.some(t=>t.id===id))))throw Error('Choose Tracks For The Selected Time Range.');
  const scope=trackIds===null?null:new Set(trackIds);
  return {ids:project.arrangement.filter(r=>(!scope||scope.has(r.trackId))&&r.start<start+length&&r.start+r.length>start).map(r=>r.id),points:[start,start+length]};
 }
 return {ids:ids.length?ids:project.arrangement.filter(r=>r.trackId===trackId&&r.start<at&&r.start+r.length>at).map(r=>r.id),points:[at]};
}
