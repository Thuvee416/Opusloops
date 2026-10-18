import {regionFadesProject} from './region-fades-project.mjs';
import {encodeWave} from '../../web-studio/wav-export.js';
export function regionCrossfadeProject(){
 const p=regionFadesProject();p.name='Crossfade proof';const rate=44100,length=rate*2,samples=Float32Array.from({length},(_,i)=>.15*Math.cos(2*Math.PI*997.3*i/rate)),wave=new Uint8Array(encodeWave({sampleRate:rate,numberOfChannels:1,length,getChannelData:()=>samples},{bitDepth:32}));let binary='';for(const n of wave)binary+=String.fromCharCode(n);
 p.clips.high={...p.clips.source,id:'high',name:'High loop',data:btoa(binary)};
 p.arrangement=[{id:'outgoing',trackId:'lead',clipId:'source',start:1,length:3,offset:0},{id:'incoming',trackId:'lead',clipId:'high',start:4,length:3,offset:1},{id:'untouched',trackId:'other',clipId:'source',start:1,length:7,offset:.5}];return p;
}
