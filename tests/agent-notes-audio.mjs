import {Engine} from '/audio.js';
import {prepareAgentPlan} from '/agent-runner.js';
import {prepareMidiDelivery} from '/midi-delivery.js';
import parseMidi from '/vendor/midi-parser.js';
const assert=(ok,message)=>{if(!ok)throw new Error(message);},rate=48000;
const opts={sampleRate:rate,bitDepth:32,normalize:false,dither:'none',includeTail:false,source:'arrangement',channel:'track:lead'};
async function render(p,range){const e=new Engine(structuredClone(p),()=>{});try{const b=await e.render({...opts,...(range?{range}:{})}),v=new DataView(b);assert(v.getUint16(20,true)===3&&v.getUint32(24,true)===rate,'Float WAV settings');return Float32Array.from({length:v.getUint32(40,true)/8},(_,i)=>v.getFloat32(44+i*8,true));}finally{await e.context?.close();}}
function difference(a,b,label){assert(a.length===b.length,label+' length');let max=0;for(let i=0;i<a.length;i++){assert(Number.isFinite(a[i]),'Nonfinite audio');max=Math.max(max,Math.abs(a[i]-b[i]));}assert(max<2e-6,label+' error '+max);return max;}
function level(a,beat,frequency){const from=Math.round((beat*.5+.04)*rate),n=Math.round(.1*rate);let real=0,imag=0;for(let i=0;i<n;i++){const phase=2*Math.PI*frequency*i/rate;real+=a[from+i]*Math.cos(phase);imag+=a[from+i]*Math.sin(phase);}return Math.hypot(real,imag)*2/n;}
async function checks(){
 const p=await(await fetch('/qa-project.json')).json(),capture=await(await fetch('/qa-plan.json')).json(),source=JSON.stringify(p),actual=prepareAgentPlan(p,capture.plan.actions).next,expected=structuredClone(p),notes=expected.clips.phrase.notes;
 // Independent requested result; no edit helper is used to construct this oracle.
 Object.assign(notes[0],{start:0,pitch:72,velocity:.3});Object.assign(notes[2],{start:2,pitch:79,velocity:.6});notes.push({...notes[0],start:5},{...notes[2],start:7});
 assert(JSON.stringify(actual.clips.phrase.notes[1])===JSON.stringify(p.clips.phrase.notes[1]),'Inactive note changed');assert(JSON.stringify(actual.clips.phrase.notes[3])===JSON.stringify(p.clips.phrase.notes[3]),'Unchosen note changed');
 const a=await render(actual),b=await render(expected),old=await render(p),metrics={expectedMaxError:difference(a,b,'Independent requested notes'),saveReopenMaxError:difference(await render(JSON.parse(JSON.stringify(actual))),a,'Save/reopen'),rangeMaxError:difference(await render(actual,{start:5,length:3}),a.slice(rate*2.5),'Range')};
 const c5=440*2**((72-69)/12),g5=440*2**((79-69)/12);
 metrics.c5=level(a,0,c5);metrics.g5=level(a,2,g5);metrics.copiedC5=level(a,5,c5);metrics.copiedG5=level(a,7,g5);metrics.oldC4=level(a,0,c5/2);metrics.oldG4=level(a,2,g5/2);metrics.unchosenC5=level(a,3.1,c5);
 assert(metrics.c5>.003&&metrics.g5>.003&&metrics.copiedC5>.003&&metrics.copiedG5>.003,'Missing transposed/copied tones');assert(metrics.c5>metrics.oldC4*8&&metrics.g5>metrics.oldG4*8,'Original pitches survived');assert(level(old,.1,c5/2)>.003,'Silent baseline');assert(metrics.unchosenC5>.003,'Unchosen note missing');
 let silent=0;for(let i=Math.round(.6*rate);i<Math.round(.75*rate);i++)silent=Math.max(silent,Math.abs(a[i]));metrics.inactiveWindowPeak=silent;assert(silent<1e-6,'Inactive note became audible');
 const delivery=prepareMidiDelivery(actual,{source:'clip',clipId:'phrase'}),midi=parseMidi(delivery.data),ons=[],offs=[];let tick=0;for(const e of midi.tracks[0]){tick+=e.deltaTime;if(e.type==='noteOn'&&e.velocity>0)ons.push([tick,e.noteNumber,e.velocity]);if(e.type==='noteOff')offs.push(e.velocity);}
 assert(midi.header.ticksPerBeat===960,'PPQN');assert(JSON.stringify(ons)===JSON.stringify([[0,72,38],[1920,79,76],[2976,72,57],[4800,72,38],[6720,79,76]]),'SMF note events '+JSON.stringify(ons));assert(JSON.stringify(offs)===JSON.stringify([13,38,51,13,38]),'Release velocities');assert(JSON.stringify(p)===source,'Source mutated');
 return {status:'passed',sampleRate:rate,frames:a.length,sourceNotes:6,midiNotes:ons.length,metrics,scope:'Native Chromium OfflineAudioContext and actual SMF bytes. Independent requested-note oracle plus frequency/silence checks. No physical audio-output or perceptual quality claim.'};
}
document.querySelector('button').onclick=async event=>{event.target.disabled=true;try{document.querySelector('pre').textContent=JSON.stringify(await checks(),null,2);}catch(error){document.querySelector('pre').textContent=JSON.stringify({status:'failed',error:error.message,stack:error.stack},null,2);}finally{event.target.disabled=false;}};
