import {uid,validateProject} from './model.js';
export function transferSessionClip(project,source,destination,copy=false){
 const p=structuredClone(project),from=p.tracks.find(t=>t.id===source.trackId),to=p.tracks.find(t=>t.id===destination.trackId);
 if(!from||!to||![source.scene,destination.scene].every(i=>Number.isInteger(i)&&i>=0&&i<p.scenes)||typeof copy!=='boolean')throw new Error('Choose valid source and destination slots.');
 const id=from.slots[source.scene],clip=p.clips[id];if(!clip||source.clipId!==id)throw new Error('The source clip changed. Select it again.');
 if(from===to&&source.scene===destination.scene)throw new Error('Choose a different destination slot.');
 const replaced=to.slots[destination.scene];let clipId=id;
 if(copy){const duplicate=structuredClone(clip);duplicate.id=uid();duplicate.name=(clip.name.slice(0,195)+' copy');clipId=duplicate.id;p.clips[clipId]=duplicate;}else from.slots[source.scene]=null;
 to.slots[destination.scene]=clipId;
 if(replaced&&replaced!==clipId&&!p.tracks.some(t=>t.slots.includes(replaced))&&!p.arrangement.some(r=>r.clipId===replaced))delete p.clips[replaced];
 validateProject(p);return {project:p,clipId,replaced};
}
