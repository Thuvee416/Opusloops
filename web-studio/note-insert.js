import {editNotes,editNoteGroup} from './notes.js';
export function noteInsertPosition(value,beats){
 if(!Number.isFinite(value)||!Number.isFinite(beats)||beats<=0)throw new Error('Choose A Valid Insert Beat.');
 return Math.max(0,Math.min(beats,value));
}
export function noteInsertKey(event,{at,beats,grid,notes}){
 if(event.isComposing||event.shiftKey||event.metaKey)return null;
 if(event.key==='Home'&&!event.ctrlKey&&!event.altKey)return 0;
 if(event.key==='End'&&!event.ctrlKey&&!event.altKey)return beats;
 if(!['ArrowLeft','ArrowRight'].includes(event.key))return null;
 if(![.0625,.125,.25,.5,1].includes(grid))throw new Error('Choose A Valid Note Grid.');
 const right=event.key==='ArrowRight';
 if(event.ctrlKey||event.altKey){
  const points=[...new Set([0,beats,...notes.flatMap(n=>[n.start,Math.min(beats,n.start+n.duration)])])].sort((a,b)=>a-b);
  return right?(points.find(n=>n>at+1e-9)??beats):(points.reverse().find(n=>n<at-1e-9)??0);
 }
 return noteInsertPosition((right?Math.floor(at/grid+1e-9)+1:Math.ceil(at/grid-1e-9)-1)*grid,beats);
}
export function insertNoteAt(clip,{at,pitch,grid}){
 if(!Number.isFinite(at)||at<0||at>=clip.beats)throw new Error('Move The Insert Marker Before The End Of The Clip.');
 if(![.0625,.125,.25,.5,1].includes(grid))throw new Error('Choose A Valid Note Grid.');
 const result=editNotes(clip,'add',{patch:{pitch,start:at,duration:Math.min(grid,clip.beats-at),velocity:.7}});
 return {...result,selection:[result.selection]};
}
export function notesAtInsert(clip,at){return clip?.kind==='midi'&&Number.isFinite(at)&&at>0&&at<clip.beats?clip.notes.flatMap((n,i)=>n.start<at&&n.start+n.duration>at?[i]:[]):[];}
export function splitNotesAtInsert(clip,at){return editNoteGroup(clip,'split',{indices:notesAtInsert(clip,at),at});}
