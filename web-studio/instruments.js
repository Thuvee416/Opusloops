import {ENSEMBLE_PARAMS,ensembleVoice} from './ensemble-voice.js';
import {isNoteActive} from './note-state.js';
import {envelopeAt} from './amp-envelope.js';
export {envelopeAt} from './amp-envelope.js';
import {validateDrums} from './drums.js';
import {validateSampler} from './sampler.js';
export const SYNTH_PARAMS={attack:[.001,2,.001,.008,'s'],decay:[.001,2,.001,.18,'s'],sustain:[0,1,.01,.65,''],release:[.005,4,.005,.25,'s'],cutoff:[20,20000,1,8000,'Hz'],resonance:[.1,15,.1,.7,'Q'],detune:[-100,100,1,0,'¢'],transpose:[-24,24,1,0,'st'],level:[0,1,.01,.23,''],...ENSEMBLE_PARAMS};
export const SYNTH_PRESETS={Init:{},'Warm bass':{wave:'sawtooth',cutoff:700,attack:.005,decay:.22,sustain:.35,release:.12},'Soft pad':{wave:'triangle',attack:.6,decay:.5,sustain:.8,release:1.5,cutoff:2800},'Bright pluck':{wave:'square',attack:.002,decay:.25,sustain:0,release:.08,cutoff:5000}};
Object.assign(SYNTH_PRESETS,{
 'Obsidian Bass':{wave:'sawtooth',attack:.004,decay:.18,sustain:.32,release:.09,cutoff:330,resonance:.9,sub:.35,filterEnv:2.4,filterDecay:.16,level:.32},
 'Velvet Chords':{wave:'sawtooth',attack:.018,decay:.6,sustain:.35,release:.65,cutoff:1100,resonance:.65,unison:3,spread:9,width:.8,filterEnv:1.7,filterDecay:.45,level:.18},
 'Prism Pluck':{wave:'sawtooth',attack:.002,decay:.24,sustain:.08,release:.18,cutoff:1200,resonance:1.2,unison:3,spread:7,width:.65,filterEnv:2.5,filterDecay:.22,level:.23},
 'Silver Arp':{wave:'square',attack:.003,decay:.12,sustain:.03,release:.09,cutoff:2100,resonance:.65,unison:2,spread:5,width:.55,filterEnv:1.8,filterDecay:.1,level:.12},
 'Horizon Pad':{wave:'sawtooth',attack:.7,decay:.8,sustain:.7,release:1.3,cutoff:1800,resonance:.5,unison:5,spread:15,width:1,level:.1},
 'Round Sub':{wave:'sine',attack:.006,decay:.18,sustain:.8,release:.09,cutoff:240,level:.42}
});
Object.assign(SYNTH_PRESETS,{
 'Analog Bass':{wave:'sawtooth',unison:2,spread:5,width:.1,sub:.3,color:.18,phaseSpread:.7,attack:.004,decay:.22,sustain:.28,release:.085,cutoff:260,resonance:.9,filterEnv:2.5,filterDecay:.18,level:.48},
 'Velvet Ensemble':{wave:'sawtooth',unison:5,spread:13,width:.9,color:.4,phaseSpread:.8,attack:.025,decay:.6,sustain:.22,release:.5,cutoff:1400,resonance:.65,filterEnv:1.5,filterDecay:.4,level:.3},
 'Glass Pluck':{wave:'sine',unison:2,spread:4,width:.65,fm:1.6,fmRatio:2,fmDecay:.13,attack:.003,decay:.32,sustain:.06,release:.2,cutoff:6500,resonance:.55,level:.34},
 'Prismatic Arp':{wave:'triangle',unison:3,spread:8,width:.8,color:.65,phaseSpread:.6,fm:.22,fmRatio:3,fmDecay:.08,attack:.003,decay:.17,sustain:.02,release:.1,cutoff:2100,resonance:.75,filterEnv:1.3,filterDecay:.11,level:.22},
 'Air Pad':{wave:'sawtooth',unison:5,spread:19,width:1,color:.7,phaseSpread:1,attack:.8,decay:1,sustain:.65,release:1.5,cutoff:2100,resonance:.5,level:.17}
});
export function newSynth(preset='Init'){if(!Object.hasOwn(SYNTH_PRESETS,preset))throw new Error('Unknown synth preset: '+String(preset).slice(0,60)+'. Choose exactly '+Object.keys(SYNTH_PRESETS).join(', ')+'. Set waveform with instrument params.wave; omit preset entirely for an empty audio bus.');return {type:'poly',wave:'sine',...Object.fromEntries(Object.entries(SYNTH_PARAMS).map(([k,v])=>[k,v[3]])),...SYNTH_PRESETS[preset]};}
export function validateInstrument(s){if(s===undefined)return;if(s?.type==='drums')return validateDrums(s);if(s?.type==='sampler')return validateSampler(s);if(!s||s.type!=='poly'||!['sine','triangle','sawtooth','square'].includes(s.wave))throw new Error('Invalid instrument.');for(const [k,[min,max]]of Object.entries(SYNTH_PARAMS))if(!(s[k]===undefined&&Object.hasOwn(ENSEMBLE_PARAMS,k))&&(!Number.isFinite(s[k])||s[k]<min||s[k]>max||(['transpose','unison'].includes(k)&&!Number.isInteger(s[k]))))throw new Error('Invalid synth '+k+'.');}
// This voice is shared by live input and clip rendering. Release starts at the current ADS level, including short notes.
export function synthVoice(ctx,target,s,pitch,velocity,start=ctx.currentTime,duration=null,elapsed=0){
 if((s.unison??1)>1||(s.sub??0)>0||(s.filterEnv??0)>0||(s.color??0)>0||(s.phaseSpread??0)>0||(s.fm??0)>0)return ensembleVoice(ctx,target,s,pitch,velocity,start,duration,elapsed);
 const osc=ctx.createOscillator(),filter=ctx.createBiquadFilter(),gain=ctx.createGain(),amplitude=velocity*s.level;osc.type=s.wave;osc.frequency.value=440*2**((pitch+s.transpose-69)/12);osc.detune.value=s.detune;filter.type='lowpass';filter.frequency.value=s.cutoff;filter.Q.value=s.resonance;osc.connect(filter);filter.connect(gain);gain.connect(target);const a=gain.gain;a.setValueAtTime(envelopeAt(s,elapsed)*amplitude,start);if(elapsed<s.attack)a.linearRampToValueAtTime(amplitude,start+s.attack-elapsed);if(elapsed<s.attack+s.decay)a.linearRampToValueAtTime(amplitude*s.sustain,start+s.attack+s.decay-elapsed);let releaseAt=Infinity;
 function release(time=ctx.currentTime,force=false){if(force&&time<start){a.cancelScheduledValues(time);a.setValueAtTime(0,time);osc.stop(Math.max(ctx.currentTime,time));releaseAt=Math.min(releaseAt,time);return;}time=Math.max(start,time);if(force){a.cancelAndHoldAtTime(time);a.linearRampToValueAtTime(0,time+.01);osc.stop(time+.015);releaseAt=Math.min(releaseAt,time);return;}if(time>=releaseAt)return;releaseAt=time;const value=envelopeAt(s,elapsed+time-start)*amplitude;a.cancelScheduledValues(time);a.linearRampToValueAtTime(value,time);a.linearRampToValueAtTime(0,time+s.release);osc.stop(time+s.release+.005);}
 osc.onended=()=>{osc.disconnect();filter.disconnect();gain.disconnect();};osc.start(start);if(duration!==null)release(start+duration);return {osc,gain,release};
}
export async function renderSynth(clip,bpm,s,sampleRate=44100){validateInstrument(s);const ctx=new OfflineAudioContext(2,Math.ceil(clip.beats*60/bpm*sampleRate),sampleRate);for(const n of clip.notes)if(isNoteActive(n))synthVoice(ctx,ctx.destination,s,n.pitch,n.velocity,n.start*60/bpm,n.duration*60/bpm);return ctx.startRendering();}
