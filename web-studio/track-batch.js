import {uid,validateProject} from './model.js';
import {selectedTrackRoots,trackFamily} from './track-hierarchy.js';

// One mapping for the whole selection preserves routes and shared sources across roots.
export function editTracks(project,ids,action){
 const roots=selectedTrackRoots(project,ids),families=roots.map(t=>trackFamily(project,t.id));
 const included=new Set(families.flat().map(t=>t.id)),p=structuredClone(project);
 let selectedIds;
 if(action==='duplicate'){
  if(p.tracks.length+included.size>16)throw Error('The Complete Track Copy Would Exceed 16 Tracks.');
  const sourceIds=new Set([...project.tracks.filter(t=>included.has(t.id)).flatMap(t=>t.slots),...project.arrangement.filter(r=>included.has(r.trackId)).map(r=>r.clipId)].filter(Boolean));
  if(Object.keys(project.clips).length+sourceIds.size>512)throw Error('The Copy Would Exceed 512 Clip Sources.');
  if(project.arrangement.length+project.arrangement.filter(r=>included.has(r.trackId)).length>10000)throw Error('The Copy Would Exceed 10,000 Arrangement Regions.');
  const tracks=new Map([...included].map(id=>[id,uid()])),clips=new Map();
  const cloneClip=id=>{if(!id)return null;if(!clips.has(id)){const copy=structuredClone(p.clips[id]);copy.id=uid();p.clips[copy.id]=copy;clips.set(id,copy.id);}return clips.get(id);};
  const inserts=new Map(families.map((family,i)=>[family.at(-1).id,family.map(original=>{
   const copy=structuredClone(original);copy.id=tracks.get(original.id);
   if(original.id===roots[i].id)copy.name=copy.name.slice(0,35)+' copy';
   copy.devices=(copy.devices||[]).map(d=>({...d,id:uid()}));
   if(tracks.has(copy.parentId))copy.parentId=tracks.get(copy.parentId);
   if(copy.output?.startsWith('track:')&&tracks.has(copy.output.slice(6)))copy.output='track:'+tracks.get(copy.output.slice(6));
   copy.slots=copy.slots.map(cloneClip);return copy;
  })]));
  p.tracks=p.tracks.flatMap(t=>[t,...inserts.get(t.id)??[]]);
  p.arrangement.push(...project.arrangement.filter(r=>included.has(r.trackId)).map(r=>({...structuredClone(r),id:uid(),trackId:tracks.get(r.trackId),clipId:cloneClip(r.clipId)})));
  selectedIds=roots.map(t=>tracks.get(t.id));
 }else if(action==='delete'){
  if(included.size===p.tracks.length)throw Error('Keep At Least One Track Before Deleting The Selection.');
  const index=p.tracks.findIndex(t=>included.has(t.id)),old=new Map(p.tracks.map(t=>[t.id,t]));
  const candidates=new Set([...p.tracks.filter(t=>included.has(t.id)).flatMap(t=>t.slots),...p.arrangement.filter(r=>included.has(r.trackId)).map(r=>r.clipId)].filter(Boolean));
  p.tracks=p.tracks.filter(t=>!included.has(t.id));
  for(const t of p.tracks){let output=t.output;const visited=new Set();while(output?.startsWith('track:')&&included.has(output.slice(6))){if(visited.has(output))throw Error('Invalid Track Routing Cycle.');visited.add(output);output=old.get(output.slice(6)).output??'master';}if(output!==undefined)t.output=output;}
  p.arrangement=p.arrangement.filter(r=>!included.has(r.trackId));
  const used=new Set([...p.tracks.flatMap(t=>t.slots),...p.arrangement.map(r=>r.clipId)]);
  for(const id of candidates)if(!used.has(id))delete p.clips[id];
  selectedIds=[p.tracks[Math.min(index,p.tracks.length-1)].id];
 }else throw Error('Unsupported Track Edit.');
 validateProject(p);return {project:p,selectedIds,trackId:selectedIds[0],count:included.size};
}

export const TRACK_EDIT_CONTEXT='[data-track-header],[data-track-select]';
export function trackEditShortcut(e,{trackFocus=false,typing=false,dialog=false,menu=false}={}){
 if(!trackFocus||typing||dialog||menu||e.defaultPrevented||e.altKey||e.shiftKey||e.repeat)return null;
 if(e.metaKey||e.ctrlKey)return ({KeyD:'duplicate',KeyR:'rename',KeyA:'select-all'})[e.code]??null;
 return ['Delete','Backspace'].includes(e.key)?'delete':null;
}
