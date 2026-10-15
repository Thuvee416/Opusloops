import {uid,validateProject} from './model.js';
import {sceneNames} from './management.js';
// Build before committing: invalid input or clip/scene limits cannot partially insert a row.
export function captureScene(project,active,after){
 if(!Number.isInteger(after)||after<0||after>=project.scenes)throw new Error('Select a Session scene.');
 if(project.scenes>=32)throw new Error('A project supports up to 32 scenes.');
 const next=structuredClone(project),index=after+1,copies=[];next.sceneNames=sceneNames(project);next.sceneNames.splice(index,0,`Captured ${project.scenes+1}`);next.sceneFollows?.splice(index,0,null);next.scenes++;
 for(const track of next.tracks){const source=active.get(track.id)?.clipId;let id=null;
  if(source){const clip=project.clips[source];if(!clip)throw new Error('A running clip is unavailable.');const copy=structuredClone(clip);copy.id=uid();id=copy.id;next.clips[id]=copy;copies.push({trackId:track.id,source,id});}
  track.slots.splice(index,0,id);if(track.noStopSlots)track.noStopSlots=track.noStopSlots.map(i=>i>=index?i+1:i);
 }
 validateProject(next);return {project:next,index,copies};
}
