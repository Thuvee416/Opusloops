import {editNotes} from './notes.js';
import {copyNoteTime,noteTimeRange,noteTimeIndices} from './note-time-selection.js';

export const MIDI_TIME_ACTIONS=['insert-time','delete-time','duplicate-time'];
export function midiTimeRange(clip,range){
 if(clip?.kind!=='midi'||!range||![range.start,range.end].every(Number.isFinite)||range.start<0||range.end>clip.beats||range.end<=range.start)throw Error('Select A Time Range Inside This MIDI Clip.');
 return noteTimeRange(range.start,range.end,clip.beats);
}
export function copyMidiTime(clip,range){return copyNoteTime(clip,midiTimeRange(clip,range));}
function insert(notes,at,span){
 const output=[];
 for(const source of notes){const n=structuredClone(source),end=n.start+n.duration;
  if(n.start>=at)output.push({...n,start:n.start+span});
  else if(end>at){output.push({...n,duration:at-n.start},{...n,start:at+span,duration:end-at});}
  else output.push(n);
 }
 return output;
}
function remove(notes,start,end){
 const span=end-start,output=[];
 for(const source of notes){const n=structuredClone(source),tail=n.start+n.duration;
  if(tail<=start)output.push(n);
  else if(n.start>=end)output.push({...n,start:n.start-span});
  else {const left=Math.max(0,start-n.start),right=Math.max(0,tail-end);if(left+right>0)output.push({...n,start:n.start<start?n.start:start,duration:left+right});}
 }
 return output;
}
export function editMidiTime(clip,action,{range,at,clipboard}={}){
 let notes,start,end;
 if(action==='paste-time'){
  if(clip?.kind!=='midi'||!Number.isFinite(at)||at<0||at>clip.beats||!Number.isFinite(clipboard?.span)||clipboard.span<=0||clipboard.span>256||!Array.isArray(clipboard.notes)||at+clipboard.span>256)throw Error('Choose A MIDI Clipboard And Insert Beat Within The 256-Beat Source Limit.');
  start=at;end=at+clipboard.span;
  const added=structuredClone(clipboard.notes);
  for(const n of added){if(!Number.isFinite(n.start)||!Number.isFinite(n.duration)||n.start<0||n.duration<=0||n.start+n.duration>clipboard.span+1e-9)throw Error('The MIDI Time Clipboard Is Invalid.');n.start+=at;}
  notes=[...insert(clip.notes,at,clipboard.span),...added];
 }else{
  const r=midiTimeRange(clip,range);start=r.start;end=r.end;const span=end-start;
  if(action==='delete-time')notes=remove(clip.notes,start,end);
  else if(action==='insert-time')notes=insert(clip.notes,start,span);
  else if(action==='duplicate-time'){const copy=copyMidiTime(clip,r);notes=[...insert(clip.notes,end,span),...copy.notes.map(n=>({...n,start:n.start+end}))];start=end;end+=span;}
  else throw Error('Unknown MIDI Time Command.');
 }
 if(end>256)throw Error('The MIDI Time Edit Exceeds The 256-Beat Source Limit.');
 // Validate the full source before mutation. Time insertion never crops at the
 // playback loop; source-time/note-count overflow rejects the entire command.
 editNotes({...clip,notes},'transpose',{all:true,amount:0});
 const timeRange=action==='delete-time'?null:noteTimeRange(start,end,clip.beats);
 return {notes,selection:noteTimeIndices({...clip,notes},timeRange),timeRange,insertAt:Math.min(start,clip.beats)};
}
export function midiTimeKey(event){
 if(event.altKey||event.isComposing||!(event.ctrlKey||event.metaKey))return null;
 if(!event.shiftKey&&event.code==='KeyI')return 'insert-time';
 if(!event.shiftKey)return null;
 return {KeyX:'cut-time',KeyV:'paste-time',KeyD:'duplicate-time',Delete:'delete-time',Backspace:'delete-time'}[event.code]??null;
}
