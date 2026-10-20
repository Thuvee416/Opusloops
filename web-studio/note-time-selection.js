import {editNotes,notesInRange} from './notes.js';
import {noteInsertKey} from './note-insert.js';

// A time selection is editor state, not part of the saved MIDI source.
export function noteTimeRange(anchor,focus,beats,low=0,high=127){
 if(![anchor,focus,beats].every(Number.isFinite)||beats<=0||![low,high].every(Number.isInteger)||low<0||high>127||low>high)throw Error('Choose A Valid MIDI Time Range.');
 anchor=Math.max(0,Math.min(beats,anchor));focus=Math.max(0,Math.min(beats,focus));
 return anchor===focus?null:{start:Math.min(anchor,focus),end:Math.max(anchor,focus),anchor,focus,low,high};
}
export function noteTimeIndices(clip,range){return range?notesInRange(clip,range):[];}
export function noteTimeKey(event,{range,at,beats,grid,notes}){
 if(!event.shiftKey||event.metaKey||event.isComposing||!['ArrowLeft','ArrowRight'].includes(event.key))return null;
 const anchor=range?.anchor??at,focus=range?.focus??at;
 const next=noteInsertKey({key:event.key,ctrlKey:event.ctrlKey,altKey:event.altKey},{at:focus,beats,grid,notes});
 return {at:next,range:noteTimeRange(anchor,next,beats,range?.low??0,range?.high??127)};
}
function checkedRange(clip,range){
 if(clip?.kind!=='midi'||!range||range.start<0||range.end>clip.beats||range.end<=range.start)throw Error('Select A Time Range Inside This MIDI Clip.');
 return noteTimeRange(range.start,range.end,clip.beats,range.low,range.high);
}
export function copyNoteTime(clip,range){
 range=checkedRange(clip,range);
 const notes=noteTimeIndices(clip,range).map(i=>{const n=clip.notes[i],start=Math.max(n.start,range.start),end=Math.min(n.start+n.duration,range.end);return {...structuredClone(n),start:start-range.start,duration:end-start};});
 return {kind:'midi-time',span:range.end-range.start,low:range.low,high:range.high,notes};
}
function outside(clip,range){
 const notes=[];
 for(const note of clip.notes){
  const n=structuredClone(note),end=n.start+n.duration;
  if(n.pitch<range.low||n.pitch>range.high||n.start>=range.end||end<=range.start){notes.push(n);continue;}
  if(n.start<range.start)notes.push({...n,duration:range.start-n.start});
  if(end>range.end&&range.end<clip.beats)notes.push({...n,start:range.end,duration:end-range.end});
 }
 return notes;
}
function result(clip,notes,timeRange){
 editNotes({...clip,notes},'transpose',{all:true,amount:0});
 return {notes,selection:noteTimeIndices({...clip,notes},timeRange),timeRange};
}
export function editNoteTime(clip,action,{range,clipboard,at}={}){
 if(action==='delete'){range=checkedRange(clip,range);return result(clip,outside(clip,range),range);}
 if(action==='split'){
  range=checkedRange(clip,range);const notes=[];
  for(const n of clip.notes){
   const edges=n.pitch>=range.low&&n.pitch<=range.high?[range.start,range.end].filter(b=>b>n.start&&b<clip.beats&&b<n.start+n.duration):[];
   let start=n.start;for(const end of [...edges,n.start+n.duration]){notes.push({...structuredClone(n),start,duration:end-start});start=end;}
  }
  return result(clip,notes,range);
 }
 if(action==='duplicate'){range=checkedRange(clip,range);clipboard=copyNoteTime(clip,range);at=range.end;}
 else if(action!=='paste')throw Error('Unknown MIDI Time Edit.');
 if(clipboard?.kind!=='midi-time'||!Array.isArray(clipboard.notes)||!Number.isFinite(clipboard.span)||clipboard.span<=0||!Number.isFinite(at)||at<0||at+clipboard.span>clip.beats+1e-9)throw Error('The Selected Time Span Does Not Fit In This Clip. Choose An Earlier Insert Beat Or Extend The Clip.');
 const destination=noteTimeRange(at,Math.min(clip.beats,at+clipboard.span),clip.beats,clipboard.low,clipboard.high);
 // Ordinary paste/duplicate overlays the selected pitches, including silence.
 // It does not insert/delete timeline duration or change the clip loop length.
 const notes=outside(clip,destination),added=structuredClone(clipboard.notes);
 for(const n of added){if(n.start<0||n.start+n.duration>clipboard.span+1e-9||n.pitch<destination.low||n.pitch>destination.high)throw Error('The MIDI Time Clipboard Is Invalid.');n.start+=at;}
 return result(clip,[...notes,...added],destination);
}
