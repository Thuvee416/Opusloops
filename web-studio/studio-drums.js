// Original synthesized percussion: no recordings or third-party sample content.
export function studioDrumBuffer(ctx,pad){
 const sr=ctx.sampleRate,length=Math.ceil(pad.decay*sr),buffer=ctx.createBuffer(1,length,sr),out=buffer.getChannelData(0);
 let seed=731,low=0,bodyNoise=0;
 const alpha=1-Math.exp(-2*Math.PI*6500/sr),bodyAlpha=1-Math.exp(-2*Math.PI*1600/sr);
 for(let i=0;i<length;i++){
  const t=i/sr,tail=Math.min(1,(length-i)/(sr*.008)),rise=Math.min(1,t/.0007);
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2147483648-1;
  low+=alpha*(noise-low);bodyNoise+=bodyAlpha*(noise-bodyNoise);
  const bright=noise-low,band=low-bodyNoise;let v=0;
  if(pad.source==='kick'){
   const phase=2*Math.PI*(49*t+2.5*(1-Math.exp(-t/.022)));
   v=Math.sin(phase)*Math.exp(-t/(pad.decay*.24))+.12*Math.sin(2*phase)*Math.exp(-t/.055)+band*.16*Math.exp(-t/.009);
   v=Math.tanh(v*1.35)*.8;
  }else if(pad.source==='clap'){
   let env=0;for(const at of [0,.009,.018,.029])if(t>=at)env+=Math.exp(-(t-at)/.009);
   env+=.55*Math.exp(-t/(pad.decay*.28));
   v=band*env*.8+bright*.12*Math.exp(-t/.045);
  }else if(pad.source==='snare'){
   v=(Math.sin(2*Math.PI*184*t)*.5+Math.sin(2*Math.PI*331*t)*.2)*Math.exp(-t/.045)+band*.95*Math.exp(-t/(pad.decay*.24));
  }else if(pad.source==='hat'||pad.source==='metal'){
   let metal=0;for(const f of [3181,4147,5371,6197,7489,9029])if(f<sr*.45)metal+=Math.sin(2*Math.PI*f*t)/6;
   v=(bright*.65+metal*.28)*Math.exp(-t/(pad.decay*.3));
  }else if(pad.source==='tom'){
   v=(Math.sin(2*Math.PI*(112*t+1.6*(1-Math.exp(-t/.025))))+.14*Math.sin(2*Math.PI*227*t))*Math.exp(-t/(pad.decay*.3))+band*.04*Math.exp(-t/.01);
  }else if(pad.source==='rim'){
   v=(Math.sin(2*Math.PI*780*t)*.55+Math.sin(2*Math.PI*1731*t)*.25+band*.2)*Math.exp(-t/(pad.decay*.14));
  }else if(pad.source==='bell'){
   v=(Math.sin(2*Math.PI*540*t)*.55+Math.sin(2*Math.PI*829*t)*.3+Math.sin(2*Math.PI*1673*t)*.12)*Math.exp(-t/(pad.decay*.3));
  }
  out[i]=(pad.source==='kick'?v:.95*Math.tanh(v/.95))*tail*rise;
 }
 return buffer;
}
