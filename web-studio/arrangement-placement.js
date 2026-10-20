import {uid,validateProject,REGION_MIN_BEATS} from './model.js';
import {isGroup} from './track-hierarchy.js';
import {slotActive} from './slot-metadata.js';
// Apply to new placements and changed geometry. Older saved projects remain
// readable even if an earlier editor allowed content beyond the current timeline.
export function assertArrangementRange(region){
 if(!Number.isFinite(region.start)||region.start<0||!Number.isFinite(region.length)||region.length<REGION_MIN_BEATS||region.start+region.length>16384)throw Error('Keep The Entire Clip Within The 16,384-Beat Arrangement.');
 return region;
}
export function appendArrangementClip(project,selection){
 const track=project.tracks.find(t=>t.id===selection?.trackId),clip=project.clips[selection?.clipId];
 if(!track||isGroup(track)||!clip)throw Error('Select A Clip On An Audio Or MIDI Track First.');
 const scene=selection.scene===undefined?track.slots.indexOf(clip.id):selection.scene;
 if(selection.scene!==undefined&&(!Number.isInteger(scene)||scene<0||scene>=project.scenes||track.slots[scene]!==clip.id))throw Error('The Selected Session Slot Changed. Select The Clip Again.');
 if(scene<0&&!project.arrangement.some(r=>r.trackId===track.id&&r.clipId===clip.id))throw Error('The Selected Clip No Longer Belongs To This Track.');
 if(project.arrangement.length>=10000)throw Error('The Arrangement Already Contains 10,000 Clips. Remove A Clip Before Adding Another.');
 const start=Math.ceil(Math.max(0,...project.arrangement.filter(r=>r.trackId===track.id).map(r=>r.start+r.length))*4)/4;
 const region=assertArrangementRange({id:uid(),trackId:track.id,clipId:clip.id,start,length:clip.beats,offset:0,...(scene>=0&&!slotActive(track,scene)?{active:false}:{})});
 const next={...project,arrangement:[...project.arrangement,region]};validateProject(next);
 return {project:next,region};
}
