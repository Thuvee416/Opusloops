import {editNotes} from './notes.js';
// A stroke owns a detached draft. The caller commits once on pointer-up or
// discards it on cancellation; no project or history changes while painting.
export function createNoteDrawStroke(clip,{grid=.25,rows}={}){
 if(clip.kind!=='midi'||![.0625,.125,.25,.5,1].includes(grid)||!Array.isArray(rows)||!rows.length||new Set(rows).size!==rows.length||rows.some(p=>!Number.isInteger(p)||p<0||p>127))throw new Error('Choose A MIDI Clip And A Valid Draw Grid.');
 const source=structuredClone(clip),visited=new Set(),removed=new Set(),added=[];
 editNotes(source,'transpose',{all:true,amount:0});
 let previous=null;
 const cell=(step,row)=>{
  const key=`${step}:${row}`;if(visited.has(key))return;
  if(visited.size>=65536)throw new Error('Finish This Draw Stroke Before Continuing.');
  visited.add(key);const start=step*grid,pitch=rows[row],duration=Math.min(grid,source.beats-start);
  const hits=source.notes.flatMap((n,i)=>n.pitch===pitch&&n.start<start+duration-1e-9&&n.start+n.duration>start+1e-9?[i]:[]);
  if(hits.length)hits.forEach(i=>removed.add(i));
  else added.push({pitch,start,duration,velocity:.7});
  if(source.notes.length-removed.size+added.length>4096)throw new Error('A Clip Supports Up To 4096 Notes.');
 };
 return {
  visit(beat,row){
   if(!Number.isFinite(beat)||!Number.isInteger(row)||row<0||row>=rows.length||beat<0||beat>=source.beats){previous=null;return;}
   const step=Math.floor(beat/grid),next={step,row};
   // Fill skipped grid columns even if the browser coalesces pointer events.
   if(previous){const distance=Math.max(Math.abs(step-previous.step),Math.abs(row-previous.row));for(let i=1;i<=distance;i++)cell(Math.round(previous.step+(step-previous.step)*i/distance),Math.round(previous.row+(row-previous.row)*i/distance));}
   cell(step,row);previous=next;
  },
  result(){const kept=source.notes.filter((_,i)=>!removed.has(i)),notes=[...kept,...added];return {notes:structuredClone(notes),selection:added.map((_,i)=>kept.length+i),removed:[...removed],added:structuredClone(added)};}
 };
}
