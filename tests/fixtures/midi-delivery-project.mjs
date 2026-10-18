import {emptyProject,makeTrack} from '../../web-studio/model.js';
import {newPitch,newChord} from '../../web-studio/midi-effects.js';
export function midiDeliveryProject(){
 const p=emptyProject();p.name='MIDI delivery proof';p.bpm=123;
 const lead=p.tracks[0];lead.id='lead';lead.name='Lead';lead.mute=true;
 const bass=makeTrack('Bass',1);bass.id='bass';p.tracks.push(bass);
 lead.midiEffects=[{...newPitch('transpose'),semitones:12},{...newChord('harmony'),shifts:[7,0,0,0,0,0]}];
 for(const [id,t,channel,pitch]of [['riff',lead,2,60],['low',bass,9,36]]){
  p.clips[id]={id,kind:'midi',name:t.name+' phrase',beats:4,sourceBpm:123,midiChannel:channel,notes:[{pitch,start:0,duration:1,velocity:96/127,releaseVelocity:31/127},{pitch:pitch+2,start:1.5,duration:.25,velocity:.5},{pitch:pitch+4,start:3.5,duration:2,velocity:1},{pitch:80,start:2,duration:.5,velocity:1,active:false},{pitch:81,start:2.5,duration:.25,velocity:0}]};t.slots[0]=id;
  p.arrangement.push({id:'arr-'+id,trackId:t.id,clipId:id,start:0,length:12,offset:id==='riff'?.5:0});
 }
 p.locators=[{id:'intro',name:'Intro',beat:0},{id:'drop',name:'Drop',beat:4}];return p;
}
