import {isNoteActive} from './note-state.js';
export function synthesize(context,clip,bpm){
  const sr=context.sampleRate,spb=60/bpm,len=Math.ceil(clip.beats*spb*sr),buffer=context.createBuffer(1,len,sr),out=buffer.getChannelData(0);
  let seed=237;const noise=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2147483648-1;};
  if(clip.kind==='drums'){
    for(let step=0;step<clip.beats*4;step++){
      const start=Math.round(step*.25*spb*sr);
      if(clip.pattern!=='hats'&&step%4===0&&(clip.pattern!=='sparse'||step%8===0))for(let i=0;i<sr*.32&&start+i<len;i++){const t=i/sr;out[start+i]+=Math.sin(2*Math.PI*(48*t+4*(1-Math.exp(-t*30))))*Math.exp(-t*15)*.65;}
      if(clip.pattern==='full'&&step%8===4)for(let i=0;i<sr*.15&&start+i<len;i++){const t=i/sr;out[start+i]+=(noise()*.5+Math.sin(2*Math.PI*180*t)*.25)*Math.exp(-t*28);}
      if(step%2===0)for(let i=0;i<sr*.035&&start+i<len;i++)out[start+i]+=noise()*.12*Math.exp(-i/sr*100);
    }
  } else for(const n of clip.notes){
    if(!isNoteActive(n))continue;
    const start=Math.round(n.start*spb*sr),duration=n.duration*spb,freq=440*2**((n.pitch-69)/12);
    for(let i=0;i<(duration+.08)*sr&&start+i<len;i++){const t=i/sr,envelope=Math.min(1,t/.008)*Math.max(0,Math.min(1,(duration+.08-t)/.09));out[start+i]+=(Math.sin(2*Math.PI*freq*t)+Math.sin(2*Math.PI*freq*2*t)*.18)*envelope*n.velocity*.23;}
  }
  return buffer;
}
