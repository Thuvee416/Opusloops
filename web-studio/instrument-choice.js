import {newSynth} from './instruments.js';
import {newSampler} from './sampler.js';
import {newDrumRack} from './drums.js';

// Manual selectors and Odesa choose the same actual instrument. Original tone
// is the legacy voice; it is not the Init poly-synth preset.
export function instrumentChoice(kind,preset){
 if(kind==='original'){
  if(preset!==undefined)throw new Error('Original tone does not use a poly-synth preset.');
  return undefined;
 }
 if(kind==='poly')return newSynth(preset);
 if(preset!==undefined)throw new Error('Synth presets require the Poly synth instrument.');
 if(kind==='sampler')return newSampler();
 if(kind==='drums')return newDrumRack();
 throw new Error('Choose Original tone, Poly synth, Sampler or Drum rack explicitly.');
}
