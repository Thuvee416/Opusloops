import {observeProduction} from './production-observation.js';
import {emptyProject} from './model.js';
import {applyAgentActions} from './agent-actions.js';
const status=document.querySelector('[role=status]'),button=document.querySelector('button');
button.onclick=async()=>{button.disabled=true;status.textContent='Rendering synthetic mix…';try{
 let project=emptyProject();project=applyAgentActions(project,[{type:'add_track',args:{name:'Analysis Tone',preset:'Init',ref:'$tone'}},{type:'midi',args:{trackId:'$tone',name:'Test Note',ref:'$clip',beats:4,notes:[{pitch:69,start:0,duration:3,velocity:.3}]}},{type:'region',args:{trackId:'$tone',clipId:'$clip',start:0,length:4}}]);
 const before=JSON.stringify(project),signal=new AbortController().signal,base=await observeProduction(project,signal);
 const quiet=structuredClone(project);quiet.tracks[1].volume/=2;const lowered=await observeProduction(quiet,signal);
 if(base.status!=='measured'||base.rmsDB < -90)throw Error('No synthesized output measured.');
 const delta=lowered.rmsDB-base.rmsDB;if(Math.abs(delta+6.0206)>.1)throw Error('Fader change not reflected in rendered measurements: '+delta);
 const muted=structuredClone(project);muted.tracks[1].mute=true;const silent=await observeProduction(muted,signal);if(silent.rmsDB!==-120)throw Error('Muted track leaked into measurement.');
 const filtered=applyAgentActions(project,[{type:'device',args:{trackId:project.tracks[1].id,type:'utility',params:{gain:-6}}}]);const effected=await observeProduction(filtered,signal);if(effected.rmsDB>=base.rmsDB-4)throw Error('Device processing not reflected.');
 if(JSON.stringify(project)!==before)throw Error('Source project mutated.');
 const unavailable=await observeProduction(emptyProject(),signal);if(unavailable.status!=='unavailable')throw Error('Session substituted for Arrangement.');
 const cancel=new AbortController();cancel.abort();let aborted=false;try{await observeProduction(project,cancel.signal);}catch(e){aborted=e.name==='AbortError';}if(!aborted)throw Error('Cancellation ignored.');
 status.textContent='PASS — Real Browser Audio Checks\n'+JSON.stringify({baseRmsDB:base.rmsDB,faderDeltaDB:delta,deviceDeltaDB:effected.rmsDB-base.rmsDB,mutedRmsDB:silent.rmsDB,sourceUnchanged:true,noSessionSubstitution:true,cancelBeforeRender:true,range:base.range,coverage:base.coverage},null,2);
 }catch(error){status.textContent='FAIL — '+error.message;}finally{button.disabled=false;}};
