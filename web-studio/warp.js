import {validateWarpMarkers,warpSegments} from './warp-markers.js';
export const WARP_PCM_LIMIT=64*1024*1024;
export const defaultWarp=()=>({mode:'repitch',semitones:0});
export const formantSettings=w=>({formantSemitones:w?.formantSemitones??0,formantCompensation:w?.formantCompensation??false,formantBaseHz:w?.formantBaseHz??0});
export function validateWarp(w){if(w===undefined)return;if(!w||!['repitch','stretch'].includes(w.mode)||!Number.isFinite(w.semitones)||w.semitones<-24||w.semitones>24)throw new Error('Choose Repitch or Stretch, with pitch between −24 and +24 semitones.');for(const key of ['formantSemitones','formantBaseHz'])if(w[key]!==undefined&&(!Number.isFinite(w[key])||w[key]<(key==='formantSemitones'?-24:0)||w[key]>(key==='formantSemitones'?24:2000)))throw new Error('Formant shift must be −24 to +24 semitones; analysis pitch must be 0 to 2000 Hz.');if(w.formantCompensation!==undefined&&typeof w.formantCompensation!=='boolean')throw new Error('Formant preservation must be on or off.');validateWarpMarkers(w.markers);}
export function stretchPlan(raw,rate){
 if(!Number.isFinite(rate)||rate<1/6-1e-9||rate>6+1e-9||!Number.isInteger(raw.length)||raw.length<1||![1,2].includes(raw.numberOfChannels))throw new Error('Stretch supports mono/stereo audio and tempo ratios from 1/6 to 6.');
 const frames=Math.max(1,Math.round(raw.length/rate));if((frames+raw.length)*raw.numberOfChannels*4>WARP_PCM_LIMIT)throw new Error('Stretch source and output must fit within 64 MB of decoded audio. Shorten the clip or increase tempo.');
 return {frames,channels:raw.numberOfChannels,sampleRate:raw.sampleRate};
}
function timeout(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]).finally(()=>clearTimeout(timer));}
let stretchModule;
async function loadStretch(){
 if(!stretchModule)stretchModule=(async()=>{
  const url=new URL('./vendor/signalsmith-stretch/SignalsmithStretch.js',import.meta.url);
  const {default:Stretch}=await import(url.href);
  // Fetch in the page so private hosting authentication applies. One local URL
  // is shared by all offline contexts and released with the document.
  const response=await fetch(url,{credentials:'same-origin',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('The stretch module could not load (HTTP '+response.status+').');
  Stretch.moduleUrl=URL.createObjectURL(new Blob([await response.text()],{type:'text/javascript'}));
  return Stretch;
 })().catch(error=>{stretchModule=undefined;throw error;});
 return stretchModule;
}
export async function stretchAudio(raw,rate,semitones=0,formants={}){
 validateWarp({...formants,mode:'stretch',semitones});const settings=formantSettings(formants),plan=stretchPlan(raw,rate),segments=warpSegments(formants.markers,rate);
 if(rate===1&&semitones===0&&settings.formantSemitones===0&&!(formants.markers??[]).some(m=>m.source!==m.target))return raw;
 const Stretch=await loadStretch();
 // A half-second pre-roll lets the worklet compensate its analysis latency.
 // It is discarded; musical positions remain in the original clip beat domain.
 const mono=plan.channels===2&&raw.getChannelData(0).every((v,i)=>v===raw.getChannelData(1)[i]),dspChannels=mono?1:plan.channels;
 const pad=Math.ceil(plan.sampleRate*.5),ctx=new OfflineAudioContext(dspChannels,plan.frames+pad,plan.sampleRate);
 if(!ctx.audioWorklet)throw new Error('This browser cannot prepare stretched audio. Use Repitch mode.');
 let node,disposed=false;
 try{
  const ready=Stretch(ctx,{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[dspChannels]});
  ready.then(n=>{if(disposed){n.disconnect();n.port.close();}},()=>{});
  node=await timeout(ready,15000,'The stretch engine did not initialize. Use Repitch or reload.');
  const channels=Array.from({length:dspChannels},(_,c)=>raw.getChannelData(c).slice());
  await timeout(node.addBuffers(channels,channels.map(a=>a.buffer)),15000,'Stretch sample loading timed out.');
  // The pinned wrapper uses outputTime to retain prior scheduled segments.
  // Supply both keys: outputTime controls insertion and output controls mapping.
  // Replace the initial inactive segment so analysis can run during preroll.
  for(const segment of segments){const output=(pad+plan.frames*segment.target)/plan.sampleRate;await timeout(node.schedule({active:true,input:raw.length/raw.sampleRate*segment.source,output,outputTime:segment.source===0?0:output,rate:segment.rate,semitones,...settings}),15000,'Stretch scheduling timed out.');}
  node.connect(ctx.destination);const rendered=await timeout(ctx.startRendering(),60000,'Stretch preparation timed out. Shorten the clip.');
  const output=new AudioBuffer({numberOfChannels:plan.channels,length:plan.frames,sampleRate:plan.sampleRate});
  for(let c=0;c<plan.channels;c++){const data=rendered.getChannelData(mono?0:c).subarray(pad,pad+plan.frames);if(data.some(v=>!Number.isFinite(v)))throw new Error('Stretch produced invalid audio.');output.copyToChannel(data,c);}
  return output;
 }finally{disposed=true;node?.disconnect();node?.port.close();}
}
