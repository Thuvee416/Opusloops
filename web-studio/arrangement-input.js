import {uid,validateProject} from './model.js';
import {isGroup} from './track-hierarchy.js';

export function arrangementInputDestination(project,trackId,start){
 const track=project.tracks.find(t=>t.id===trackId);
 if(!track||isGroup(track))throw Error('Choose An Audio Or MIDI Track For Arrangement Recording.');
 if(!Number.isFinite(start)||start<0||start>16383.75)throw Error('Choose A Recording Start Within The Arrangement.');
 if(Object.keys(project.clips).length>=512||project.arrangement.length>=10000)throw Error('The Project Has Reached Its Clip Or Region Limit.');
 const regions=project.arrangement.filter(r=>r.trackId===trackId);
 if(regions.some(r=>r.start<=start&&r.start+r.length>start+1e-7))throw Error('The Recording Start Is Occupied. Choose Empty Time Or Another Track.');
 const next=Math.min(16384,...regions.filter(r=>r.start>start).map(r=>r.start));
 const maxBeats=Math.min(256,300*project.bpm/60,next-start);
 if(maxBeats<.25)throw Error('Leave At Least A Quarter Beat Of Empty Time For A Take.');
 return {trackId,start,maxBeats};
}
export function appendArrangementTake(project,clip,destination,regionId=uid()){
 const current=arrangementInputDestination(project,destination.trackId,destination.start);
 if(!Number.isFinite(destination.maxBeats)||destination.maxBeats!==current.maxBeats)throw Error('The Recording Destination Changed. The Existing Arrangement Was Preserved.');
 if(!clip||!['audio','midi'].includes(clip.kind)||typeof clip.id!=='string'||Object.hasOwn(project.clips,clip.id))throw Error('A Take Must Create A New Audio Or MIDI Source.');
 const region={id:regionId,trackId:current.trackId,clipId:clip.id,start:current.start,length:Math.min(clip.beats,current.maxBeats),offset:0};
 const next=structuredClone(project);next.clips[clip.id]=structuredClone(clip);next.arrangement.push(region);validateProject(next);
 return {project:next,regionId:region.id,start:region.start,length:region.length,clipId:clip.id};
}

export async function beginArrangementInput(engine,destination,{countInBars=0,signal}={}){
 if(engine.playing||engine.startPromise||engine.recording||engine.automationTake||engine.inputArrangement)throw Error('Stop Playback Before Starting An Arrangement Take.');
 if(![0,1,2,4].includes(countInBars))throw Error('Choose A Supported Count-In.');
 arrangementInputDestination(engine.project,destination.trackId,destination.start);signal?.throwIfAborted();
 const stage={...destination,before:{mode:engine.mode,position:engine.position,overrides:new Set(engine.overrides)}};engine.inputArrangement=stage;
 try{
  engine.position=destination.start;engine.overrides.clear();
  await engine.play('arrangement',{delayBeats:countInBars*4});signal?.throwIfAborted();
  if(!engine.playing||engine.inputArrangement!==stage)throw Error('Arrangement Recording Startup Was Cancelled.');
  const spb=60/engine.project.bpm,start=engine.origin+destination.start*spb;
  if(engine.context.currentTime>=start)throw Error('Audio Preparation Took Too Long. Start The Take Again.');
  stage.startTime=start;
  return {start,clicks:Array.from({length:countInBars*4},(_,i)=>({time:start-(countInBars*4-i)*spb,accent:i%4===0}))};
 }catch(error){endArrangementInput(engine,{cancel:true});throw error;}
}
export function endArrangementInput(engine,{cancel=false}={}){
 const stage=engine.inputArrangement;if(!stage)return;
 // Pause while the linear clock is still active, then restore saved loop semantics.
 if(engine.playing||engine.startPromise)engine.pause();engine.inputArrangement=null;
 if(cancel){engine.mode=stage.before.mode;engine.position=stage.before.position;engine.overrides=new Set(stage.before.overrides);}
}
