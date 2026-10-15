import {uid,validateProject} from './model.js';
const initialNames=['Intro','Lift','Breakdown','Return'];
export function sceneNames(project){return Array.from({length:project.scenes},(_,i)=>project.sceneNames?.[i]??initialNames[i]??`Scene ${i+1}`);}
function cleanClips(p){const used=new Set([...p.tracks.flatMap(t=>t.slots),...p.arrangement.map(s=>s.clipId)]);for(const id of Object.keys(p.clips))if(!used.has(id))delete p.clips[id];}
function copyClip(p,id){if(!id)return null;const clip=structuredClone(p.clips[id]);clip.id=uid();p.clips[clip.id]=clip;return clip.id;}
export function editTrack(project,id,action,value){
  const p=structuredClone(project),index=p.tracks.findIndex(t=>t.id===id),track=p.tracks[index];if(!track)throw new Error('Choose a track.');let selected=id;
  if(action==='rename'){const name=String(value).trim();if(!name||name.length>40)throw new Error('Track names must contain 1–40 characters.');track.name=name;}
  else if(action==='color'){if(!/^#[0-9a-f]{6}$/i.test(value))throw new Error('Choose a valid track color.');track.color=value;}
  else if(action==='move'){const to=index+value;if(![-1,1].includes(value)||to<0||to>=p.tracks.length)throw new Error('The track is already at that edge.');[p.tracks[index],p.tracks[to]]=[p.tracks[to],p.tracks[index]];}
  else if(action==='duplicate'){
    if(p.tracks.length>=16)throw new Error('A project supports up to 16 tracks.');const copy=structuredClone(track),clips=new Map();copy.id=uid();copy.name=(track.name.slice(0,35)+' copy');copy.devices=(copy.devices||[]).map(d=>({...d,id:uid()}));
    const clone=id=>{if(!id)return null;if(!clips.has(id))clips.set(id,copyClip(p,id));return clips.get(id);};copy.slots=copy.slots.map(clone);
    const regions=p.arrangement.filter(s=>s.trackId===track.id).map(s=>({...s,id:uid(),trackId:copy.id,clipId:clone(s.clipId)}));p.arrangement.push(...regions);p.tracks.splice(index+1,0,copy);selected=copy.id;
  }else if(action==='delete'){if(p.tracks.length===1)throw new Error('Keep at least one track in the project.');p.tracks.splice(index,1);p.arrangement=p.arrangement.filter(s=>s.trackId!==id);cleanClips(p);selected=p.tracks[Math.min(index,p.tracks.length-1)].id;}
  else throw new Error('Unknown track operation.');validateProject(p);return {project:p,trackId:selected};
}
export function editScene(project,index,action,value){
  if(!Number.isInteger(index)||index<0||index>=project.scenes)throw new Error('Choose a scene.');const p=structuredClone(project);p.sceneNames=sceneNames(p);let selected=index;
  if(action==='rename'){const name=String(value).trim();if(!name||name.length>80)throw new Error('Scene names must contain 1–80 characters.');p.sceneNames[index]=name;}
  else if(action==='move'){const to=index+value;if(![-1,1].includes(value)||to<0||to>=p.scenes)throw new Error('The scene is already at that edge.');[p.sceneNames[index],p.sceneNames[to]]=[p.sceneNames[to],p.sceneNames[index]];if(p.sceneFollows)[p.sceneFollows[index],p.sceneFollows[to]]=[p.sceneFollows[to],p.sceneFollows[index]];for(const t of p.tracks){[t.slots[index],t.slots[to]]=[t.slots[to],t.slots[index]];if(t.noStopSlots)t.noStopSlots=t.noStopSlots.map(i=>i===index?to:i===to?index:i).sort((a,b)=>a-b);}selected=to;}
  else if(action==='duplicate'){if(p.scenes>=32)throw new Error('A project supports up to 32 scenes.');for(const t of p.tracks){t.slots.splice(index+1,0,copyClip(p,t.slots[index]));if(t.noStopSlots){const copy=t.noStopSlots.includes(index);t.noStopSlots=t.noStopSlots.map(i=>i>index?i+1:i);if(copy)t.noStopSlots.push(index+1);t.noStopSlots.sort((a,b)=>a-b);}}p.sceneNames.splice(index+1,0,p.sceneNames[index].slice(0,75)+' copy');if(p.sceneFollows)p.sceneFollows.splice(index+1,0,structuredClone(p.sceneFollows[index]));p.scenes++;selected=index+1;}
  else if(action==='delete'){if(p.scenes===1)throw new Error('Keep at least one scene in the project.');for(const t of p.tracks){t.slots.splice(index,1);if(t.noStopSlots)t.noStopSlots=t.noStopSlots.filter(i=>i!==index).map(i=>i>index?i-1:i);}p.sceneNames.splice(index,1);p.sceneFollows?.splice(index,1);p.scenes--;cleanClips(p);selected=Math.min(index,p.scenes-1);}
  else throw new Error('Unknown scene operation.');validateProject(p);return {project:p,scene:selected};
}

export function editSlotStop(project,trackId,index,enabled){const p=structuredClone(project),t=p.tracks.find(t=>t.id===trackId);if(!t||!Number.isInteger(index)||index<0||index>=p.scenes||t.slots[index]!==null||typeof enabled!=='boolean')throw new Error('Choose an empty Session slot.');t.noStopSlots=(t.noStopSlots||[]).filter(i=>i!==index);if(!enabled)t.noStopSlots.push(index);t.noStopSlots.sort((a,b)=>a-b);if(!t.noStopSlots.length)delete t.noStopSlots;validateProject(p);return p;}
