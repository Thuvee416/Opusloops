import {uid,validateProject} from './model.js';
import {isGroup} from './track-hierarchy.js';
import {appendRecordedClip,recordingDestination} from './recording-control.js';
export function emptyMidiTarget(project,{view,deviceTrackId=null,trackIds=[],selectedSlots=[],selectionTrackId=null,scene=0,range=null,laneTrackId=null,insertBeat=0}){
 if(deviceTrackId!==null&&!project.tracks.some(t=>t.id===deviceTrackId))throw Error('Choose A Regular Track For The MIDI Clip.');
 if(view==='session'){
  const ids=deviceTrackId?[...(trackIds.length?trackIds:[deviceTrackId])]:[];
  const slots=ids.length?ids.map(trackId=>({trackId,scene})):selectedSlots.length?selectedSlots.map(({trackId,scene})=>({trackId,scene})):[{trackId:selectionTrackId??project.tracks[0]?.id,scene}];
  return {view,slots,length:4};
 }
 if(view!=='arrangement')throw Error('Choose Session Or Arrangement.');
 return {view,trackId:deviceTrackId??laneTrackId??trackIds[0]??selectionTrackId??project.tracks[0]?.id,start:range?.start??insertBeat,length:range?.length??4};
}
export function emptyMidiPlan(project,target){
 const length=target.length??4;if(!Number.isFinite(length)||length<.25||length>256)throw Error('Choose A MIDI Clip Length From 0.25 To 256 Beats.');
 const track=id=>{const t=project.tracks.find(t=>t.id===id);if(!t||isGroup(t))throw Error('Choose A Regular Track For The MIDI Clip.');return t;};
 let placements;
 if(target.view==='session'){
  if(!Array.isArray(target.slots)||!target.slots.length)throw Error('Select An Empty Session Slot.');
  const seen=new Set();placements=target.slots.map(s=>{const t=track(s.trackId),key=JSON.stringify([s.trackId,s.scene]);if(!Number.isInteger(s.scene)||s.scene<0||s.scene>=project.scenes||seen.has(key))throw Error('Select Distinct Existing Session Slots.');if(t.slots[s.scene]!==null)throw Error('Select Empty Session Slots. Existing Clips Will Not Be Replaced.');seen.add(key);return {trackId:t.id,scene:s.scene};});
 }else if(target.view==='arrangement'){
  const t=track(target.trackId),start=target.start;if(!Number.isFinite(start)||start<0||start+length>16384)throw Error('Choose A MIDI Clip Range Within The Arrangement.');
  if(project.arrangement.length>=10000)throw Error('The Arrangement Has Reached Its Region Limit.');
  if(project.arrangement.some(r=>r.trackId===t.id&&r.start<start+length-1e-7&&r.start+r.length>start+1e-7))throw Error('Choose Empty Time On This Track. Existing Clips Will Not Be Replaced.');
  placements=[{trackId:t.id,start}];
 }else if(target.view==='session-next')placements=[recordingDestination(project,target.trackId)];
 else throw Error('Choose A Valid MIDI Clip Destination.');
 if(Object.keys(project.clips).length+placements.length>512)throw Error('Creating These Clips Would Exceed The 512-Clip Limit.');
 return {view:target.view,length,placements};
}
export function createEmptyMidi(project,target){
 const plan=emptyMidiPlan(project,target);let next=structuredClone(project);const clips=[],regions=[],slots=[];
 for(const placement of plan.placements){const clip={id:uid(),name:'New MIDI Clip',kind:'midi',beats:plan.length,sourceBpm:project.bpm,notes:[]};clips.push(clip.id);
  if(plan.view==='session-next'){const result=appendRecordedClip(next,clip,placement.trackId);next=result.project;slots.push({trackId:placement.trackId,scene:result.scene,clipId:clip.id});}
  else{next.clips[clip.id]=clip;if(plan.view==='session'){next.tracks.find(t=>t.id===placement.trackId).slots[placement.scene]=clip.id;slots.push({...placement,clipId:clip.id});}
   else{const region={id:uid(),clipId:clip.id,trackId:placement.trackId,start:placement.start,length:plan.length,offset:0};next.arrangement.push(region);regions.push(region.id);}}
 }
 validateProject(next);return {project:next,clips,regions,slots};
}
