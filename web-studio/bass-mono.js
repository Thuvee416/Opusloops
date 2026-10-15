// Preserve M=(L+R)/2 while high-pass filtering S=(L-R)/2.
// This is an independent second-order Butterworth crossover, not a matched Live filter.
export function bassMonoGraph(ctx,node,input,output,p,bind){
 const split=node(ctx.createChannelSplitter(2)),mid=node(ctx.createGain()),side=node(ctx.createGain());input.connect(split);
 for(let c=0;c<2;c++){const m=node(ctx.createGain()),s=node(ctx.createGain());m.gain.value=.5;s.gain.value=c?-.5:.5;split.connect(m,c);split.connect(s,c);m.connect(mid);s.connect(side);}
 const high=node(ctx.createBiquadFilter()),low=node(ctx.createBiquadFilter());high.type='highpass';low.type='lowpass';for(const f of [high,low]){f.frequency.value=p.bassFrequency;f.Q.value=-3.01029995664;bind('bassFrequency',f.frequency);}side.connect(high);mid.connect(low);
 const stereo=node(ctx.createChannelMerger(2)),negative=node(ctx.createGain()),auditionStereo=node(ctx.createChannelMerger(2));negative.gain.value=-1;mid.connect(stereo,0,0);mid.connect(stereo,0,1);high.connect(stereo,0,0);high.connect(negative);negative.connect(stereo,0,1);low.connect(auditionStereo,0,0);low.connect(auditionStereo,0,1);
 const dry=node(ctx.createGain()),wet=node(ctx.createGain()),audition=node(ctx.createGain());input.connect(dry);stereo.connect(wet);auditionStereo.connect(audition);for(const g of [dry,wet,audition])g.connect(output);
 let enabled=p.bassMono,solo=p.bassAudition;const gates=()=>{dry.gain.value=enabled?0:1;wet.gain.value=enabled&&!solo?1:0;audition.gain.value=enabled&&solo?1:0;};gates();
 return {bassMono:v=>{enabled=v;gates();},bassAudition:v=>{solo=v;gates();},bassFrequency:v=>{for(const f of [high,low])f.frequency.setTargetAtTime(v,ctx.currentTime,.015);}};
}
