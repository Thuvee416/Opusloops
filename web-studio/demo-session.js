import {emptyProject,makeTrack,uid,validateProject} from './model.js';
import {factorySound} from './factory-sounds.js';
import {newDevice} from './devices.js';
export const DEMO_TITLE='Midnight Circuit',DEMO_BPM=104,DEMO_BEATS=32;
// Original editable composition. The reference recording is not embedded or sampled.
export function createDemoSession(){
 const p=emptyProject();p.name=DEMO_TITLE;p.bpm=DEMO_BPM;p.master=.88;p.sceneNames=['Pulse','Bloom','Lift','Turnaround'];
 p.transport={...p.transport,loopEnabled:true,loopStart:0,loopEnd:DEMO_BEATS};
 const names=['Club Kick','Room Clap','Silk Hats','Night Percussion','Round Sub','Analog Bass','Velvet Ensemble','Glass Pluck','Prismatic Arp','Air Pad'];
 const levels=[.82,.62,.42,.4,.65,.52,.61,.62,.32,.45];
 p.tracks=names.map((name,i)=>{const sound=factorySound(name);return {...makeTrack(name,i),volume:levels[i],instrument:sound.instrument,devices:sound.devices};});
 p.locators=p.sceneNames.map((name,i)=>({id:uid(),name,beat:i*8}));
 const roots=[43,39,46,41],chords=[[58,62,65,69],[55,58,62,65],[53,58,60,65],[57,60,65,67]];
 const add=(track,scene,notes)=>{const id=uid();p.clips[id]={id,name:p.sceneNames[scene]+' · '+names[track],kind:'midi',beats:8,sourceBpm:p.bpm,notes:notes.sort((a,b)=>a.start-b.start||a.pitch-b.pitch)};p.tracks[track].slots[scene]=id;p.arrangement.push({id:uid(),trackId:p.tracks[track].id,clipId:id,start:scene*8,length:8,offset:0});};
 const note=(pitch,start,duration,velocity)=>({pitch,start,duration,velocity});
 for(let scene=0;scene<4;scene++){
  const kick=[],clap=[],hats=[],perc=[],sub=[],bass=[],keys=[],lead=[],arp=[],pad=[];const root=roots[scene];
  for(let b=0;b<8;b++){
   if(!(scene===3&&b===7))kick.push(note(36,b,.125,b%4===0?.97:.89));
   if(b%2)clap.push(note(39,b+.012,.15,.78),note(38,b+.018,.15,.3));
   hats.push(note(42,b+.015,.08,.36),note(46,b+.5,.15,.68));
   if(scene!==0||b>=4)hats.push(note(50,b+.27,.1,.26),note(50,b+.78,.1,.32));
   if(b%2===0)perc.push(note(37,b+.75,.1,.5));
   if(b%4===3)perc.push(note(41,b+.25,.14,.55),note(43,b+.65,.14,.34));
   // Short low notes leave room for the kick transient; syncopation carries the groove.
   sub.push(note(root-12,b+.23,.55,b%2?.7:.79));
   bass.push(note(root,b+.28,.23,.75),note(root+(b%4===3?7:0),b+.72,.18,.55));
   if(scene===2&&b%2===0)bass.push(note(root+12,b+.52,.12,.38));
  }
  for(const [at,vel] of [[.35,.6],[2.75,.45],[4.35,.56],[6.5,.44]])for(const pitch of chords[scene])keys.push(note(pitch,at,.7,vel));
  const motifs=[[74,77,72,70,69],[74,77,79,74,70],[77,81,79,77,74],[72,76,77,74,69]];
  const times=[.5,1.25,2.5,4.5,6.25];for(let i=0;i<times.length;i++)lead.push(note(motifs[scene][i],times[i],i===3?.55:.32,[.78,.6,.72,.82,.6][i]));
  if(scene===1||scene===3){lead.push(note(motifs[scene][4]+12,7.25,.15,.32),note(motifs[scene][4],7.65,.14,.45));}
  const order=[0,2,1,3,2,1,3,2];for(let step=0;step<16;step++){if(scene===0&&step<8)continue;arp.push(note(chords[scene][order[step%8]]+12,step*.5+.27,.14,step%4===0?.5:.32));}
  for(const pitch of chords[scene].slice(0,3))pad.push(note(pitch,0,7.65,.55));
  if(scene===3){for(const [i,at] of [7,7.25,7.5,7.75].entries())clap.push(note(38,at,.12,.3+i*.1));hats.push(note(42,7.875,.06,.4));}
  [kick,clap,hats,perc,sub,bass,keys,lead,arp,pad].forEach((notes,i)=>add(i,scene,notes));
 }
 // Editable gain envelopes provide kick space and section movement in Arrangement.
 for(const i of [4,5,6,9]){const t=p.tracks[i],points=[];for(let beat=0;beat<32;beat++){
  const depth=i===4?.35:i===5?.45:.6;points.push({beat,value:t.volume*depth,curve:'linear'},{beat:beat+.2,value:t.volume,curve:'linear'},{beat:beat+.94,value:t.volume,curve:'linear'});
 }points.push({beat:32,value:t.volume*(i===4?.35:i===5?.45:.6),curve:'linear'});t.automation={volume:{enabled:true,points}};}
 const filter=newDevice('filter');filter.params.frequency=6200;filter.automation={frequency:{enabled:true,points:[{beat:0,value:2500,curve:'linear'},{beat:8,value:4500,curve:'linear'},{beat:16,value:7200,curve:'linear'},{beat:24,value:5300,curve:'linear'},{beat:30,value:8000,curve:'linear'},{beat:32,value:2500,curve:'linear'}]}};p.tracks[7].devices.push(filter);
 return validateProject(p);
}
