import {emptyProject,makeTrack} from '../../web-studio/model.js';
import {encodeWave} from '../../web-studio/wav-export.js';
export function regionFadesProject(){
 const p=emptyProject();p.name='Region fade proof';p.bpm=120;
 const track=p.tracks[0];track.id='lead';track.name='Lead';track.volume=.7;const other=makeTrack('Unselected');other.id='other';p.tracks.push(other);
 const rate=44100,beats=4,length=rate*2,samples=Float32Array.from({length},(_,i)=>.2*Math.sin(2*Math.PI*193.7*i/rate));
 const wave=encodeWave({sampleRate:rate,numberOfChannels:1,length,getChannelData:()=>samples},{bitDepth:32});
 // Both browser and Node can construct the same fixture without assuming Buffer.
 let binary='';for(const n of new Uint8Array(wave))binary+=String.fromCharCode(n);
 p.clips.source={id:'source',kind:'audio',name:'Loop',beats,sourceBpm:120,data:btoa(binary)};track.slots[0]='source';other.slots[0]='source';
 p.arrangement=[{id:'audio-a',trackId:'lead',clipId:'source',start:1,length:8,offset:.5},{id:'audio-b',trackId:'other',clipId:'source',start:1,length:8,offset:.5}];return p;
}
