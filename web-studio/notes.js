import {validReleaseVelocity,validNoteActivation,isNoteActive} from './note-state.js';
export function editNotes(clip,action,{index=0,patch={},all=false,amount=0,grid=.25,strength=1}={}){
  if(clip.kind!=='midi')throw new Error('Select a MIDI clip.');const notes=structuredClone(clip.notes),selected=notes[index];let selection=index;
  if(['update','delete','duplicate'].includes(action)&&!selected)throw new Error('Select a note first.');
  if(action==='update')Object.assign(selected,patch);
  else if(action==='add'){notes.push({pitch:60,start:0,duration:Math.min(.25,clip.beats),velocity:.75,...patch});selection=notes.length-1;}
  else if(action==='delete'){notes.splice(index,1);selection=Math.max(0,index-1);}
  else if(action==='duplicate'){const start=selected.start+selected.duration;if(start+selected.duration>clip.beats)throw new Error('There is no room after this note. Move or shorten it first.');notes.push({...selected,start});selection=notes.length-1;}
  else if(action==='transpose'){if(!Number.isInteger(amount))throw new Error('Transpose by a whole number of semitones.');notes.forEach((n,i)=>{if(all||i===index)n.pitch+=amount;});}
  else if(action==='quantize'){if(![.0625,.125,.25,.5,1,2,4].includes(grid)||!Number.isFinite(strength)||strength<0||strength>1)throw new Error('Choose a valid quantization grid and strength.');notes.forEach((n,i)=>{if(all||i===index){const target=Math.min(clip.beats-.0625,Math.round(n.start/grid)*grid);n.start+=(target-n.start)*strength;}});}
  else if(action!=='update')throw new Error('Unknown note edit.');
  if(notes.length>4096)throw new Error('A clip supports up to 4096 notes.');
  for(const n of notes)if(!validNoteActivation(n)||!validReleaseVelocity(n)||!Number.isInteger(n.pitch)||n.pitch<0||n.pitch>127||!Number.isFinite(n.start)||n.start<0||n.start>=clip.beats||!Number.isFinite(n.duration)||n.duration<=0||n.duration>256||!Number.isFinite(n.velocity)||n.velocity<0||n.velocity>1)throw new Error('Use MIDI pitch 0–127, a start inside the loop, a positive length up to 256 beats, and velocity 0–100%.');
  return {notes,selection};
}
export function dragNote(note,{deltaBeats=0,deltaPitch=0,resize=false,grid=.25,beats}){
  const snap=n=>Math.round(n/grid)*grid;
  if(resize)return {...note,duration:Math.max(.0625,Math.min(beats-note.start,note.duration+snap(deltaBeats)))};
  return {...note,start:Math.max(0,Math.min(beats-.0625,note.start+snap(deltaBeats))),pitch:Math.max(0,Math.min(127,note.pitch+deltaPitch))};
}

