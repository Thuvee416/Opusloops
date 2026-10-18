import {emptyProject,makeTrack,validateProject} from '../../web-studio/model.js';
import {newDevice} from '../../web-studio/devices.js';
import {encodeWave} from '../../web-studio/wav-export.js';
export const ROUTING_RATE=44100,ROUTING_FRAMES=88200;
export const routingTones={a:{hz:110,amplitude:.001},b:{hz:220,amplitude:.0012},bus:{hz:440,amplitude:.0008},main:{hz:880,amplitude:.0006},other:{hz:1760,amplitude:.0005}};
export function routingProject(routed=true){
 const p=emptyProject();p.name='Routing proof';p.master=.8;p.tracks=[];
 for(const [index,id]of ['a','b','bus','main','other'].entries()){
  const names={a:'Source A',b:'Source B',bus:'Bus',main:'Mix Bus',other:'Other'},volume={a:.5,b:.4,bus:.7,main:.6,other:.3},t={...makeTrack(names[id],index),id,volume:volume[id],devices:[]};
  if(routed&&['a','b'].includes(id))t.output='track:bus';if(routed&&id==='bus')t.output='track:main';
  if(['bus','main'].includes(id)){const d=newDevice('utility');d.id=id+'-utility';d.params.gain=id==='bus'?-6:-3;t.devices=[d];}
  const {hz,amplitude}=routingTones[id],samples=Float32Array.from({length:ROUTING_FRAMES},(_,frame)=>amplitude*Math.sin(2*Math.PI*hz*frame/ROUTING_RATE)),data=encodeWave({sampleRate:ROUTING_RATE,numberOfChannels:2,length:samples.length,getChannelData:()=>samples},{bitDepth:32});
  let binary='';for(const byte of new Uint8Array(data))binary+=String.fromCharCode(byte);
  const clip={id:'clip-'+id,kind:'audio',name:names[id]+' tone',sourceBpm:120,beats:4,data:btoa(binary)};p.clips[clip.id]=clip;t.slots[0]=clip.id;p.arrangement.push({id:'region-'+id,trackId:id,clipId:clip.id,start:0,length:4,offset:0});p.tracks.push(t);
 }return validateProject(p);
}
