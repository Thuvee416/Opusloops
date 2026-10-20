import {envelopeAt} from './amp-envelope.js';
// Optional controls preserve the original single-oscillator sound of saved sets.
export const ENSEMBLE_PARAMS={unison:[1,5,1,1,''],spread:[0,40,1,0,'¢'],width:[0,1,.01,0,''],sub:[0,1,.01,0,''],filterEnv:[0,4,.1,0,'oct'],filterDecay:[.01,2,.01,.25,'s']};
export function ensembleVoice(ctx,target,s,pitch,velocity,start,duration,elapsed){
 const nodes=[],oscillators=[],stops=[];const node=n=>(nodes.push(n),n),base=440*2**((pitch+s.transpose-69)/12),count=s.unison??1;
 const gain=node(ctx.createGain()),amplitude=velocity*s.level,a=gain.gain;let releaseAt=Infinity;
 const dispose=()=>{for(const n of nodes)try{n.disconnect();}catch{}};
 const stop=time=>{for(const fn of stops)try{fn(time);}catch{}};
 try{
  gain.connect(target);
  for(let i=0;i<count+(s.sub>0?1:0);i++){
   const sub=i===count,position=count===1?0:(i/(count-1)*2-1),osc=node(ctx.createOscillator()),filter=node(ctx.createBiquadFilter()),pan=node(ctx.createStereoPanner()),level=node(ctx.createGain());
   oscillators.push(osc);stops.push(osc.stop.bind(osc));osc.type=sub?'sine':s.wave;osc.frequency.value=base*(sub?.5:1);osc.detune.value=s.detune+(sub?0:position*(s.spread??0));
   pan.pan.value=sub?0:position*(s.width??0);level.gain.value=sub?s.sub:1/count;
   filter.type='lowpass';filter.Q.value=sub?.7:s.resonance;
   const cutoff=Math.min(s.cutoff,ctx.sampleRate*.45),peak=Math.min(cutoff*2**(sub?0:s.filterEnv??0),ctx.sampleRate*.45),decay=s.filterDecay??.25;
   filter.frequency.setValueAtTime(peak*(cutoff/peak)**Math.min(1,elapsed/decay),start);
   if(elapsed<decay)filter.frequency.exponentialRampToValueAtTime(cutoff,start+decay-elapsed);
   osc.connect(filter);filter.connect(pan);pan.connect(level);level.connect(gain);
  }
  a.setValueAtTime(envelopeAt(s,elapsed)*amplitude,start);
  if(elapsed<s.attack)a.linearRampToValueAtTime(amplitude,start+s.attack-elapsed);
  if(elapsed<s.attack+s.decay)a.linearRampToValueAtTime(amplitude*s.sustain,start+s.attack+s.decay-elapsed);
  const osc=oscillators[0];osc.stop=stop;osc.onended=dispose;
  for(const o of oscillators)o.start(start);
  function release(time=ctx.currentTime,force=false){
   if(force&&time<start){a.cancelScheduledValues(time);a.setValueAtTime(0,time);stop(Math.max(ctx.currentTime,time));releaseAt=Math.min(releaseAt,time);return;}
   time=Math.max(start,time);
   if(force){a.cancelAndHoldAtTime(time);a.linearRampToValueAtTime(0,time+.01);stop(time+.015);releaseAt=Math.min(releaseAt,time);return;}
   if(time>=releaseAt)return;releaseAt=time;const value=envelopeAt(s,elapsed+time-start)*amplitude;
   a.cancelScheduledValues(time);a.linearRampToValueAtTime(value,time);a.linearRampToValueAtTime(0,time+s.release);stop(time+s.release+.005);
  }
  if(duration!==null)release(start+duration);return {osc,gain,release};
 }catch(error){stop(ctx.currentTime);dispose();throw error;}
}
