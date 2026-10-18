import {emptyProject,makeTrack} from '../../web-studio/model.js';
import {newReturn} from '../../web-studio/routing.js';
import {newSynth} from '../../web-studio/instruments.js';
export function selectionProject(){
 const p=emptyProject();p.name='Selection proof';const bass=p.tracks[0];bass.id='bass';bass.name='Bass';bass.instrument=newSynth('Warm bass');
 const pad=makeTrack('Pad',1);pad.id='pad';p.tracks.push(pad);p.returns=[{...newReturn('Room'),id:'room'}];
 p.clips.riff={id:'riff',kind:'midi',name:'Four-note bass',beats:4,sourceBpm:120,notes:[36,39,41,43].map((pitch,start)=>({pitch,start,duration:1,velocity:.8}))};
 p.clips.chord={id:'chord',kind:'midi',name:'Pad chord',beats:4,sourceBpm:120,notes:[60,64,67].map(pitch=>({pitch,start:0,duration:4,velocity:.5}))};
 bass.slots[0]='riff';bass.slots[1]='riff';pad.slots[0]='chord';
 p.arrangement=[{id:'bass-a',trackId:'bass',clipId:'riff',start:0,length:4,offset:0},{id:'bass-b',trackId:'bass',clipId:'riff',start:128,length:4,offset:0},{id:'pad-a',trackId:'pad',clipId:'chord',start:0,length:4,offset:0}];
 return p;
}
export const compositionSelection=[{type:'add_track',args:{name:'New lead',preset:'Bright pluck',ref:'$lead'}},{type:'midi',args:{trackId:'$lead',ref:'$notes',scene:0,beats:4,notes:[{pitch:72,start:0,duration:1,velocity:.6}]}},{type:'region',args:{trackId:'$lead',clipId:'$notes',ref:'$part',start:32,length:4,offset:0}},{type:'command',args:{name:'select',args:{target:'regions',ids:['$part'],primaryId:'$part'}}}];
