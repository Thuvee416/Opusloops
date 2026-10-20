import {validateProject} from './model.js';
import {clipPropertyIds} from './clip-properties.js';

export function midiCropIntent(project,intent){
 if(!intent||typeof intent!=='object'||Array.isArray(intent)||Object.keys(intent).some(k=>!['ids','start','length'].includes(k)))throw Error('MIDI Crop Accepts ids And Optional start/length Only.');
 const ids=clipPropertyIds(project,intent.ids);
 if(ids.some(id=>project.clips[id].kind!=='midi'))throw Error('Crop Requires MIDI Clip Sources Only. Audio And Generated Drum Clips Are Unchanged.');
 const ranged=Object.hasOwn(intent,'start')||Object.hasOwn(intent,'length');
 if(ranged&&(ids.length!==1||!Number.isFinite(intent.start)||!Number.isFinite(intent.length)||intent.start<0||intent.length<.25||intent.start+intent.length>project.clips[ids[0]].beats))throw Error('Crop To Time Selection Requires One MIDI Clip And A Range Of At Least A Quarter Beat Inside Its Loop.');
 return {ids,...(ranged?{start:intent.start,length:intent.length}:{})};
}
export function cropMidiSources(project,intent){
 const spec=midiCropIntent(project,intent),next=structuredClone(project),observations=[];
 for(const id of spec.ids){
  const clip=next.clips[id],before=clip.notes,start=spec.start??0,length=spec.length??clip.beats,end=start+length;
  clip.notes=before.flatMap(note=>{const onset=Math.max(start,note.start),off=Math.min(end,note.start+note.duration);return off>onset?[{...note,start:onset-start,duration:onset===note.start&&off===note.start+note.duration?note.duration:off-onset}]:[];});
  clip.beats=length;
  observations.push({type:'midi_notes',clipId:id,clipName:clip.name,action:'crop',selectedCount:before.length,beforeCount:before.length,afterCount:clip.notes.length,resultSelection:clip.notes.map((_,i)=>i),timeRange:null,insertAt:0,changed:JSON.stringify(project.clips[id])!==JSON.stringify(clip)});
 }
 validateProject(next);
 return {project:next,changed:JSON.stringify(next)!==JSON.stringify(project),observations,ids:spec.ids};
}
