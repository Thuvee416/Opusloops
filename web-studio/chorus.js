import {feedbackTailSeconds} from './audio-tail.js';
import {autoPanCoefficients} from './auto-pan.js';
import {hasEnvelope} from './automation.js';
export function chorusTail(device,sampleRate=44100){const values=key=>[device.params[key],...(hasEnvelope(device.automation?.[key])?device.automation[key].points.map(p=>p.value):[])],peak=key=>Math.max(...values(key));if(peak('mix')<=0)return 0;const delay=(peak('delay')+peak('depth'))/1000,feedback=Math.max(...values('feedback').map(Math.abs));return feedbackTailSeconds(delay,feedback,sampleRate);}
export function chorusGraph(ctx,node,input,output,params,bind,automated=()=>false){
  const p={...params},dry=node(ctx.createGain()),wet=node(ctx.createGain()),split=node(ctx.createChannelSplitter(2)),merge=node(ctx.createChannelMerger(2)),delays=[],depths=[],oscillators=[],feedbacks=[];
  input.connect(dry);dry.connect(output);merge.connect(wet);dry.gain.value=1-p.mix;wet.gain.value=p.mix;
  let active=false;const activate=()=>{if(active)return;active=true;input.channelCount=2;input.channelCountMode='explicit';input.channelInterpretation='speakers';input.connect(split);wet.connect(output);};const deactivate=()=>{if(!active)return;active=false;input.disconnect(split);wet.disconnect(output);input.channelCountMode='max';};
  bind('mix',wet.gain);bind('mix',dry.gain,v=>1-v);
  const setPhase=()=>oscillators.forEach((osc,i)=>{const {real,imag}=autoPanCoefficients(0,i*p.phase);osc.setPeriodicWave(ctx.createPeriodicWave(real,imag));});
  for(let i=0;i<2;i++){const delay=node(ctx.createDelay(.1)),depth=node(ctx.createGain()),osc=node(ctx.createOscillator()),feedback=node(ctx.createGain());delay.delayTime.value=p.delay/1000;depth.gain.value=p.depth/1000;osc.frequency.value=p.rate;feedback.gain.value=p.feedback;split.connect(delay,i);delay.connect(merge,0,i);delay.connect(feedback);feedback.connect(delay);osc.connect(depth);depth.connect(delay.delayTime);delays.push(delay);depths.push(depth);oscillators.push(osc);feedbacks.push(feedback);bind('delay',delay.delayTime,v=>v/1000,'linear',v=>v*1000);bind('depth',depth.gain,v=>v/1000,'linear',v=>v*1000);bind('rate',osc.frequency);bind('feedback',feedback.gain);}
  setPhase();oscillators.forEach(osc=>osc.start(ctx.currentTime));if(p.mix||automated())activate();const update=(list,key,value)=>list.forEach(n=>n[key].setTargetAtTime(value,ctx.currentTime,.015));
  return {activate,controls:{mix:v=>{p.mix=v;if(v||automated())activate();else deactivate();dry.gain.setTargetAtTime(1-v,ctx.currentTime,.015);wet.gain.setTargetAtTime(v,ctx.currentTime,.015);},delay:v=>update(delays,'delayTime',v/1000),depth:v=>update(depths,'gain',v/1000),rate:v=>update(oscillators,'frequency',v),feedback:v=>update(feedbacks,'gain',v),phase:v=>{p.phase=v;setPhase();}}};
}
