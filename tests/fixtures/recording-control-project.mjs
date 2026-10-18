import {recordProject} from './record-quantization-project.mjs';
import {DEFAULT_RECORD_QUANTIZATION} from '../../web-studio/record-quantization.js';
export const controlProject=recordProject;
export function controlState(p,{active=false,audioConnected=false,countInBars=0,source='midi'}={}){return {active,captureId:active?'operator-take':null,phase:active?'recording':'idle',source,trackId:p.tracks[0].id,countInBars,audioConnected,playing:false,recordQuantization:{...DEFAULT_RECORD_QUANTIZATION},takeQuantization:active?{...DEFAULT_RECORD_QUANTIZATION}:null};}
export function controlCases(p){return [
 {id:'start-midi',prompt:'Start a new MIDI input take on Lead with a one-bar count-in. I will play the notes myself. Keep existing project contents unchanged. Do not play clips, export or create notes.',state:controlState(p),expected:{action:'start',source:'midi',trackId:'lead',countInBars:1}},
 {id:'start-audio',prompt:'Start a new audio input take on Lead now with no count-in, using the already connected audio input. Preserve the existing project. Do not export or play clips.',state:controlState(p,{source:'audio',audioConnected:true}),expected:{action:'start',source:'audio',trackId:'lead',countInBars:0}},
 {id:'finish',prompt:'Wrap up the active input take and save what I performed into its Session slot. Do nothing else.',state:controlState(p,{active:true}),expected:{action:'finish'}},
 {id:'cancel',prompt:'Discard my current input performance without creating a clip. Do nothing else.',state:controlState(p,{active:true}),expected:{action:'cancel'}}
];}
