import {bassMonoGraph} from './bass-mono.js';
// Width is mid/side scaling: L'=aL+bR, R'=bL+aR.
// Neutral routing stays transparent, including the source channel count.
export function utilityGraph(ctx,node,entry,output,p,bind,spatialAutomated){
 const state={...p},center=node(ctx.createStereoPanner()),split=node(ctx.createChannelSplitter(2)),wide=node(ctx.createChannelMerger(2)),splitWide=node(ctx.createChannelSplitter(2)),merged=node(ctx.createChannelMerger(2));center.pan.value=0;center.connect(split);
 // Isolate a source channel before width processing. Explicit speaker upmix
 // makes a mono source available to either selector at its original amplitude.
 const selectUp=node(ctx.createGain()),selectSplit=node(ctx.createChannelSplitter(2)),selected=[node(ctx.createChannelMerger(2)),node(ctx.createChannelMerger(2))];selectUp.channelCount=2;selectUp.channelCountMode='explicit';entry.connect(selectUp);selectUp.connect(selectSplit);selected.forEach((m,i)=>{selectSplit.connect(m,i,0);selectSplit.connect(m,i,1);});
 let selectedInput=null;const select=v=>{if(selectedInput)selectedInput.disconnect(center);selectedInput=v?selected[v-1]:entry;selectedInput.connect(center);};select(p.channel);
 const widthNodes=[0,1,2,3].map(()=>node(ctx.createGain())),swapNodes=[0,1,2,3].map(()=>node(ctx.createGain())),phase=[node(ctx.createGain()),node(ctx.createGain())];
 for(let source=0;source<2;source++)for(let dest=0;dest<2;dest++){const i=source*2+dest,g=widthNodes[i],sw=swapNodes[i];split.connect(g,source);g.connect(wide,0,dest);splitWide.connect(sw,source);sw.connect(phase[dest]);const transform=v=>source===dest?(1+v/100)/2:(1-v/100)/2;g.gain.value=transform(p.width);bind('width',g.gain,transform,'linear',source===dest?v=>(2*v-1)*100:v=>(1-2*v)*100);sw.gain.value=source===dest?1-p.swap:p.swap;}
 // Independent Mid/Side path: -1 is mid only, 0 stereo, +1 side only.
 // Piecewise audio-rate coefficients preserve the center of automated ramps.
 const ms=node(ctx.createChannelMerger(2)),msControl=node(ctx.createConstantSource());msControl.offset.value=p.midSide;bind('midSide',msControl.offset);
 for(let source=0;source<2;source++)for(let dest=0;dest<2;dest++){const gain=node(ctx.createGain()),shape=node(ctx.createWaveShaper());shape.curve=new Float32Array(source===dest?[.5,1,.5]:[.5,0,-.5]);gain.gain.value=0;msControl.connect(shape);shape.connect(gain.gain);split.connect(gain,source);gain.connect(ms,0,dest);}msControl.start();
 const widthGate=node(ctx.createGain()),msGate=node(ctx.createGain());wide.connect(widthGate);ms.connect(msGate);widthGate.connect(splitWide);msGate.connect(splitWide);const selectStereo=()=>{const useMs=state.stereoMode&&!state.channel;msGate.gain.value=useMs?1:0;widthGate.gain.value=useMs?0:1;};selectStereo();
 phase.forEach((g,i)=>{g.gain.value=p[i?'invertR':'invertL']?-1:1;g.connect(merged,0,i);});
 output.gain.value=10**(p.gain/20);bind('gain',output.gain,v=>10**(v/20),'exponential',v=>20*Math.log10(v));
 // Dedicated mono follows polarity; balance attenuates, without crossfeed.
 const sum=node(ctx.createGain()),up=node(ctx.createGain()),direct=node(ctx.createGain()),mono=node(ctx.createGain()),post=node(ctx.createGain()),splitBalance=node(ctx.createChannelSplitter(2)),balanced=node(ctx.createChannelMerger(2)),balance=node(ctx.createConstantSource());
 sum.channelCount=1;sum.channelCountMode='explicit';up.channelCount=2;up.channelCountMode='explicit';merged.connect(sum);sum.connect(up);up.connect(mono);merged.connect(direct);mono.connect(post);direct.connect(post);direct.gain.value=1-p.mono;mono.gain.value=p.mono;const bass=bassMonoGraph(ctx,node,post,splitBalance,p,bind);
 balance.offset.value=p.balance;bind('balance',balance.offset);for(let i=0;i<2;i++){const shaper=node(ctx.createWaveShaper()),gain=node(ctx.createGain());shaper.curve=new Float32Array(i?[0,1,1]:[1,1,0]);gain.gain.value=0;balance.connect(shaper);shaper.connect(gain.gain);splitBalance.connect(gain,i);gain.connect(balanced,0,i);}balance.start();
 const dc=node(ctx.createBiquadFilter()),mute=node(ctx.createGain());dc.type='highpass';dc.frequency.value=5;dc.Q.value=-3.01029995664; // High-pass Q is specified in dB; this is a Butterworth response.
mute.gain.value=1-p.mute;mute.connect(output);
 let source=null,targetNode=null,dcActive=false;
 const route=(force=false)=>{const required=!!state.bassMono||!!state.channel||force||spatialAutomated()||(state.stereoMode?state.midSide!==0:state.width!==100)||!!state.swap||!!state.invertL||!!state.invertR||!!state.mono||state.balance!==0,next=required?balanced:entry,destination=state.dc?dc:mute;
 if(source===next&&targetNode===destination)return;if(source)source.disconnect(targetNode);if(dcActive&&!state.dc)dc.disconnect(mute);if(!dcActive&&state.dc)dc.connect(mute);dcActive=!!state.dc;next.connect(destination);source=next;targetNode=destination;};route();
 const target=(param,value)=>param.setTargetAtTime(value,ctx.currentTime,.015);
 return {activate:()=>route(true),controls:{bassMono:v=>{state.bassMono=v;bass.bassMono(v);route();},bassAudition:v=>{state.bassAudition=v;bass.bassAudition(v);},bassFrequency:bass.bassFrequency,stereoMode:v=>{state.stereoMode=v;selectStereo();route();},midSide:v=>{state.midSide=v;route();target(msControl.offset,v);},channel:v=>{state.channel=v;select(v);selectStereo();route();},balance:v=>{state.balance=v;route();target(balance.offset,v);},mono:v=>{state.mono=v;route();target(direct.gain,1-v);target(mono.gain,v);},mute:v=>{state.mute=v;target(mute.gain,1-v);},dc:v=>{state.dc=v;route();},gain:v=>target(output.gain,10**(v/20)),width:v=>{state.width=v;route();widthNodes.forEach((g,i)=>target(g.gain,i===0||i===3?(1+v/100)/2:(1-v/100)/2));},swap:v=>{state.swap=v;route();swapNodes.forEach((g,i)=>target(g.gain,i===0||i===3?1-v:v));},invertL:v=>{state.invertL=v;route();target(phase[0].gain,v?-1:1);},invertR:v=>{state.invertR=v;route();target(phase[1].gain,v?-1:1);}}};
}
