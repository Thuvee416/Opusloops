import {uid,validateProject} from './model.js';
import {isGroup,groupLeaves} from './track-hierarchy.js';
import {slotStops} from './launch.js';
import {slotActive,setSlotActive,setSlotStops} from './slot-metadata.js';
const fail=message=>{throw new Error(message);};
export const slotKey=slot=>JSON.stringify([slot.trackId,slot.scene]);
export function sessionSlots(project,slots,{expandGroups=false,allowEmpty=true}={}){
 if(!Array.isArray(slots)||!slots.length||slots.length>512)fail('Choose 1–512 Session slots.');const result=[],seen=new Set();
 for(const slot of slots){if(!slot||typeof slot!=='object'||Array.isArray(slot)||Object.keys(slot).some(k=>!['trackId','scene','clipId'].includes(k)))fail('Session slots accept trackId, zero-based scene and optional matching clipId.');const track=project.tracks.find(t=>t.id===slot.trackId);if(!track||!Number.isInteger(slot.scene)||slot.scene<0||slot.scene>=project.scenes)fail('Choose an existing track and zero-based Session scene.');
  if(isGroup(track)&&!expandGroups)fail('Choose regular Session tracks, or expand the group selection.');
  for(const t of isGroup(track)?groupLeaves(project,track.id):[track]){const clipId=t.slots[slot.scene];if(slot.clipId!==undefined&&slot.clipId!==clipId)fail('The selected Session clip changed. Select its current slot again.');if(!allowEmpty&&!clipId)fail('Choose occupied Session clips.');const out={trackId:t.id,scene:slot.scene,...(clipId?{clipId}:{})},key=slotKey(out);if(seen.has(key)){if(!expandGroups)fail('Choose unique Session slots.');continue;}seen.add(key);result.push(out);}
 }
 if(!result.length)fail('This group has no contained Session tracks.');return result.sort((a,b)=>project.tracks.findIndex(t=>t.id===a.trackId)-project.tracks.findIndex(t=>t.id===b.trackId)||a.scene-b.scene);
}
export function sessionRectangle(project,visible,anchor,end){const a=visible.indexOf(anchor.trackId),b=visible.indexOf(end.trackId);if(a<0||b<0)fail('Selection anchor is not visible.');const slots=[];for(const trackId of visible.slice(Math.min(a,b),Math.max(a,b)+1))for(let scene=Math.min(anchor.scene,end.scene);scene<=Math.max(anchor.scene,end.scene);scene++)slots.push({trackId,scene});return sessionSlots(project,slots,{expandGroups:true});}
export function copySessionClips(project,slots){
 slots=sessionSlots(project,slots);const leaf=project.tracks.filter(t=>!isGroup(t)),left=Math.min(...slots.map(s=>leaf.findIndex(t=>t.id===s.trackId))),top=Math.min(...slots.map(s=>s.scene));if(!slots.some(s=>s.clipId))fail('Choose at least one occupied Session clip.');
 return {format:'opus-session-clipboard',version:1,revision:uid(),width:Math.max(...slots.map(s=>leaf.findIndex(t=>t.id===s.trackId)))-left+1,height:Math.max(...slots.map(s=>s.scene))-top+1,cells:slots.map(s=>({column:leaf.findIndex(t=>t.id===s.trackId)-left,row:s.scene-top,clip:s.clipId?structuredClone(project.clips[s.clipId]):null,active:s.clipId?slotActive(leaf.find(t=>t.id===s.trackId),s.scene):true,...(!s.clipId?{stops:slotStops(leaf.find(t=>t.id===s.trackId),s.scene)}:{})}))};
}
function validateClipboard(clipboard){
 if(!clipboard||clipboard.format!=='opus-session-clipboard'||clipboard.version!==1||typeof clipboard.revision!=='string'||!Number.isInteger(clipboard.width)||clipboard.width<1||clipboard.width>16||!Number.isInteger(clipboard.height)||clipboard.height<1||clipboard.height>32||!Array.isArray(clipboard.cells)||!clipboard.cells.length||clipboard.cells.length>512)fail('Copy Session clips before pasting.');
 if(!clipboard.cells.some(cell=>cell.clip))fail('The Session clipboard contains no clips.');
 const keys=new Set();for(const cell of clipboard.cells){const key=cell.column+':'+cell.row;if(!Number.isInteger(cell.column)||cell.column<0||cell.column>=clipboard.width||!Number.isInteger(cell.row)||cell.row<0||cell.row>=clipboard.height||typeof cell.active!=='boolean'||Object.hasOwn(cell,'stops')&&(typeof cell.stops!=='boolean'||cell.clip!==null)||keys.has(key)||cell.clip!==null&&(!cell.clip||typeof cell.clip!=='object'))fail('Invalid Session clipboard.');keys.add(key);}
}
function cleanClips(project,candidates){const used=new Set([...project.tracks.flatMap(t=>t.slots),...project.arrangement.map(r=>r.clipId)]);for(const id of candidates)if(!used.has(id))delete project.clips[id];}
function extendScenes(project,count){if(count>32)fail('This Session edit would exceed 32 scenes.');while(project.scenes<count){project.scenes++;for(const t of project.tracks)t.slots.push(null);project.sceneNames?.push('Scene '+project.scenes);project.sceneFollows?.push(null);}}
export function editSessionClips(project,args,{clipboard=null}={}){
 if(!args||typeof args!=='object'||Array.isArray(args)||!['delete','cut','active','duplicate','copy','move','paste'].includes(args.action))fail('session_clips REQUIRES args.action: delete, cut, active, duplicate, copy, move or paste. A copy request MUST include action:copy alongside slots and one top-left destination. Do not repeat the previous plan without the required action.');
 const allowed=['action',...(args.action==='paste'?[]:['slots']),...(['duplicate','copy','move','paste'].includes(args.action)?['destination']:[]),...(args.action==='active'?['active']:[])];if(Object.keys(args).some(k=>!allowed.includes(k)))fail('Unsupported Session edit fields.');
 const slots=args.action==='paste'?[]:sessionSlots(project,args.slots);if(slots.length&&!slots.some(s=>s.clipId))fail('Choose at least one occupied Session clip.');if(args.active!==undefined&&typeof args.active!=='boolean')fail('Choose active true or false.');
 const p=structuredClone(project),candidates=new Set(),result={project:p,selection:slots};
 if(args.action==='active'){const active=args.active??!slots.every(s=>!s.clipId||slotActive(p.tracks.find(t=>t.id===s.trackId),s.scene));for(const s of slots)if(s.clipId)setSlotActive(p.tracks.find(t=>t.id===s.trackId),s.scene,active);result.active=active;}
 else{
  const copied=args.action==='paste'?structuredClone(clipboard):copySessionClips(project,slots);validateClipboard(copied);
  if(['delete','cut','move'].includes(args.action))for(const s of slots){const t=p.tracks.find(t=>t.id===s.trackId);if(t.slots[s.scene])candidates.add(t.slots[s.scene]);t.slots[s.scene]=null;setSlotActive(t,s.scene,true);}
  if(args.action==='cut')result.clipboard=copied;
  if(['duplicate','copy','move','paste'].includes(args.action)){
   let dest=args.destination;if(!dest&&args.action==='duplicate')dest={trackId:slots[0].trackId,scene:Math.min(...slots.map(s=>s.scene))+copied.height};
   if(!dest||typeof dest!=='object'||Array.isArray(dest)||Object.keys(dest).some(k=>!['trackId','scene'].includes(k))||!Number.isInteger(dest.scene)||dest.scene<0||dest.scene>=32)fail('Choose a destination trackId and zero-based scene.');
   const leaf=p.tracks.filter(t=>!isGroup(t)),left=leaf.findIndex(t=>t.id===dest.trackId);if(left<0||left+copied.width>leaf.length)fail('The copied selection is '+copied.width+' tracks wide and needs ONE top-left destination for the whole rectangle. Available regular tracks in order: '+leaf.map(t=>t.id+' ('+t.name+')').join(', ')+'. Do not repeat all source slots once per destination track. Displayed scene 3 means zero-based scene 2.');extendScenes(p,dest.scene+copied.height);result.selection=[];
   for(const cell of copied.cells){const track=leaf[left+cell.column],scene=dest.scene+cell.row;if(track.slots[scene])candidates.add(track.slots[scene]);let clipId=null;if(cell.clip){if(args.action==='move'){clipId=cell.clip.id;p.clips[clipId]??=structuredClone(cell.clip);}else{const clip=structuredClone(cell.clip);clip.id=uid();clipId=clip.id;p.clips[clipId]=clip;}}track.slots[scene]=clipId;setSlotActive(track,scene,cell.active||!clipId);if(!clipId&&Object.hasOwn(cell,'stops'))setSlotStops(track,scene,cell.stops);result.selection.push({trackId:track.id,scene,...(clipId?{clipId}:{})});}
  }
  cleanClips(p,candidates);
 }
 validateProject(p);return result;
}
export function sessionClipboardSummary(clipboard){return clipboard?{revision:clipboard.revision,clips:clipboard.cells.filter(c=>c.clip).length,width:clipboard.width,height:clipboard.height}:null;}
export function sessionActivationOnly(before,after){
 const same=(a,b,track=false)=>{if(a===b)return true;if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;if(Array.isArray(a)&&a.length!==b.length)return false;const keys=Object.keys(a).filter(k=>!track||k!=='inactiveSlots'),other=Object.keys(b).filter(k=>!track||k!=='inactiveSlots');return keys.length===other.length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));};
 const a={...before},b={...after};delete a.tracks;delete b.tracks;return same(a,b)&&before.tracks.length===after.tracks.length&&before.tracks.every((track,i)=>same(track,after.tracks[i],true));
}
