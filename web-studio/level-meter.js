export const levelMeterMarkup='<div class="meter" role="meter" aria-label="Output Level" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60"><i></i></div>';
const decibels=value=>value>0?20*Math.log10(value):-Infinity;
export function channelLevels(channels){
 const levels=channels.map(samples=>{let square=0,peak=0;for(const sample of samples){if(!Number.isFinite(sample))continue;square+=sample*sample;peak=Math.max(peak,Math.abs(sample));}return {rms:samples.length?Math.sqrt(square/samples.length):0,peak};});
 const rms=Math.max(0,...levels.map(l=>l.rms)),peak=Math.max(0,...levels.map(l=>l.peak));
 return {channels:levels,rms,peak,db:decibels(rms),peakDb:decibels(peak),clipping:peak>=1};
}
// Parallel analysis taps; never route their outputs back into the audible graph.
export function createStereoMeter(context,source){
 const splitter=context.createChannelSplitter(2),analysers=[context.createAnalyser(),context.createAnalyser()],buffers=analysers.map(()=>new Float32Array(1024));let clippedUntil=-Infinity,disposed=false;
 source.connect(splitter);analysers.forEach((analyser,i)=>{analyser.fftSize=1024;splitter.connect(analyser,i);});
 return {read(){
  if(disposed)return channelLevels([]);
  analysers.forEach((analyser,i)=>analyser.getFloatTimeDomainData(buffers[i]));const levels=channelLevels(buffers);
  if(levels.clipping)clippedUntil=context.currentTime+.75;
  return {...levels,clipping:levels.clipping||context.currentTime<clippedUntil};
 },dispose(){if(disposed)return;disposed=true;try{source.disconnect(splitter);}catch{}splitter.disconnect();analysers.forEach(a=>a.disconnect());}};
}
export function paintLevelMeter(element,reading,label='Output'){
 if(!element)return;reading??=channelLevels([]);
 const value=Math.max(-60,Math.min(0,reading.db)),fill=(value+60)/60*100,bar=element.querySelector('i');
 if(bar){bar.style.height=fill+'%';bar.style.setProperty('--meter-fill',fill+'%');}
 element.classList.toggle('is-clipping',!!reading.clipping);
 const db=Number.isFinite(reading.peakDb)?reading.peakDb.toFixed(1):'-inf',text=`${label} · Sample Peak ${db} dBFS${reading.clipping?' · Full Scale Reached':''}`;
 element.setAttribute('aria-label',label+' Output Level');element.setAttribute('aria-valuenow',String(Number(value.toFixed(1))));element.setAttribute('aria-valuetext',text);element.title=text;
}
