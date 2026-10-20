// Original browser-native processors. These do not load or emulate commercial plug-ins.
export const STUDIO_EFFECTS={
 parametric:{name:'Studio EQ',labels:{lowCut:'Low Cut',lowFrequency:'Low Frequency',lowGain:'Low Gain',midFrequency:'Mid Frequency',midGain:'Mid Gain',midQ:'Mid Q',highFrequency:'High Frequency',highGain:'High Gain',highCut:'High Cut'},params:{lowCut:[20,500,1,30,'Hz'],lowFrequency:[40,800,1,120,'Hz'],lowGain:[-18,18,.1,0,'dB'],midFrequency:[100,12000,1,1800,'Hz'],midGain:[-18,18,.1,0,'dB'],midQ:[.2,10,.1,.8,'Q'],highFrequency:[1500,18000,1,8000,'Hz'],highGain:[-18,18,.1,0,'dB'],highCut:[1000,20000,1,18000,'Hz']}},
 space:{name:'Studio Space',labels:{preDelay:'Pre-Delay',lowCut:'Low Cut',damping:'Damping',mix:'Dry/Wet'},automatable:['preDelay','lowCut','damping','mix'],params:{decay:[.3,5,.1,2.4,'s'],preDelay:[0,.15,.001,.023,'s'],lowCut:[20,1000,1,250,'Hz'],damping:[1000,18000,1,6800,'Hz'],mix:[0,1,.01,.18,'']}},
 echo:{name:'Studio Echo',labels:{time:'Delay Time',lowCut:'Low Cut',damping:'Damping',mix:'Dry/Wet'},params:{time:[.02,1,.001,.375,'s'],feedback:[0,.8,.01,.35,''],lowCut:[20,1000,1,180,'Hz'],damping:[500,16000,1,5500,'Hz'],mix:[0,1,.01,.2,'']}}
};
export function spaceImpulse(ctx,seconds){
 const size=Math.ceil(seconds*ctx.sampleRate),buffer=ctx.createBuffer(2,size,ctx.sampleRate);
 for(let channel=0;channel<2;channel++){
  const samples=buffer.getChannelData(channel);let seed=907+channel*419,low=0;
  for(let i=0;i<size;i++){
   seed=(Math.imul(seed,1664525)+1013904223)>>>0;
   const t=i/ctx.sampleRate,noise=seed/2147483648-1;
   // Increasing density, damped diffusion, decorrelated stereo and a -60 dB decay.
   low+=.28*(noise-low);
   samples[i]=low*Math.min(1,t/.035)*Math.exp(-6.908*t/seconds);
  }
  for(const [j,time] of [.011,.019,.031,.047,.071,.097].entries()){
   const at=Math.round((time+channel*.0017)*ctx.sampleRate);
   if(at<size)samples[at]+=(j%2?-.3:.4)*Math.exp(-j*.34);
  }
 }
 return buffer;
}
export function studioEffectGraph(ctx,node,entry,output,device,bind){
 const p=device.params,controls={};
 const parameter=(key,param)=>{param.value=p[key];bind(key,param);controls[key]=v=>param.setTargetAtTime(v,ctx.currentTime,.02);};
 const filter=(type,freq)=>{const f=node(ctx.createBiquadFilter());f.type=type;f.frequency.value=freq;f.Q.value=.707;return f;};
 if(device.type==='parametric'){
  let tail=entry;
  for(const [type,freq,gain,q] of [['highpass','lowCut'],['lowshelf','lowFrequency','lowGain'],['peaking','midFrequency','midGain','midQ'],['highshelf','highFrequency','highGain'],['lowpass','highCut']]){
   const f=filter(type,p[freq]);parameter(freq,f.frequency);if(gain)parameter(gain,f.gain);if(q)parameter(q,f.Q);tail.connect(f);tail=f;
  }
  tail.connect(output);return controls;
 }
 const dry=node(ctx.createGain()),wet=node(ctx.createGain());dry.gain.value=1-p.mix;wet.gain.value=p.mix;entry.connect(dry);dry.connect(output);wet.connect(output);
 bind('mix',dry.gain,v=>1-v);bind('mix',wet.gain);controls.mix=v=>{dry.gain.setTargetAtTime(1-v,ctx.currentTime,.02);wet.gain.setTargetAtTime(v,ctx.currentTime,.02);};
 const highpass=filter('highpass',p.lowCut),lowpass=filter('lowpass',p.damping);
 parameter('lowCut',highpass.frequency);parameter('damping',lowpass.frequency);
 if(device.type==='space'){
  const delay=node(ctx.createDelay(.2)),convolver=node(ctx.createConvolver());
  parameter('preDelay',delay.delayTime);convolver.buffer=spaceImpulse(ctx,p.decay);
  entry.connect(highpass);highpass.connect(delay);delay.connect(convolver);convolver.connect(lowpass);lowpass.connect(wet);
  controls.decay=v=>{convolver.buffer=spaceImpulse(ctx,v);};
 }else{
  const mono=node(ctx.createGain()),left=node(ctx.createDelay(1.1)),right=node(ctx.createDelay(1.1)),feedback=node(ctx.createGain()),merge=node(ctx.createChannelMerger(2));
  mono.channelCount=1;mono.channelCountMode='explicit';mono.channelInterpretation='speakers';
  parameter('time',left.delayTime);right.delayTime.value=p.time;bind('time',right.delayTime);
  controls.time=v=>{left.delayTime.setTargetAtTime(v,ctx.currentTime,.03);right.delayTime.setTargetAtTime(v,ctx.currentTime,.03);};
  parameter('feedback',feedback.gain);
  entry.connect(mono);mono.connect(highpass);highpass.connect(lowpass);lowpass.connect(left);
  left.connect(right);right.connect(feedback);feedback.connect(highpass);
  left.connect(merge,0,0);right.connect(merge,0,1);merge.connect(wet);
 }
 return controls;
}
