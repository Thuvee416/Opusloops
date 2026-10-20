import {editNotes,editNoteGroup,copyNotes,selectedNotes} from './notes.js';
import {isNoteActive} from './note-state.js';

export const NOTE_SELECTORS=['indices','all','where'];
export function midiClip(project,id){
 const clip=typeof id==='string'&&Object.hasOwn(project.clips,id)?project.clips[id]:null;
 if(clip?.kind!=='midi')throw new Error('Choose an existing MIDI clipId, never a track/region ID or display name. Available MIDI clips: '+JSON.stringify(Object.values(project.clips).filter(c=>c.kind==='midi').map(c=>({clipId:c.id,name:c.name,noteCount:c.notes.length}))));
 return clip;
}
export function noteIndices(clip,args,{allowEmpty=false}={}){
 const chosen=NOTE_SELECTORS.filter(k=>Object.hasOwn(args,k));
 if(chosen.length!==1)throw new Error('Choose exactly one note selector: all:true, indices:[zero-based note indices], or where:{start?,end?,pitchMin?,pitchMax?,active?}.');
 let indices;
 if(chosen[0]==='all'){
  if(args.all!==true)throw new Error('Use all:true to choose every note.');indices=clip.notes.map((_,i)=>i);
 }else if(chosen[0]==='indices'){
  if(!Array.isArray(args.indices)||args.indices.length>4096||new Set(args.indices).size!==args.indices.length)throw new Error('Use distinct zero-based note indices, up to 4096.');
  if(args.indices.some(i=>!Number.isInteger(i)||i<0||i>=clip.notes.length))throw new Error('Use current zero-based note array indices 0 through '+(clip.notes.length-1)+' for '+clip.name+' ('+clip.notes.length+' notes), never note pitches or displayed beat numbers.');
  indices=args.indices.length?selectedNotes(clip,args.indices):[];
 }else{
  const w=args.where;
  if(!w||typeof w!=='object'||Array.isArray(w)||!Object.keys(w).length||Object.keys(w).some(k=>!['start','end','pitchMin','pitchMax','active'].includes(k)))throw new Error('Note filters accept start/end (zero-based onset beats, end exclusive), pitchMin/pitchMax (inclusive MIDI pitches) and active only.');
  if(Object.values(w).some(v=>v===null||v===undefined))throw new Error('Omit unused note filters rather than passing null.');
  const start=w.start??0,end=w.end??clip.beats,low=w.pitchMin??0,high=w.pitchMax??127;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>clip.beats||start>=end||!Number.isInteger(low)||!Number.isInteger(high)||low<0||high>127||low>high||w.active!==undefined&&typeof w.active!=='boolean')throw new Error('Use an onset range inside the clip, inclusive integer pitches 0–127 and an optional boolean active filter.');
  indices=clip.notes.flatMap((n,i)=>n.start>=start&&n.start<end&&n.pitch>=low&&n.pitch<=high&&(w.active===undefined||isNoteActive(n)===w.active)?[i]:[]);
 }
 if(!allowEmpty&&!indices.length)throw new Error('No notes match this selection. No notes were edited.');
 return indices;
}
const parameters={add:['notes'],update:['patch'],transpose:['amount'],velocity:['amount'],quantize:['grid','strength','gridMode','target'],move:['deltaBeats','deltaPitch','grid'],stretch:['factor'],split:['at'],chop:['parts'],duplicate:['at'],reverse:[],invert:[],legato:[],join:[],delete:[],activate:[],deactivate:[],'toggle-active':[]};
const patchKeys=['pitch','start','duration','velocity','active','releaseVelocity'];
function validatePatch(patch){if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(k=>!patchKeys.includes(k)))throw new Error('Note patches accept pitch, start, duration, velocity, active and releaseVelocity only.');}
// Shape validation is also safe on the server’s bounded read-only preview.
// Bounds and musical edits still require the full local source clip.
export function validateNoteActionShape(args){
 if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Expected MIDI Note Action Arguments.');
 const {clipId,action,...options}=args,fields=Object.hasOwn(parameters,action)?parameters[action]:null;
 if(!fields||Object.keys(options).some(k=>!fields.includes(k)&&!(action!=='add'&&NOTE_SELECTORS.includes(k))))throw new Error('Unsupported MIDI note action or argument. Read the notes capability contract.');
 if(action!=='add'&&NOTE_SELECTORS.filter(k=>Object.hasOwn(options,k)).length!==1)throw new Error('Choose exactly one note selector: all:true, indices:[zero-based note indices], or where:{start?,end?,pitchMin?,pitchMax?,active?}.');
 if(Object.hasOwn(options,'all')&&options.all!==true)throw new Error('Use all:true to choose every note.');
 return {action,options};
}
// Edits operate on the full local clip, never on the model's truncated preview.
export function editMidiNotes(clip,args){
 if(clip?.kind!=='midi')throw new Error('Select a MIDI clip.');
 const {action,options}=validateNoteActionShape(args);
 const indices=action==='add'?[]:noteIndices(clip,options),before=clip.notes;
 for(const key of ({transpose:['amount'],velocity:['amount'],quantize:['grid'],stretch:['factor'],split:['at'],chop:['parts']}[action]||[]))if(!Object.hasOwn(options,key))throw new Error('MIDI '+action+' requires '+key+'.');
 if(action==='move'&&options.deltaBeats===undefined&&options.deltaPitch===undefined)throw new Error('MIDI move needs deltaBeats or deltaPitch.');
 let result;
 if(action==='add'){
  if(!Array.isArray(options.notes)||!options.notes.length||options.notes.length+before.length>4096)throw new Error('Add 1–4096 explicit notes within the clip limit.');
  for(const n of options.notes){validatePatch(n);if(n.start>=clip.beats)throw Error('New Notes Must Start Inside The Loop. Extend The Loop First.');if(['pitch','start','duration','velocity'].some(k=>!Object.hasOwn(n,k)))throw new Error('Every added note needs pitch, start, duration and normalized velocity.');}
  const notes=[...structuredClone(before),...structuredClone(options.notes)];editNotes({...clip,notes},'transpose',{all:true,amount:0});result={notes,selection:options.notes.map((_,i)=>before.length+i)};
 }else if(action==='update'){
  validatePatch(options.patch);if(options.patch.start>=clip.beats)throw Error('Choose A Note Start Inside The Loop. Extend The Loop First.');const notes=structuredClone(before);for(const i of indices)Object.assign(notes[i],options.patch);editNotes({...clip,notes},'transpose',{all:true,amount:0});result={notes,selection:indices};
 }else if(action==='duplicate'&&options.at!==undefined){
  result=editNoteGroup(clip,'paste',{clipboard:copyNotes(clip,indices),at:options.at});
 }else result=editNoteGroup(clip,action,{...options,indices});
 const changed=JSON.stringify(before)!==JSON.stringify(result.notes),observation={type:'midi_notes',clipId:clip.id,clipName:clip.name,action,selectedCount:indices.length,beforeCount:before.length,afterCount:result.notes.length,resultSelection:result.selection,changed};
 if(result.quantization)observation.quantization=result.quantization;
 if(['velocity','move'].includes(action)){
  const i=indices[0],next=result.notes[i],original=before[i];
  if(action==='velocity'){observation.requestedAmount=options.amount;observation.appliedAmount=next.velocity-original.velocity;observation.clamped=Math.abs(observation.appliedAmount-options.amount)>1e-9;}
  else{observation.requestedDeltaBeats=options.deltaBeats??0;observation.appliedDeltaBeats=next.start-original.start;observation.requestedDeltaPitch=options.deltaPitch??0;observation.appliedDeltaPitch=next.pitch-original.pitch;observation.clamped=Math.abs(observation.appliedDeltaBeats-observation.requestedDeltaBeats)>1e-9||observation.appliedDeltaPitch!==observation.requestedDeltaPitch;}
 }
 return {...result,observation};
}
