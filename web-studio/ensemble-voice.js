import {envelopeAt} from './amp-envelope.js';
// Optional controls preserve the original single-oscillator sound of saved sets.
export const ENSEMBLE_PARAMS={unison:[1,5,1,1,''],spread:[0,40,1,0,'¢'],width:[0,1,.01,0,''],sub:[0,1,.01,0,''],filterEnv:[0,4,.1,0,'oct'],filterDecay:[.01,2,.01,.25,'s'],color:[0,1,.01,0,''],phaseSpread:[0,1,.01,0,''],fm:[0,3,.01,0,''],fmRatio:[.5,8,.5,2,'×'],fmDecay:[.01,2,.01,.18,'s']};
export function ensembleVoice(ctx,target,s,pitch,velocity,start,duration,elapsed){
 const nodes=[],oscillators=[],stops=[];const node=n=>(nodes.push(n),n),base=440*2**((pitch+s.transpose-69)/12),count=s.unison??1;
 const gain=node(ctx.createGain()),amplitude=velocity*s.level,a=gain.gain;let releaseAt=Infinity;
 const dispose=()=>{for(const n of nodes)try{n.disconnect();}catch{}};
 const stop=time=>{for(const fn of stops)try{fn(time);}catch{}};
 try{
  gain.connect(target);
  for(let i=0;i<count+(s.sub>0?1:0);i++){
   const sub=i===count,position=count===1?0:(i/(count-1)*2-1),osc=node(ctx.createOscillator()),filter=node(ctx.createBiquadFilter()),pan=node(ctx.createStereoPanner()),level=node(ctx.createGain());
   oscillators.push(osc);stops.push(osc.stop.bind(osc));osc.type=sub?'sine':s.wave;
   if(!sub&&((s.color??0)>0||(s.phaseSpread??0)>0))osc.setPeriodicWave(coloredWave(ctx,s.wave,s.color??0,(i/(count||1))*(s.phaseSpread??0)));
   if(!sub&&(s.fm??0)>0){const mod=node(ctx.createOscillator()),amount=node(ctx.createGain());mod.type='sine';mod.frequency.value=base*(s.fmRatio??2);const decay=s.fmDecay??.18,depth=base*s.fm;amount.gain.setValueAtTime(depth*Math.exp(-elapsed/decay),start);amount.gain.exponentialRampToValueAtTime(.0001,start+Math.max(.01,decay*8-elapsed));mod.connect(amount);amount.connect(osc.frequency);oscillators.push(mod);stops.push(mod.stop.bind(mod));}
   osc.frequency.value=base*(sub?.5:1);osc.detune.value=s.detune+(sub?0:position*(s.spread??0));
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

const waves=new WeakMap();
function coloredWave(ctx,type,color,phase){
 let cache=waves.get(ctx);if(!cache){cache=new Map();waves.set(ctx,cache);}const key=type+':'+color+':'+phase;if(cache.has(key))return cache.get(key);
 const real=new Float32Array(65),imag=new Float32Array(65);
 for(let h=1;h<=64;h++){
  const basic=type==='sine'?(h===1?1:0):type==='triangle'?(h%2?(-1)**((h-1)/2)/h**2:0):type==='square'?(h%2?1/h:0):(-1)**(h+1)/h;
  // A hollow, gently formant-weighted spectrum blended with the selected shape.
  const shaped=(h%2?1:.18)/h**1.45*(1+.7*Math.exp(-(((h-5)/2)**2)));
  const amp=basic*(1-color)+shaped*color,angle=phase*2*Math.PI*h;
  real[h]=amp*Math.sin(angle);imag[h]=amp*Math.cos(angle);
 }
 const wave=ctx.createPeriodicWave(real,imag);cache.set(key,wave);if(cache.size>64)cache.delete(cache.keys().next().value);return wave;
}