export function selectedNotes(clip,indices){
  const ids=[...new Set(indices)].sort((a,b)=>a-b);if(!ids.length)throw new Error('Select one or more notes.');
  if(ids.some(i=>!Number.isInteger(i)||i<0||i>=clip.notes.length))throw new Error('The note selection is no longer valid.');return ids;
}
export function copyNotes(clip,indices){const ids=selectedNotes(clip,indices),notes=ids.map(i=>structuredClone(clip.notes[i])),start=Math.min(...notes.map(n=>n.start));return {notes:notes.map(n=>({...n,start:n.start-start})),span:Math.max(...notes.map(n=>n.start+n.duration))-start};}
export function editNoteGroup(clip,action,{indices=[],clipboard=null,at=0,amount=0,grid=.25,strength=1,deltaBeats=0,deltaPitch=0,parts=2,factor=1}={}){
  const notes=structuredClone(clip.notes),ids=action==='paste'?[]:selectedNotes(clip,indices);let selection=[...ids];
  if(['activate','deactivate','toggle-active'].includes(action)){const active=action==='activate'||(action==='toggle-active'&&!ids.some(i=>isNoteActive(notes[i])));ids.forEach(i=>notes[i].active=active);
  }else if(action==='invert'){
    const low=Math.min(...ids.map(i=>notes[i].pitch)),high=Math.max(...ids.map(i=>notes[i].pitch));ids.forEach(i=>notes[i].pitch=low+high-notes[i].pitch);
  }else if(action==='reverse'||action==='stretch'){
    if(action==='stretch'&&(!Number.isFinite(factor)||factor<1/16||factor>16))throw new Error('Use a stretch amount between 6.25% and 1600%.');
    const start=Math.min(...ids.map(i=>notes[i].start)),end=Math.max(...ids.map(i=>notes[i].start+notes[i].duration));
    if(action==='reverse'&&end>clip.beats+1e-9)throw new Error('Shorten notes to fit inside the clip before reversing.');
    for(const i of ids){const n=notes[i];if(action==='reverse')n.start=start+(end-(n.start+n.duration));else{n.start=start+(n.start-start)*factor;n.duration*=factor;}if(n.start+n.duration>clip.beats+1e-9)throw new Error('The transformed phrase does not fit in this loop. Extend the clip or use a smaller stretch amount.');if(n.start+n.duration<=n.start||n.duration<1e-9)throw new Error('This note would be too short to transform precisely.');}
  }else if(action==='split'){
    if(!Number.isFinite(at)||at<=0||at>=clip.beats)throw new Error('Choose a split beat inside the clip.');
    const crossing=new Set(ids.filter(i=>notes[i].start<at&&notes[i].start+notes[i].duration>at));
    if(!crossing.size)throw new Error('No selected notes cross this beat.');
    if(notes.length+crossing.size>4096)throw new Error('Splitting these notes would exceed the 4096-note clip limit.');
    const selected=new Set(ids),result=[];selection=[];notes.forEach((n,i)=>{if(selected.has(i))selection.push(result.length);if(!crossing.has(i)){result.push(n);return;}const end=n.start+n.duration;result.push({...n,duration:at-n.start});selection.push(result.length);result.push({...n,start:at,duration:end-at});});notes.splice(0,notes.length,...result);
  }else if(action==='legato'){
    const starts=[...new Set(ids.map(i=>notes[i].start))].sort((a,b)=>a-b),ends=new Map(starts.map((start,i)=>[start,starts[i+1]??clip.beats]));
    ids.forEach(i=>notes[i].duration=ends.get(notes[i].start)-notes[i].start);
  }else if(action==='chop'){
    if(!Number.isInteger(parts)||parts<2||parts>32)throw new Error('Divide notes into 2–32 equal parts.');
    if(notes.length+ids.length*(parts-1)>4096)throw new Error('Dividing these notes would exceed the 4096-note clip limit.');
    const selected=new Set(ids),result=[];selection=[];
    notes.forEach((n,i)=>{if(!selected.has(i)){result.push(n);return;}if(n.start+n.duration>clip.beats+1e-9)throw new Error('Shorten notes to fit inside the clip before dividing them.');for(let part=0;part<parts;part++){const start=n.start+n.duration*part/parts,end=n.start+n.duration*(part+1)/parts;if(end<=start)throw new Error('This note is too short to divide precisely.');selection.push(result.length);result.push({...n,start,duration:end-start});}});notes.splice(0,notes.length,...result);
  }else if(action==='join'){
    const key=n=>`${n.pitch}:${isNoteActive(n)}`,selected=new Set(ids),groups=new Map();for(const i of ids){const group=groups.get(key(notes[i]))||[];group.push(i);groups.set(key(notes[i]),group);}if(![...groups.values()].some(g=>g.length>1))throw new Error('Select at least two notes sharing a pitch and activation state to join.');
    const result=[],done=new Set();selection=[];notes.forEach((n,i)=>{if(!selected.has(i)){result.push(n);return;}if(done.has(key(n)))return;done.add(key(n));const group=groups.get(key(n)),ordered=[...group].sort((a,b)=>notes[a].start-notes[b].start||a-b),first=notes[ordered[0]],end=Math.max(...group.map(j=>notes[j].start+notes[j].duration));selection.push(result.length);const last=notes[[...group].sort((a,b)=>(notes[b].start+notes[b].duration)-(notes[a].start+notes[a].duration)||b-a)[0]],joined={...first,duration:end-first.start};if(last.releaseVelocity===undefined)delete joined.releaseVelocity;else joined.releaseVelocity=last.releaseVelocity;result.push(joined);});notes.splice(0,notes.length,...result);
  }else if(action==='delete'){const remove=new Set(ids);const kept=notes.filter((n,i)=>!remove.has(i));notes.splice(0,notes.length,...kept);selection=[];}
  else if(action==='paste'||action==='duplicate'){
    if(action==='duplicate'){clipboard=copyNotes(clip,ids);at=Math.max(...ids.map(i=>notes[i].start+notes[i].duration));}
    if(!clipboard?.notes?.length||!Number.isFinite(at)||at<0)throw new Error('Copy notes first and choose a valid paste beat.');
    const added=structuredClone(clipboard.notes).map(n=>({...n,start:n.start+at}));if(added.some(n=>n.start+n.duration>clip.beats+1e-9))throw new Error('The phrase does not fit in this loop. Choose an earlier paste beat or extend the clip.');selection=added.map((n,i)=>notes.length+i);notes.push(...added);
  }else if(action==='velocity'){if(!Number.isFinite(amount))throw new Error('Use a finite velocity adjustment.');const low=Math.min(...ids.map(i=>notes[i].velocity)),high=Math.max(...ids.map(i=>notes[i].velocity)),delta=Math.max(-low,Math.min(1-high,amount));ids.forEach(i=>notes[i].velocity=Math.max(0,Math.min(1,notes[i].velocity+delta)));
  }else if(action==='transpose'){if(!Number.isInteger(amount))throw new Error('Use whole semitones.');ids.forEach(i=>notes[i].pitch+=amount);}
  else if(action==='quantize'){const subset={...clip,notes:ids.map(i=>notes[i])},result=editNotes(subset,'quantize',{all:true,grid,strength});ids.forEach((id,i)=>notes[id]=result.notes[i]);}
  else if(action==='move'){
    if(!Number.isFinite(deltaBeats)||!Number.isInteger(deltaPitch)||![.0625,.125,.25,.5,1].includes(grid))throw new Error('Invalid note movement.');
    const start=Math.min(...ids.map(i=>notes[i].start)),last=Math.max(...ids.map(i=>notes[i].start+notes[i].duration)),low=Math.min(...ids.map(i=>notes[i].pitch)),high=Math.max(...ids.map(i=>notes[i].pitch));
    const time=Math.max(-start,Math.min(Math.max(0,clip.beats-last),Math.round(deltaBeats/grid)*grid)),pitch=Math.max(-low,Math.min(127-high,deltaPitch));ids.forEach(i=>{notes[i].start+=time;notes[i].pitch+=pitch;});
  }else throw new Error('Unknown group edit.');
  editNotes({...clip,notes},'transpose',{all:true,amount:0});return {notes,selection};
}
export function notesInRange(clip,{start,end,low,high}){return clip.notes.flatMap((n,i)=>n.start<Math.max(start,end)&&n.start+n.duration>Math.min(start,end)&&n.pitch>=Math.min(low,high)&&n.pitch<=Math.max(low,high)?[i]:[]);}
