import {setSlotStops} from './slot-metadata.js';
import {validateProject} from './model.js';
import {sessionSlots} from './session-batch.js';

// Stop buttons belong to empty placements, not to source clips or the transport.
export function editSessionStops(project,intent){
 if(!intent||typeof intent!=='object'||Array.isArray(intent)||Object.keys(intent).some(k=>!['slots','enabled'].includes(k))||typeof intent.enabled!=='boolean')throw Error('Session Stop Buttons Require Exact slots And enabled True Or False.');
 const slots=sessionSlots(project,intent.slots);
 if(slots.some(s=>s.clipId))throw Error('Choose Empty Session Slots. Stop Button Changes Never Remove Clips.');
 const next=structuredClone(project);
 for(const slot of slots){
  setSlotStops(next.tracks.find(t=>t.id===slot.trackId),slot.scene,intent.enabled);
 }
 validateProject(next);
 return {project:next,changed:JSON.stringify(next)!==JSON.stringify(project),observation:{type:'session_stops',enabled:intent.enabled,slots,count:slots.length}};
}
