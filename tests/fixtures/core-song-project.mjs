// Reproducible model/render study. This is not evidence of manual or recorded performance.
import {coreSongMedia} from './core-song-media.mjs';
import {emptyProject,validateProject} from '../../web-studio/model.js';
import {inspectMidi,importMidiProject} from '../../web-studio/midi-file.js';
import {prepareAgentPlan} from '../../web-studio/agent-runner.js';
import {newSynth} from '../../web-studio/instruments.js';
export const songSections=[{name:'Intro',start:0,length:16},{name:'First Theme',start:16,length:32},{name:'Break',start:48,length:16},{name:'Return',start:64,length:48},{name:'Outro',start:112,length:16}];
export function coreSongProject(){
 const media=coreSongMedia();let p=emptyProject();p.tracks[0].id='drums';p.tracks[0].name='Drums';p.clips.drums={id:'drums',name:'Original Drum Loop',kind:'audio',sourceBpm:120,beats:16,data:media.drums.toString('base64')};p.tracks[0].slots[0]='drums';
 for(const [bytes,id,name,preset,volume]of [[media.bass,'bass','Bass','Warm bass',.52],[media.keys,'keys','Keys','Soft pad',.34]]){p=importMidiProject(p,inspectMidi(bytes));const t=p.tracks.at(-1),old=t.slots[0],clip=p.clips[old];t.id=id;t.name=name;t.instrument=newSynth(preset);t.volume=volume;clip.id=id;clip.name=name+' Phrase';delete p.clips[old];p.clips[id]=clip;t.slots[0]=id;}
 p.name='Night Tide Core Study';p.master=.7;p.locators=songSections.map((s,i)=>({id:'section-'+i,name:s.name,beat:s.start}));
 const actions=[{type:'add_return',args:{name:'Room',volume:.28,ref:'$room'}},{type:'send',args:{trackId:'keys',returnId:'$room',amount:.18,pre:false}},{type:'add_track',args:{name:'Guide Melody',preset:'Bright pluck',ref:'$guide'}},{type:'track',args:{id:'$guide',changes:{volume:.28,pan:.15}}},{type:'midi',args:{trackId:'$guide',ref:'$motif',scene:0,beats:16,notes:[0,2,3,6,8,10,12,14].map((start,i)=>({pitch:[69,72,76,74,72,69,67,69][i],start,duration:.6,velocity:.58}))}},{type:'device',args:{trackId:'keys',type:'chorus',params:{mix:.18}}},{type:'device',args:{trackId:'$guide',type:'delay',params:{time:.25,feedback:.2,mix:.12}}}];
 const positions={drums:[0,16,32,64,80,96,112],bass:[16,32,64,80,96,112],keys:[0,16,32,48,64,80,96,112],$guide:[32,64,80,96]};
 for(const [id,starts]of Object.entries(positions))for(const start of starts)actions.push({type:'region',args:{trackId:id,clipId:id==='$guide'?'$motif':id,start,length:16,offset:0}});
 actions.push({type:'automation',args:{trackId:'keys',key:'volume',action:'replace',points:[{beat:0,value:.12,curve:'linear'},{beat:16,value:.34,curve:'step'},{beat:48,value:.22,curve:'linear'},{beat:64,value:.4,curve:'step'},{beat:112,value:.34,curve:'linear'},{beat:128,value:0,curve:'linear'}]}});
 const plan=prepareAgentPlan(p,actions),project=plan.next,guide=project.tracks.at(-1),generatedId=guide.id;guide.id='guide';for(const r of project.arrangement)if(r.trackId===generatedId)r.trackId='guide';
 validateProject(project);return {project,imported:p,media,actions,sections:songSections};
}
