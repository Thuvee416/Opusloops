// Bounded, deterministic observations of rendered float PCM. These are not LUFS,
// true-peak metering, semantic listening or a professional-quality score.
const db=x=>x>0?20*Math.log10(x):-120;
export function measureProductionPCM(channels,sampleRate){
 if(!Array.isArray(channels)||!channels.length||channels.length>2||!Number.isFinite(sampleRate)||sampleRate<8000||channels.some(a=>!a.length||a.length!==channels[0].length))throw Error('Invalid analysis PCM.');
 const frames=channels[0].length;if(frames/sampleRate>61)throw Error('Analysis excerpt exceeds sixty seconds.');
 let peak=0,sum=0,clipped=0,lr=0,ll=0,rr=0,mid=0,side=0;const windows=[];const hop=Math.max(1,Math.round(sampleRate*.4));
 // One-pole crossover estimates; label explicitly, never present as FFT or EQ targets.
 const cuts=[120,500,2000,8000],alpha=cuts.map(f=>1-Math.exp(-2*Math.PI*f/sampleRate)),states=channels.map(()=>[0,0,0,0]),energy=[0,0,0,0,0];
 for(let start=0;start<frames;start+=hop){let windowSum=0,n=0;
  for(let i=start;i<Math.min(frames,start+hop);i++){
   const l=channels[0][i],r=channels[1]?.[i]??l;lr+=l*r;ll+=l*l;rr+=r*r;mid+=((l+r)/2)**2;side+=((l-r)/2)**2;
   for(let c=0;c<channels.length;c++){const v=channels[c][i];if(!Number.isFinite(v))throw Error('Non-finite rendered audio.');peak=Math.max(peak,Math.abs(v));sum+=v*v;windowSum+=v*v;n++;if(Math.abs(v)>=1)clipped++;
    let previous=0;for(let k=0;k<4;k++){states[c][k]+=alpha[k]*(v-states[c][k]);energy[k]+=(states[c][k]-previous)**2;previous=states[c][k];}energy[4]+=(v-previous)**2;
   }
  }windows.push({seconds:Number((start/sampleRate).toFixed(3)),rmsDB:db(Math.sqrt(windowSum/n))});
 }
 const count=frames*channels.length,rms=Math.sqrt(sum/count),total=energy.reduce((a,b)=>a+b,0);
 return {seconds:frames/sampleRate,sampleRate,channels:channels.length,samplePeakDB:db(peak),rmsDB:db(rms),crestDB:rms?db(peak/rms):null,clippedSamples:clipped,stereoCorrelation:ll&&rr?Math.max(-1,Math.min(1,lr/Math.sqrt(ll*rr))):null,sideEnergyRatio:mid+side?side/(mid+side):0,bandEnergyFractions:energy.map(v=>total?v/total:0),bandMethod:'Approximate one-pole differences at 120/500/2000/8000 Hz; not an additive spectrum or automatic EQ prescription',windows,limits:['Not LUFS or true peak','Not a listening or quality assessment']};
}
export function readRenderedFloatWave(bytes){const v=new DataView(bytes);if(bytes.byteLength<44||v.getUint16(20,true)!==3||v.getUint16(34,true)!==32||v.getUint32(40,true)+44!==bytes.byteLength)throw Error('Expected internal float WAV.');const count=v.getUint16(22,true),frames=v.getUint32(40,true)/(count*4);if(![1,2].includes(count)||!Number.isSafeInteger(frames))throw Error('Invalid rendered channels.');return {sampleRate:v.getUint32(24,true),channels:Array.from({length:count},(_,c)=>Float32Array.from({length:frames},(_,i)=>v.getFloat32(44+(i*count+c)*4,true)))};}
export function analysisRange(project){const regions=(project.arrangement||[]).filter(r=>r.active!==false);if(!regions.length)return null;const end=Math.max(...regions.map(r=>r.start+r.length));return {start:0,length:Math.min(end,32,60*project.bpm/60)};}
