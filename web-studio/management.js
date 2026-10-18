import {trackFamily,parentOf} from './track-hierarchy.js';
import {uid,validateProject} from './model.js';
const initialNames=['Intro','Lift','Breakdown','Return'];
export function sceneNames(project){return Array.from({length:project.scenes},(_,i)=>project.sceneNames?.[i]??initialNames[i]??`Scene ${i+1}`);}
function cleanClips(p,candidates){const used=new Set([...p.tracks.flatMap(t=>t.slots),...p.arrangement.map(s=>s.clipId)]);for(const id of candidates)if(!used.has(id))delete p.clips[id];}
function copyClip(p,id){if(!id)return null;const clip=structuredClone(p.clips[id]);clip.id=uid();p.clips[clip.id]=clip;return clip.id;}
export function editTrack(project,id,action,value){
  const p=structuredClone(project),index=p.tracks.findIndex(t=>t.id===id),track=p.tracks[index];if(!track)throw new Error('Choose a track.');let selected=id;
  if(action==='rename'){const name=String(value).trim();if(!name||name.length>40)throw new Error('Track names must contain 1–40 characters.');track.name=name;}
  else if(action==='color'){if(!/^#[0-9a-f]{6}$/i.test(value))throw new Error('Choose a valid track color.');track.color=value;}
  else if(action==='move'){
    const siblings=p.tracks.filter(t=>parentOf(t)===parentOf(track)),at=siblings.indexOf(track),target=siblings[at+value];if(![-1,1].includes(value)||!target)throw new Error('The track is already at that folder edge.');const family=trackFamily(p,id),ids=new Set(family.map(t=>t.id));p.tracks=p.tracks.filter(t=>!ids.has(t.id));const to=p.tracks.findIndex(t=>t.id===target.id)+(value>0?trackFamily(p,target.id).length:0);p.tracks.splice(to,0,...family);
  }else if(action==='duplicate'){
    const family=trackFamily(p,id);if(p.tracks.length+family.length>16)throw new Error('The complete group copy would exceed 16 tracks.');const trackIds=new Map(family.map(t=>[t.id,uid()])),clips=new Map();
    const clone=clipId=>{if(!clipId)return null;if(!clips.has(clipId))clips.set(clipId,copyClip(p,clipId));return clips.get(clipId);};
    const copies=family.map(original=>{const copy=structuredClone(original);copy.id=trackIds.get(original.id);if(original===track)copy.name=track.name.slice(0,35)+' copy';copy.devices=(copy.devices||[]).map(d=>({...d,id:uid()}));if(trackIds.has(copy.parentId))copy.parentId=trackIds.get(copy.parentId);if(copy.output?.startsWith('track:')&&trackIds.has(copy.output.slice(6)))copy.output='track:'+trackIds.get(copy.output.slice(6));copy.slots=copy.slots.map(clone);return copy;});
    const regions=p.arrangement.filter(r=>trackIds.has(r.trackId)).map(r=>({...structuredClone(r),id:uid(),trackId:trackIds.get(r.trackId),clipId:clone(r.clipId)}));p.arrangement.push(...regions);p.tracks.splice(index+family.length,0,...copies);selected=copies[0].id;
  }else if(action==='delete'){
    const ids=new Set(trackFamily(p,id).map(t=>t.id));if(p.tracks.length===ids.size)throw new Error('Keep at least one track outside this group before deleting it.');const candidates=new Set([...p.tracks.filter(t=>ids.has(t.id)).flatMap(t=>t.slots),...p.arrangement.filter(r=>ids.has(r.trackId)).map(r=>r.clipId)].filter(Boolean)),old=new Map(p.tracks.map(t=>[t.id,t]));p.tracks=p.tracks.filter(t=>!ids.has(t.id));for(const source of p.tracks){let output=source.output;while(output?.startsWith('track:')&&ids.has(output.slice(6)))output=old.get(output.slice(6)).output??'master';if(output!==undefined)source.output=output;}p.arrangement=p.arrangement.filter(r=>!ids.has(r.trackId));cleanClips(p,candidates);selected=p.tracks[Math.min(index,p.tracks.length-1)].id;
  }
  else throw new Error('Unsupported track operation: '+String(action).slice(0,60)+'. Use rename, color, move, duplicate or delete. Create tracks with add_track; set volume, pan or output with a track changes action.');validateProject(p);return {project:p,trackId:selected};
}
export function editScene(project,index,action,value){
  if(!Number.isInteger(index)||index<0||index>=project.scenes)throw new Error('Choose a scene.');const p=structuredClone(project);p.sceneNames=sceneNames(p);let selected=index;
  if(action==='rename'){const name=String(value).trim();if(!name||name.length>80)throw new Error('Scene names must contain 1–80 characters.');p.sceneNames[index]=name;}
  else if(action==='move'){const to=index+value;if(![-1,1].includes(value)||to<0||to>=p.scenes)throw new Error('The scene is already at that edge.');[p.sceneNames[index],p.sceneNames[to]]=[p.sceneNames[to],p.sceneNames[index]];if(p.sceneFollows)[p.sceneFollows[index],p.sceneFollows[to]]=[p.sceneFollows[to],p.sceneFollows[index]];for(const t of p.tracks){[t.slots[index],t.slots[to]]=[t.slots[to],t.slots[index]];if(t.noStopSlots)t.noStopSlots=t.noStopSlots.map(i=>i===index?to:i===to?index:i).sort((a,b)=>a-b);}selected=to;}
  else if(action==='duplicate'){if(p.scenes>=32)throw new Error('A project supports up to 32 scenes.');for(const t of p.tracks){t.slots.splice(index+1,0,copyClip(p,t.slots[index]));if(t.noStopSlots){const copy=t.noStopSlots.includes(index);t.noStopSlots=t.noStopSlots.map(i=>i>index?i+1:i);if(copy)t.noStopSlots.push(index+1);t.noStopSlots.sort((a,b)=>a-b);}}p.sceneNames.splice(index+1,0,p.sceneNames[index].slice(0,75)+' copy');if(p.sceneFollows)p.sceneFollows.splice(index+1,0,structuredClone(p.sceneFollows[index]));p.scenes++;selected=index+1;}
  else if(action==='delete'){if(p.scenes===1)throw new Error('Keep at least one scene in the project.');const candidates=new Set(p.tracks.map(t=>t.slots[index]).filter(Boolean));for(const t of p.tracks){t.slots.splice(index,1);if(t.noStopSlots)t.noStopSlots=t.noStopSlots.filter(i=>i!==index).map(i=>i>index?i-1:i);}p.sceneNames.splice(index,1);p.sceneFollows?.splice(index,1);p.scenes--;cleanClips(p,candidates);selected=Math.min(index,p.scenes-1);}
  else throw new Error('Unknown scene operation.');validateProject(p);return {project:p,scene:selected};
}

export function editSlotStop(project,trackId,index,enabled){const p=structuredClone(project),t=p.tracks.find(t=>t.id===trackId);if(!t||!Number.isInteger(index)||index<0||index>=p.scenes||t.slots[index]!==null||typeof enabled!=='boolean')throw new Error('Choose an empty Session slot.');t.noStopSlots=(t.noStopSlots||[]).filter(i=>i!==index);if(!enabled)t.noStopSlots.push(index);t.noStopSlots.sort((a,b)=>a-b);if(!t.noStopSlots.length)delete t.noStopSlots;validateProject(p);return p;}
