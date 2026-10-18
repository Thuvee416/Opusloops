import assert from 'node:assert/strict';
import {emptyProject} from '../../web-studio/model.js';
import {newSynth} from '../../web-studio/instruments.js';
import {deliveryOptions} from '../../web-studio/delivery-options.js';
export const prompt='Create a new track named Agent Live Proof using the Warm bass preset. Add a four-beat MIDI clip with pitches 36, 39, 41, 43, one beat per note at velocity 0.8. Place one four-beat Arrangement region at beat 0 on that new track. Export only that track as a 44.1 kHz, 24-bit PCM WAV, Arrangement range start 0 length 4, without normalization, dither or effect tails. Do not start playback or modify existing tracks.';
export function sourceProject(){const p=emptyProject();p.tracks[0].id='original-track';return p;}
export function compositionActions(){return [
 {type:'add_track',args:{name:'Agent Live Proof',preset:'Warm bass',ref:'$bass'}},
 {type:'midi',args:{trackId:'$bass',ref:'$riff',scene:0,beats:4,notes:[36,39,41,43].map((pitch,start)=>({pitch,start,duration:1,velocity:.8}))}},
 {type:'region',args:{trackId:'$bass',clipId:'$riff',start:0,length:4,offset:0}},
 {type:'command',args:{name:'export_wav',args:{channel:'track:$bass',source:'arrangement',sampleRate:44100,bitDepth:24,normalize:false,dither:'none',includeTail:false,range:{start:0,length:4}}}}
];}
export function assertComposition(source,compiled){
 const p=compiled.next;assert.equal(p.bpm,source.bpm);assert.equal(p.name,source.name);assert.equal(p.tracks.length,2);assert.deepEqual(p.tracks[0],source.tracks[0]);
 assert.deepEqual(p.transport,source.transport);assert.equal(p.master,source.master);assert.equal(p.scenes,source.scenes);
 const track=p.tracks[1];assert.equal(track.name,'Agent Live Proof');assert.deepEqual(track.instrument,newSynth('Warm bass'));
 assert.equal(Object.keys(p.clips).length,1);const clip=Object.values(p.clips)[0];assert.equal(clip.kind,'midi');assert.equal(clip.beats,4);assert.deepEqual(clip.notes,[36,39,41,43].map((pitch,start)=>({pitch,start,duration:1,velocity:.8})));assert.equal(track.slots[0],clip.id);
 assert.equal(p.arrangement.length,1);assert.deepEqual({...p.arrangement[0],id:undefined},{id:undefined,trackId:track.id,clipId:clip.id,start:0,length:4,offset:0});
 assert.equal(compiled.before.length,0);assert.equal(compiled.after.length,1);assert.equal(compiled.after[0].name,'export_wav');
 assert.deepEqual(deliveryOptions(p,compiled.after[0].args),{channel:'track:'+track.id,source:'arrangement',sampleRate:44100,bitDepth:24,normalize:false,dither:'none',includeTail:false,range:{start:0,length:4}});
}
