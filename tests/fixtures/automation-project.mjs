import {emptyProject} from '../../web-studio/model.js';
import {newDevice} from '../../web-studio/devices.js';
import {newReturn} from '../../web-studio/routing.js';
import {encodeWave} from '../../web-studio/wav-export.js';
export function automationProject(){
 const p=emptyProject(),t=p.tracks[0];p.name='Automation Proof';t.id='lead';t.name='Lead';t.volume=.5;
 const d=newDevice('utility');d.id='gain';t.devices=[d];const r=newReturn('Echo');r.id='echo';r.volume=.8;r.devices=[newDevice('delay')];r.devices[0].id='echo-delay';Object.assign(r.devices[0].params,{time:.125,feedback:0,mix:1});p.returns=[r];t.sends={echo:{amount:0,pre:false}};
 const samples=Float32Array.from({length:48000*4},(_,i)=>.03*Math.sin(2*Math.PI*317*i/48000));
 const wave=encodeWave({sampleRate:48000,numberOfChannels:2,length:samples.length,getChannelData:()=>samples},{bitDepth:32});let binary='';for(const byte of new Uint8Array(wave))binary+=String.fromCharCode(byte);
 p.clips.tone={id:'tone',kind:'audio',name:'Test Tone',beats:8,sourceBpm:120,data:btoa(binary)};t.slots[0]='tone';p.arrangement=[{id:'tone-region',trackId:'lead',clipId:'tone',start:0,length:8,offset:0}];return p;
}
