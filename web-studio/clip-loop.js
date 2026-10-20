import {AUDIO_MAX_BEATS,validateProject} from './model.js';
import {validateAudioEdit} from './audio-edit.js';
import {validateRegionFades} from './region-fades.js';
// Validate the source and every shared placement before installing a loop edit.
export function prepareClipLoop(project,clipId,beats){
 const clip=project.clips[clipId];if(!clip)throw Error('Choose An Existing Clip.');
 const maximum=clip.kind==='audio'?AUDIO_MAX_BEATS:256;
 if(!Number.isFinite(beats)||beats<.25||beats>maximum)throw Error(`Loop Length Must Be Between 0.25 And ${maximum} Beats.`);
 if(beats===clip.beats)return clip;
 const next={...clip,beats};
 if(clip.kind==='audio'){
  validateAudioEdit(clip.audioEdit,beats);next.sourceBpm=clip.sourceBpm*beats/clip.beats;
  if(next.sourceBpm<40||next.sourceBpm>240)throw Error('Choose A Loop Length With Source Tempo Between 40 And 240 BPM.');
 }
 if(clip.kind==='midi')next.notes=clip.notes.filter(note=>note.start<beats);
 for(const region of project.arrangement)if(region.clipId===clipId)try{validateRegionFades(region,next);}catch(error){throw Error(`Loop Length Conflicts With Arrangement Fades At Beat ${region.start+1}. Adjust Those Fades First.`,{cause:error});}
 validateProject({...project,clips:{...project.clips,[clipId]:next}});
 return next;
}
