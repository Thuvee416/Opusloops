import {synthesize} from './legacy-synth.js';
self.onmessage=({data:{jobs,sampleRate}})=>{
 try{
  const context={sampleRate,createBuffer(_channels,length){const pcm=new Float32Array(length);return {getChannelData:()=>pcm};}},results=jobs.map(job=>({key:job.key,pcm:synthesize(context,job.clip,job.bpm).getChannelData(0)}));
  self.postMessage({results},results.map(r=>r.pcm.buffer));
 }catch(error){self.postMessage({error:error.message});}
};
