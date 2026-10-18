import {emptyProject,makeTrack} from '../../web-studio/model.js';
import {newReturn} from '../../web-studio/routing.js';
import {newDevice} from '../../web-studio/devices.js';
import {encodeWave} from '../../web-studio/wav-export.js';
export function deliveryProject(){
 const p=emptyProject();p.name='Agent delivery proof';p.bpm=120;p.master=.65;
 const lead=p.tracks[0],pad=makeTrack('Muted pad');lead.id='lead';lead.name='Lead';lead.volume=.5;pad.id='pad';pad.mute=true;p.tracks.push(pad);
 const room={...newReturn('Room'),id:'room',devices:[newDevice('delay')]};room.devices[0].params.mix=1;p.returns=[room];lead.sends={room:{amount:.4,pre:false}};
 for(const [id,hz,track]of [['low',220,lead],['high',880,pad]]){
  const samples=Float32Array.from({length:44100},(_,i)=>.3*Math.sin(2*Math.PI*hz*i/44100));
  const wave=encodeWave({sampleRate:44100,numberOfChannels:2,length:samples.length,getChannelData:()=>samples},{bitDepth:32});
  p.clips[id]={id,kind:'audio',name:id,beats:2,sourceBpm:120,data:Buffer.from(wave).toString('base64')};track.slots[0]=id;
  p.arrangement.push({id:'arr-'+id,trackId:track.id,clipId:id,start:0,length:16,offset:id==='low'?.5:0});
 }
 return p;
}
