// Beat values use a quarter note as one beat. Triplets use 2/3 of the base grid.
export const QUANTIZE_GRIDS=[.03125,.0625,.125,.25,.5,1,2,4];
export function quantizeSettings({grid=.25,strength=1,gridMode='straight',target='starts'}={}){
 if(!QUANTIZE_GRIDS.includes(grid)||!Number.isFinite(strength)||strength<0||strength>1||!['straight','triplet','both'].includes(gridMode)||!['starts','ends','both'].includes(target))throw new Error('Choose a quantize grid from 1/128 to 1 note, Straight/Triplet/Both, Starts/Ends/Both and strength 0–100%.');
 return {grid,strength,gridMode,target};
}
export function quantizeGridLabel(grid){return '1/'+(4/grid);}
export function describeQuantization(q){return `${quantizeGridLabel(q.grid)} ${q.gridMode==='both'?'Straight + Triplet':q.gridMode==='triplet'?'Triplet':'Straight'} · ${q.target==='both'?'Starts & Ends':q.target==='ends'?'Note Ends':'Note Starts'} · ${Math.round(q.strength*100)}%${q.boundaryAdjusted?' · '+q.boundaryAdjusted+' Boundary Adjustment'+(q.boundaryAdjusted===1?'':'s'):''}`;}
function nearest(time,steps,min,max,strictMin=false,strictMax=false){
 const candidates=steps.map(step=>{const low=strictMin?Math.floor(min/step+1e-10)+1:Math.ceil(min/step-1e-10),high=strictMax?Math.ceil(max/step-1e-10)-1:Math.floor(max/step+1e-10);return Math.max(low,Math.min(high,Math.floor(time/step+.5+1e-10)))*step;});
 return candidates.sort((a,b)=>{const distance=Math.abs(a-time)-Math.abs(b-time);return Math.abs(distance)<1e-10?b-a:distance;})[0];
}
export function quantizeNote(note,beats,options={}){
 const settings=quantizeSettings(options),{grid,strength,gridMode,target}=settings;
 if(strength===0)return {note:{...note},boundaryAdjusted:false};
 const steps=gridMode==='both'?[grid,grid*2/3]:[gridMode==='triplet'?grid*2/3:grid];
 const unconstrained=time=>nearest(time,steps,0,Infinity),oldEnd=note.start+note.duration;
 let start=note.start,end=oldEnd,boundaryAdjusted=false;
 if(target!=='ends'){
  start=nearest(note.start,steps,0,beats,false,true);boundaryAdjusted=Math.abs(start-unconstrained(note.start))>1e-9;
 }
 if(target!=='starts'){
  end=nearest(oldEnd,steps,start,start+256,true);boundaryAdjusted||=Math.abs(end-unconstrained(oldEnd))>1e-9;
 }
 const movedStart=Math.abs(start-note.start)<1e-10?note.start:note.start+(start-note.start)*strength;
 // Starts-only quantization preserves duration exactly, including sustained notes.
 const movedEnd=oldEnd+(end-oldEnd)*strength;
 const duration=target==='starts'||Math.abs(movedEnd-movedStart-note.duration)<1e-10?note.duration:Math.min(256,movedEnd-movedStart);
 return {note:{...note,start:movedStart,duration},boundaryAdjusted};
}
